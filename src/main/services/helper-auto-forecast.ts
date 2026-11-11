import { QUOTA_STALE_MS, type HelperDifficulty, type QuotaView } from '../../shared/helper-routing';
import type { DecisionQuota, HelperTaskProfile } from '../../shared/telemetry/helper-usage-contract';

export const AUTO_FORECAST_MIN_SAMPLES = 5;
export const AUTO_FORECAST_MIN_EFFECTIVE_SAMPLES = 3;
export const AUTO_FORECAST_HALF_LIFE_MS = 7 * 24 * 60 * 60_000;
export const AUTO_FORECAST_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const AUTO_FORECAST_MAX_SAMPLES = 32;

export interface BurnEstimate {
  samples: number;
  /** Absent is unknown, including cold starts. Basis points of this provider's own window. */
  expectedBp?: number;
}

export interface BurnForecast {
  version: 1;
  atMs: number;
  /** Exact mapped identities only. No cross-model, effort, revision or profile transfer. */
  key: string | null;
  basis: 'subscription_interval';
  weekly: BurnEstimate;
  fiveHour: BurnEstimate;
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
}

export const BURN_OBSERVATION_REASONS = ['observed', 'missing_baseline', 'reset', 'decreased', 'overlap', 'incomplete', 'restart'] as const;
export interface BurnObservation {
  runId?: string;
  atMs: number;
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
  taskProfile?: HelperTaskProfile;
  spawn?: string;
  forecast?: BurnForecast;
  forecastRun?: ForecastRun;
  burnObservation?: BurnObservation;
}

export function burnForecastKey(entry: ForecastEntry): string | null {
  if (!entry.provider || !entry.model || !entry.difficulty || !entry.mappingRevision) return null;
  return JSON.stringify([entry.provider, entry.model, entry.effort, entry.difficulty, entry.mappingRevision, entry.taskProfile ?? 'unspecified']);
}

const validBp = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 10_000;
const validTime = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function estimate(key: string | null, history: readonly ForecastEntry[], window: 'weekly' | 'fiveHour', now: number): BurnEstimate {
  const decisions = new Set<string>();
  const samples = history.flatMap((entry) => {
    const observation = entry.burnObservation;
    const value = observation?.[window]?.observedBp;
    if (!key || entry.forecast?.key !== key || burnForecastKey(entry) !== key || observation?.reason !== 'observed'
      || observation.atMs >= now || now - observation.atMs > AUTO_FORECAST_RETENTION_MS || !validBp(value)
      || decisions.has(entry.decisionId)) return [];
    decisions.add(entry.decisionId);
    return [{ value, at: observation.atMs, weight: 2 ** (-(now - observation.atMs) / AUTO_FORECAST_HALF_LIFE_MS) }];
  }).sort((a, b) => b.at - a.at).slice(0, AUTO_FORECAST_MAX_SAMPLES);
  const result: BurnEstimate = { samples: samples.length };
  if (samples.length < AUTO_FORECAST_MIN_SAMPLES) return result;
  const weight = samples.reduce((sum, s) => sum + s.weight, 0);
  const effective = weight ** 2 / samples.reduce((sum, s) => sum + s.weight ** 2, 0);
  if (effective < AUTO_FORECAST_MIN_EFFECTIVE_SAMPLES) return result;
  let cumulative = 0;
  for (const sample of samples.sort((a, b) => a.value - b.value)) {
    cumulative += sample.weight;
    if (cumulative >= weight / 2) return { ...result, expectedBp: sample.value };
  }
  return result;
}

/** Shadow prediction from observations available strictly before this decision, never future outcomes. */
export function predictHelperBurn(entry: ForecastEntry, history: readonly ForecastEntry[], now: number, baseline?: DecisionQuota): BurnForecast {
  const key = burnForecastKey(entry);
  let savedBaseline: BurnForecast['baseline'];
  if (baseline?.quality === 'fresh' && validTime(baseline.asOfMs)) {
    savedBaseline = { asOfMs: baseline.asOfMs };
    for (const window of ['weekly', 'fiveHour'] as const) {
      const value = baseline.windows?.find((w) => w.name === window);
      if (value && validBp(value.usedBp) && validTime(value.resetsAtMs)) {
        savedBaseline[window] = { usedBp: value.usedBp, resetsAtMs: value.resetsAtMs };
      }
    }
  }
  return {
    version: 1, atMs: now, key, basis: 'subscription_interval',
    weekly: estimate(key, history, 'weekly', now), fiveHour: estimate(key, history, 'fiveHour', now),
    ...(savedBaseline && { baseline: savedBaseline }),
  };
}

/**
 * Evaluate a completed first run against a later quota read. This is an interval
 * proxy, not attributed helper burn. Overlapping known helpers are not assigned
 * each other's consumption, and no token-to-quota conversion is made.
 */
export function observeHelperBurn(entry: ForecastEntry, history: readonly ForecastEntry[], quota: QuotaView): BurnObservation | undefined {
  const forecast = entry.forecast;
  const run = entry.forecastRun;
  const atMs = quota.asOf ? Date.parse(quota.asOf) : NaN;
  if (!forecast || entry.burnObservation || !run || run.endedMs === undefined
    || !validTime(atMs) || atMs < run.endedMs || quota.state === 'unknown') return undefined;
  const observation: BurnObservation = { atMs, attribution: 'whole_login_unknown', reason: 'observed', ...(run.runId && { runId: run.runId }) };
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
    if (resets !== before.resetsAtMs || resets <= atMs) return { atMs, attribution: observation.attribution, reason: 'reset', ...(run.runId && { runId: run.runId }) };
    if (usedBp < before.usedBp) return { atMs, attribution: observation.attribution, reason: 'decreased', ...(run.runId && { runId: run.runId }) };
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
    && (e.expectedBp === undefined || (e.samples >= AUTO_FORECAST_MIN_SAMPLES && validBp(e.expectedBp)));
  if (f.version !== 1 || !validTime(f.atMs) || f.basis !== 'subscription_interval'
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
  return { version: 1, atMs: f.atMs, key: f.key, basis: f.basis,
    weekly: { samples: f.weekly.samples, ...(f.weekly.expectedBp !== undefined && { expectedBp: f.weekly.expectedBp }) },
    fiveHour: { samples: f.fiveHour.samples, ...(f.fiveHour.expectedBp !== undefined && { expectedBp: f.fiveHour.expectedBp }) },
    ...(baseline && { baseline }) };
}

export function readForecastRun(value: unknown): ForecastRun | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Partial<ForecastRun>;
  if (!validTime(r.startedMs) || (r.endedMs !== undefined && (!validTime(r.endedMs) || r.endedMs < r.startedMs))
    || typeof r.usageSamples !== 'number' || !Number.isInteger(r.usageSamples) || r.usageSamples < 0 || r.usageSamples > 200
    || typeof r.usable !== 'boolean' || (r.runId !== undefined && (typeof r.runId !== 'string' || r.runId.length === 0 || r.runId.length > 200))) return undefined;
  return { startedMs: r.startedMs, ...(r.endedMs !== undefined && { endedMs: r.endedMs }), usageSamples: r.usageSamples, usable: r.usable,
    ...(r.runId && { runId: r.runId }) };
}

export function readBurnObservation(value: unknown): BurnObservation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Partial<BurnObservation>;
  if (!validTime(o.atMs) || o.attribution !== 'whole_login_unknown' || !BURN_OBSERVATION_REASONS.includes(o.reason!)
    || (o.runId !== undefined && (typeof o.runId !== 'string' || o.runId.length === 0 || o.runId.length > 200))) return undefined;
  const result: BurnObservation = { atMs: o.atMs, attribution: o.attribution, reason: o.reason!, ...(o.runId && { runId: o.runId }) };
  for (const window of ['weekly', 'fiveHour'] as const) {
    const w = o[window];
    if (w === undefined) continue;
    if (!w || !validBp(w.observedBp) || (w.errorBp !== undefined && (!Number.isInteger(w.errorBp) || Math.abs(w.errorBp) > 10_000))) return undefined;
    result[window] = { observedBp: w.observedBp, ...(w.errorBp !== undefined && { errorBp: w.errorBp }) };
  }
  return result;
}
