import { QUOTA_STALE_MS, isPresetModel, type HelperDifficulty, type QuotaView } from '../../shared/helper-routing';
import {
  HELPER_FORECAST_BASELINE_UNAVAILABLE_REASONS, HELPER_FORECAST_UNAVAILABLE_REASONS, HELPER_TELEMETRY_LIMITS,
  type DecisionQuota, type HelperCalibrationIdentity, type HelperTaskProfile,
} from '../../shared/telemetry/helper-usage-contract';

export const AUTO_FORECAST_MIN_SAMPLES = 5;
export const AUTO_FORECAST_MIN_EFFECTIVE_SAMPLES = 3;
export const AUTO_FORECAST_HALF_LIFE_MS = 7 * 24 * 60 * 60_000;
export const AUTO_FORECAST_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const AUTO_FORECAST_MAX_SAMPLES = 32;
export const AUTO_FORECAST_EMPIRICAL_COVERAGE_BP = 8000;

export interface BurnEstimate {
  samples: number;
  /** Recency-weighted effective sample size, not evidence of live calibration. */
  effectiveSamples?: number;
  unavailableReason?: (typeof HELPER_FORECAST_UNAVAILABLE_REASONS)[number];
  /** Absent is unknown, including cold starts. Basis points of this provider's own window. */
  expectedBp?: number;
  /** Cohort quantiles, not a calibrated prediction or confidence interval. */
  interval?: { method: 'weighted_empirical'; nominalCoverageBp: 8000; lowerBp: number; upperBp: number };
}

export interface BurnForecast {
  version: 1;
  atMs: number;
  /** Exact mapped identities only. No cross-model, effort, revision or profile transfer. */
  key: string | null;
  basis: 'subscription_interval';
  weekly: BurnEstimate;
  fiveHour: BurnEstimate;
  baselineUnavailableReason?: (typeof HELPER_FORECAST_BASELINE_UNAVAILABLE_REASONS)[number];
  baseline?: {
    asOfMs: number;
    weekly?: { usedBp: number; resetsAtMs: number };
    fiveHour?: { usedBp: number; resetsAtMs: number };
  };
}

export interface ForecastRun {
  runId?: string;
  startedMs: number;
  endedMs?: number;
  usageSamples: number;
  usable: boolean;
  outcomeHandled?: boolean;
}

export const BURN_OBSERVATION_REASONS = ['observed', 'missing_baseline', 'reset', 'decreased', 'overlap', 'incomplete', 'restart'] as const;
export interface BurnObservation {
  runId?: string;
  atMs: number;
  /** Local arrival time can be later than the provider sample timestamp. */
  availableAtMs?: number;
  /** Outside and parent activity cannot be separated from a whole-login quota interval. */
  attribution: 'whole_login_unknown';
  reason: (typeof BURN_OBSERVATION_REASONS)[number];
  weekly?: { observedBp: number; errorBp?: number };
  fiveHour?: { observedBp: number; errorBp?: number };
}

/** The content-free fields already joined by the decision and usage ledger. */
export interface ForecastEntry {
  decisionId: string;
  decidedAtMs: number;
  provider: string | null;
  model: string | null;
  effort: string | null;
  difficulty: HelperDifficulty | null;
  mappingRevision?: string;
  calibration?: HelperCalibrationIdentity;
  taskProfile?: HelperTaskProfile;
  spawn?: string;
  forecast?: BurnForecast;
  forecastRun?: ForecastRun;
  burnObservation?: BurnObservation;
}

export function burnForecastKey(entry: ForecastEntry): string | null {
  const calibration = readBurnCalibrationIdentity(entry.calibration);
  if (!entry.provider || !entry.model || !entry.difficulty || !calibration) return null;
  return JSON.stringify(['cell-v1', entry.provider, entry.model, calibration.model, entry.effort, entry.difficulty, calibration.revision, entry.taskProfile ?? 'unspecified']);
}

export function readBurnCalibrationIdentity(value: unknown): HelperCalibrationIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Partial<HelperCalibrationIdentity>;
  if (!isPresetModel(c.model) || typeof c.revision !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(c.revision)) return undefined;
  return { model: c.model, revision: c.revision };
}

const validBp = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 10_000;
const validTime = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function estimate(key: string | null, history: readonly ForecastEntry[], window: 'weekly' | 'fiveHour', now: number): BurnEstimate {
  if (!key) return { samples: 0, unavailableReason: 'missing_calibration_identity' };
  const decisions = new Set<string>();
  const samples = history.flatMap((entry) => {
    const observation = entry.burnObservation;
    const value = observation?.[window]?.observedBp;
    if (entry.forecast?.key !== key || burnForecastKey(entry) !== key || observation?.reason !== 'observed'
      || !validTime(observation.atMs) || observation.atMs >= now || now - observation.atMs > AUTO_FORECAST_RETENTION_MS || !validBp(value)
      || (observation.availableAtMs !== undefined && (!validTime(observation.availableAtMs) || observation.availableAtMs >= now))
      || decisions.has(entry.decisionId)) return [];
    decisions.add(entry.decisionId);
    return [{ value, at: observation.atMs, weight: 2 ** (-(now - observation.atMs) / AUTO_FORECAST_HALF_LIFE_MS) }];
  }).sort((a, b) => b.at - a.at).slice(0, AUTO_FORECAST_MAX_SAMPLES);
  const weight = samples.reduce((sum, s) => sum + s.weight, 0);
  const effective = samples.length > 0 ? Math.min(samples.length, weight ** 2 / samples.reduce((sum, s) => sum + s.weight ** 2, 0)) : undefined;
  const result: BurnEstimate = { samples: samples.length, ...(effective !== undefined && { effectiveSamples: effective }) };
  if (samples.length < AUTO_FORECAST_MIN_SAMPLES) return { ...result, unavailableReason: 'insufficient_samples' };
  if (effective === undefined || effective < AUTO_FORECAST_MIN_EFFECTIVE_SAMPLES) return { ...result, unavailableReason: 'insufficient_effective_samples' };
  samples.sort((a, b) => a.value - b.value);
  const quantile = (fraction: number): number => {
    let cumulative = 0;
    for (const sample of samples) {
      cumulative += sample.weight;
      if (cumulative >= weight * fraction) return sample.value;
    }
    return samples[samples.length - 1].value;
  };
  return {
    ...result, expectedBp: quantile(0.5),
    interval: { method: 'weighted_empirical', nominalCoverageBp: AUTO_FORECAST_EMPIRICAL_COVERAGE_BP, lowerBp: quantile(0.1), upperBp: quantile(0.9) },
  };
}

export interface BurnCalibration {
  qualification: 'shadow_proxy_only';
  decisions: number;
  unknown: number;
  pending: number;
  excluded: number;
  missingWindow: number;
  evaluated: number;
  maeBp?: number;
  biasBp?: number;
  intervalsEvaluated: number;
  intervalCoverageBp?: number;
  meanIntervalWidthBp?: number;
  meanIntervalScoreBp?: number;
}

/** Score immutable predictions, never refit them on their later outcomes. All figures remain whole-login proxies. */
export function summarizeHelperBurn(history: readonly ForecastEntry[], key: string | null, window: 'weekly' | 'fiveHour', now: number): BurnCalibration {
  const decisions = new Set<string>();
  const entries = history.filter((e) => key !== null && e.forecast?.key === key && burnForecastKey(e) === key
    && e.decidedAtMs <= now && now - e.decidedAtMs <= AUTO_FORECAST_RETENTION_MS && e.forecast.atMs <= now)
    .sort((a, b) => b.decidedAtMs - a.decidedAtMs).filter((entry) => {
      if (decisions.has(entry.decisionId)) return false;
      decisions.add(entry.decisionId);
      return true;
    }).slice(0, HELPER_TELEMETRY_LIMITS.maxInactiveLedgerEntries);
  const result: BurnCalibration = { qualification: 'shadow_proxy_only', decisions: entries.length, unknown: 0, pending: 0, excluded: 0, missingWindow: 0, evaluated: 0, intervalsEvaluated: 0 };
  let errors = 0, absoluteErrors = 0, covered = 0, widths = 0, scores = 0;
  for (const entry of entries) {
    const prediction = entry.forecast![window];
    if (prediction.expectedBp === undefined) result.unknown++;
    const observation = entry.burnObservation;
    if (!observation || observation.atMs > now || (observation.availableAtMs ?? observation.atMs) > now) { result.pending++; continue; }
    if (observation.reason !== 'observed') { result.excluded++; continue; }
    const observed = observation[window]?.observedBp;
    if (!validBp(observed)) { result.missingWindow++; continue; }
    if (prediction.expectedBp !== undefined) {
      const error = observed - prediction.expectedBp;
      result.evaluated++;
      errors += error;
      absoluteErrors += Math.abs(error);
    }
    const interval = prediction.interval;
    if (!interval) continue;
    result.intervalsEvaluated++;
    const width = interval.upperBp - interval.lowerBp;
    const outside = Math.max(interval.lowerBp - observed, observed - interval.upperBp, 0);
    if (outside === 0) covered++;
    widths += width;
    // Winkler interval score: 2 / alpha, where this empirical band's nominal alpha is 0.2.
    scores += width + 10 * outside;
  }
  if (result.evaluated > 0) {
    result.maeBp = absoluteErrors / result.evaluated;
    result.biasBp = errors / result.evaluated;
  }
  if (result.intervalsEvaluated > 0) {
    result.intervalCoverageBp = 10_000 * covered / result.intervalsEvaluated;
    result.meanIntervalWidthBp = widths / result.intervalsEvaluated;
    result.meanIntervalScoreBp = scores / result.intervalsEvaluated;
  }
  return result;
}

/** Shadow prediction from observations available strictly before this decision, never future outcomes. */
export function predictHelperBurn(entry: ForecastEntry, history: readonly ForecastEntry[], now: number, baseline?: DecisionQuota): BurnForecast {
  const key = burnForecastKey(entry);
  let savedBaseline: BurnForecast['baseline'];
  let baselineUnavailableReason: BurnForecast['baselineUnavailableReason'];
  if (!baseline) baselineUnavailableReason = 'missing';
  else if (baseline.quality !== 'fresh' || baseline.state === 'unknown') baselineUnavailableReason = 'not_fresh';
  else if (!validTime(baseline.asOfMs)) baselineUnavailableReason = 'missing_timestamp';
  else if (baseline.asOfMs > now) baselineUnavailableReason = 'future_timestamp';
  else if (now - baseline.asOfMs > QUOTA_STALE_MS) baselineUnavailableReason = 'stale';
  else {
    savedBaseline = { asOfMs: baseline.asOfMs };
    for (const window of ['weekly', 'fiveHour'] as const) {
      const value = baseline.windows?.find((w) => w.name === window);
      if (value && validBp(value.usedBp) && validTime(value.resetsAtMs) && value.resetsAtMs > now) {
        savedBaseline[window] = { usedBp: value.usedBp, resetsAtMs: value.resetsAtMs };
      }
    }
    if (!savedBaseline.weekly && !savedBaseline.fiveHour) {
      savedBaseline = undefined;
      baselineUnavailableReason = 'missing_windows';
    }
  }
  return {
    version: 1, atMs: now, key, basis: 'subscription_interval',
    weekly: !entry.provider || !entry.model || !entry.difficulty ? { samples: 0, unavailableReason: 'missing_identity' } : estimate(key, history, 'weekly', now),
    fiveHour: !entry.provider || !entry.model || !entry.difficulty ? { samples: 0, unavailableReason: 'missing_identity' } : estimate(key, history, 'fiveHour', now),
    ...(savedBaseline && { baseline: savedBaseline }),
    ...(baselineUnavailableReason && { baselineUnavailableReason }),
  };
}

/**
 * Evaluate a completed first run against a later quota read. This is an interval
 * proxy, not attributed helper burn. Overlapping known helpers are not assigned
 * each other's consumption, and no token-to-quota conversion is made.
 */
export function observeHelperBurn(entry: ForecastEntry, history: readonly ForecastEntry[], quota: QuotaView, availableAtMs?: number): BurnObservation | undefined {
  const forecast = entry.forecast;
  const run = entry.forecastRun;
  const atMs = quota.asOf ? Date.parse(quota.asOf) : NaN;
  if (!forecast || entry.burnObservation || !run || run.endedMs === undefined
    || !validTime(atMs) || atMs < run.endedMs || quota.state === 'unknown'
    || (availableAtMs !== undefined && (!validTime(availableAtMs) || availableAtMs < atMs))) return undefined;
  const arrival = availableAtMs !== undefined ? { availableAtMs } : {};
  const observation: BurnObservation = { atMs, ...arrival, attribution: 'whole_login_unknown', reason: 'observed', ...(run.runId && { runId: run.runId }) };
  if (!run.usable || run.usageSamples === 0) return { ...observation, reason: 'incomplete' };
  const baseline = forecast.baseline;
  const from = baseline?.asOfMs;
  if (!baseline || from === undefined || from > entry.decidedAtMs
    || entry.decidedAtMs - from > QUOTA_STALE_MS) return { ...observation, reason: 'missing_baseline' };
  const overlap = history.some((other) => {
    if (other.decisionId === entry.decisionId || other.provider !== entry.provider) return false;
    const otherRun = other.forecastRun;
    if (otherRun) return otherRun.startedMs < atMs && (otherRun.endedMs ?? Infinity) > from;
    return (other.spawn === undefined || other.spawn === 'started' || other.spawn === 'orphaned')
      && other.decidedAtMs <= atMs;
  });
  if (overlap) return { ...observation, reason: 'overlap' };
  for (const window of ['weekly', 'fiveHour'] as const) {
    const before = baseline[window];
    const after = quota[window];
    if (!before || !after || !validBp(before.usedBp) || !validTime(before.resetsAtMs)
      || after.usedPercent === null || after.resetsAt === null) continue;
    const resets = Date.parse(after.resetsAt);
    const usedBp = Math.round(after.usedPercent * 100);
    if (!validBp(usedBp) || !validTime(resets)) continue;
    if (resets !== before.resetsAtMs || resets <= atMs) return { atMs, ...arrival, attribution: observation.attribution, reason: 'reset', ...(run.runId && { runId: run.runId }) };
    if (usedBp < before.usedBp) return { atMs, ...arrival, attribution: observation.attribution, reason: 'decreased', ...(run.runId && { runId: run.runId }) };
    const observedBp = usedBp - before.usedBp;
    const expected = forecast[window].expectedBp;
    observation[window] = { observedBp, ...(expected !== undefined && { errorBp: observedBp - expected }) };
  }
  return observation.weekly || observation.fiveHour ? observation : { ...observation, reason: 'missing_baseline' };
}

/** Read additive ledger fields with a closed shape. Old entries without them are unchanged. */
export function readBurnForecast(value: unknown): BurnForecast | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const f = value as Partial<BurnForecast>;
  const estimateOk = (e: BurnEstimate | undefined): e is BurnEstimate => !!e && Number.isInteger(e.samples) && e.samples >= 0 && e.samples <= AUTO_FORECAST_MAX_SAMPLES
    && (e.effectiveSamples === undefined || (Number.isFinite(e.effectiveSamples) && e.effectiveSamples >= 1 && e.effectiveSamples <= e.samples))
    && (e.unavailableReason === undefined || (HELPER_FORECAST_UNAVAILABLE_REASONS.includes(e.unavailableReason) && e.expectedBp === undefined))
    && (e.expectedBp === undefined || (e.samples >= AUTO_FORECAST_MIN_SAMPLES && validBp(e.expectedBp)
      && (e.effectiveSamples === undefined || e.effectiveSamples >= AUTO_FORECAST_MIN_EFFECTIVE_SAMPLES)))
    && (e.interval === undefined || (e.interval !== null && typeof e.interval === 'object'
      && e.interval.method === 'weighted_empirical' && e.interval.nominalCoverageBp === AUTO_FORECAST_EMPIRICAL_COVERAGE_BP
      && e.expectedBp !== undefined && validBp(e.interval.lowerBp) && validBp(e.interval.upperBp)
      && e.interval.lowerBp <= e.expectedBp && e.expectedBp <= e.interval.upperBp));
  if (f.version !== 1 || !validTime(f.atMs) || f.basis !== 'subscription_interval'
    || (f.baselineUnavailableReason !== undefined && (!HELPER_FORECAST_BASELINE_UNAVAILABLE_REASONS.includes(f.baselineUnavailableReason) || f.baseline !== undefined))
    || (f.key !== null && (typeof f.key !== 'string' || f.key.length > 1024)) || !estimateOk(f.weekly) || !estimateOk(f.fiveHour)) return undefined;
  let baseline: BurnForecast['baseline'];
  if (f.baseline !== undefined) {
    if (!f.baseline || !validTime(f.baseline.asOfMs)) return undefined;
    baseline = { asOfMs: f.baseline.asOfMs };
    for (const window of ['weekly', 'fiveHour'] as const) {
      const w = f.baseline[window];
      if (w === undefined) continue;
      if (!w || !validBp(w.usedBp) || !validTime(w.resetsAtMs)) return undefined;
      baseline[window] = { usedBp: w.usedBp, resetsAtMs: w.resetsAtMs };
    }
  }
  const readEstimate = (e: BurnEstimate): BurnEstimate => ({
    samples: e.samples, ...(e.expectedBp !== undefined && { expectedBp: e.expectedBp }),
    ...(e.effectiveSamples !== undefined && { effectiveSamples: e.effectiveSamples }),
    ...(e.unavailableReason && { unavailableReason: e.unavailableReason }),
    ...(e.interval && { interval: { method: e.interval.method, nominalCoverageBp: e.interval.nominalCoverageBp, lowerBp: e.interval.lowerBp, upperBp: e.interval.upperBp } }),
  });
  return { version: 1, atMs: f.atMs, key: f.key, basis: f.basis,
    weekly: readEstimate(f.weekly), fiveHour: readEstimate(f.fiveHour),
    ...(baseline && { baseline }), ...(f.baselineUnavailableReason && { baselineUnavailableReason: f.baselineUnavailableReason }) };
}

export function readForecastRun(value: unknown): ForecastRun | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Partial<ForecastRun>;
  if (!validTime(r.startedMs) || (r.endedMs !== undefined && (!validTime(r.endedMs) || r.endedMs < r.startedMs))
    || typeof r.usageSamples !== 'number' || !Number.isInteger(r.usageSamples) || r.usageSamples < 0 || r.usageSamples > 200
    || (r.outcomeHandled !== undefined && typeof r.outcomeHandled !== 'boolean')
    || typeof r.usable !== 'boolean' || (r.runId !== undefined && (typeof r.runId !== 'string' || r.runId.length === 0 || r.runId.length > 200))) return undefined;
  return { startedMs: r.startedMs, ...(r.endedMs !== undefined && { endedMs: r.endedMs }), usageSamples: r.usageSamples, usable: r.usable,
    ...(r.outcomeHandled !== undefined && { outcomeHandled: r.outcomeHandled }),
    ...(r.runId && { runId: r.runId }) };
}

export function readBurnObservation(value: unknown): BurnObservation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Partial<BurnObservation>;
  if (!validTime(o.atMs) || o.attribution !== 'whole_login_unknown' || !BURN_OBSERVATION_REASONS.includes(o.reason!)
    || (o.availableAtMs !== undefined && (!validTime(o.availableAtMs) || o.availableAtMs < o.atMs))
    || (o.runId !== undefined && (typeof o.runId !== 'string' || o.runId.length === 0 || o.runId.length > 200))) return undefined;
  const result: BurnObservation = { atMs: o.atMs, attribution: o.attribution, reason: o.reason!, ...(o.availableAtMs !== undefined && { availableAtMs: o.availableAtMs }), ...(o.runId && { runId: o.runId }) };
  for (const window of ['weekly', 'fiveHour'] as const) {
    const w = o[window];
    if (w === undefined) continue;
    if (!w || !validBp(w.observedBp) || (w.errorBp !== undefined && (!Number.isInteger(w.errorBp) || Math.abs(w.errorBp) > 10_000))) return undefined;
    result[window] = { observedBp: w.observedBp, ...(w.errorBp !== undefined && { errorBp: w.errorBp }) };
  }
  return result;
}
