/** Aggregate remaining subscription pressure. No token conversion, prompts, probes or model inference. */
import { QUOTA_STALE_MS, type QuotaView } from '../../shared/helper-routing';
import type { DecisionQuota } from '../../shared/telemetry/helper-usage-contract';
import { QUOTA_CALIBRATION_PLANS, type QuotaCalibrationIdentity, type PressureBand, type PressureDecision, type PressureOutcome } from '../../shared/helper-burn-pressure';
import { burnForecastKey, AUTO_FORECAST_HALF_LIFE_MS, AUTO_FORECAST_RETENTION_MS, type ForecastEntry } from './helper-auto-forecast';

/** Predeclared activation AND rollback gates; evaluated again at every decision. */
export const PRESSURE_POLICY = Object.freeze({
  seed: 8, minHeldOut: 20, maxSamples: 128, minEffective: 20,
  coverageBp: 9000, maxMaeBp: 100, maxAbsBiasBp: 50, maxWidthBp: 1000, maxLastErrorBp: 250, maxLatestAgeMs: 24 * 60 * 60_000,
  maxMembers: 8, maxHorizonMs: 24 * 60 * 60_000,
});
export interface PressureEntry extends ForecastEntry {
  pressure?: PressureDecision;
  pressureOutcome?: PressureOutcome;
}
const bp = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 10_000;
const time = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const text = (s: unknown, max = 1024): s is string => typeof s === 'string' && s.length > 0 && s.length <= max;
const ageBucket = (ms: number) => ms <= 0 ? 0 : ms <= 60_000 ? 1 : ms <= 5 * 60_000 ? 2 : ms <= 15 * 60_000 ? 3 : ms <= 60 * 60_000 ? 4 : 5;

function mean(samples: Array<{ value: number; at: number }>, at: number, weighted: boolean): number {
  let sum = 0, weights = 0;
  for (const s of samples) {
    const w = weighted ? 2 ** (-(at - s.at) / AUTO_FORECAST_HALF_LIFE_MS) : 1;
    sum += s.value * w; weights += w;
  }
  return sum / weights;
}

/** Strict chronological prequential residual calibration, with no retrospective refitting of receipts. */
export function qualifyPressure(history: readonly PressureEntry[], key: string, window: 'weekly' | 'fiveHour', now: number): PressureBand | undefined {
  const seen = new Set<string>();
  const rows = history.flatMap((e) => {
    const p = e.pressure, o = e.pressureOutcome;
    const value = o?.windows.find((w) => w.name === window)?.remainingBp;
    if (!p || p.key !== key || !o || o.reason !== 'observed' || !bp(value)
      || o.atMs >= now || o.availableAtMs >= now || now - o.availableAtMs > AUTO_FORECAST_RETENTION_MS
      || o.atMs < p.atMs || o.availableAtMs < o.atMs || seen.has(e.decisionId)) return [];
    seen.add(e.decisionId);
    return [{ value, at: o.availableAtMs, decisionAt: p.atMs, horizon: o.atMs - p.asOfMs, reset: p.windows.find((w) => w.name === window)?.resetsAtMs ?? 0 }];
  }).sort((a, b) => a.decisionAt - b.decisionAt).slice(-PRESSURE_POLICY.maxSamples);
  if (now - Math.max(...rows.map((r) => r.at)) > PRESSURE_POLICY.maxLatestAgeMs) return undefined;
  if (rows.some((r) => now + Math.max(...rows.map((v) => v.horizon)) >= r.reset)) return undefined;
  if (rows.length < PRESSURE_POLICY.seed + PRESSURE_POLICY.minHeldOut) return undefined;
  const residuals: number[] = [], errors: number[] = [], uniformErrors: number[] = [];
  // Training availability must precede the held-out decision, even for delayed/overlapping observations.
  for (let i = PRESSURE_POLICY.seed; i < rows.length; i++) {
    const row = rows[i];
    const train = rows.slice(0, i).filter((r) => r.at < row.decisionAt);
    if (train.length < PRESSURE_POLICY.seed) continue;
    const error = row.value - Math.round(mean(train, row.decisionAt, true));
    residuals.push(Math.abs(error)); errors.push(error);
    uniformErrors.push(Math.abs(row.value - Math.round(mean(train, row.decisionAt, false))));
  }
  if (errors.length < PRESSURE_POLICY.minHeldOut) return undefined;
  const weights = rows.map((r) => 2 ** (-(now - r.at) / AUTO_FORECAST_HALF_LIFE_MS));
  const effectiveSamples = weights.reduce((a, b) => a + b, 0) ** 2 / weights.reduce((a, b) => a + b * b, 0);
  const maeBp = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const biasBp = errors.reduce((a, b) => a + b, 0) / errors.length;
  // Calibration set precedes a final chronological validation tail. Coverage is measured on the tail.
  const split = Math.floor(residuals.length / 2);
  const sorted = residuals.slice(0, split).sort((a, b) => a - b);
  const radius = sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length + 1) * 0.9) - 1)];
  const tail = residuals.slice(split);
  const coverageBp = Math.round(10_000 * tail.filter((r) => r <= radius).length / tail.length);
  const uniformMae = uniformErrors.reduce((a, b) => a + b, 0) / uniformErrors.length;
  if (residuals[residuals.length - 1] > PRESSURE_POLICY.maxLastErrorBp || effectiveSamples < PRESSURE_POLICY.minEffective || maeBp > PRESSURE_POLICY.maxMaeBp
    || Math.abs(biasBp) > PRESSURE_POLICY.maxAbsBiasBp || coverageBp < PRESSURE_POLICY.coverageBp
    || maeBp > uniformMae + 1e-8 || 2 * radius > PRESSURE_POLICY.maxWidthBp) return undefined;
  const meanBp = Math.round(mean(rows, now, true));
  return { meanBp, lowerBp: Math.max(0, Math.floor(meanBp - radius)), upperBp: Math.min(10_000, Math.ceil(meanBp + radius)),
    samples: rows.length, effectiveSamples, maeBp, biasBp, coverageBp };
}

/**
 * Predict the whole group ONCE beyond the latest quota sample, including the proposed atomic start.
 * Unknown active/pending coverage fails closed to stage 1; load is never converted into burn.
 */
export function preparePressure(entry: ForecastEntry, history: readonly PressureEntry[], knownLoad: number, quota: DecisionQuota, now: number, plan?: QuotaCalibrationIdentity): PressureDecision | undefined {
  const asOf = quota.asOfMs;
  if (!plan || !entry.provider || !burnForecastKey(entry) || quota.quality !== 'fresh' || quota.state === 'unknown'
    || !time(asOf) || asOf > now || now - asOf > QUOTA_STALE_MS) return undefined;
  const sameProvider = history.filter((e) => e.provider === entry.provider && e.decisionId !== entry.decisionId);
  const live = sameProvider.filter((e) => e.forecastRun && e.forecastRun.endedMs === undefined);
  const pending = sameProvider.filter((e) => !e.forecastRun && e.spawn === undefined);
  if (live.length + pending.length !== knownLoad || live.some((e) => !e.forecastRun?.usable)) return undefined;
  // Include work that ended since the sample: its unobserved burn isn't in that quota yet.
  const active = sameProvider.filter((e) => e.forecastRun && (e.forecastRun.endedMs ?? Infinity) > asOf).concat(pending);
  if (active.some((e) => (e.forecastRun && !e.forecastRun.usable) || !burnForecastKey(e)) || active.length >= PRESSURE_POLICY.maxMembers) return undefined;
  const members = [...active.map((e) => ({ decisionId: e.decisionId, cell: burnForecastKey(e)!, startedMs: e.forecastRun?.startedMs ?? e.decidedAtMs })),
    { decisionId: entry.decisionId, cell: burnForecastKey(entry)!, startedMs: now }];
  if (members.some((m) => now - m.startedMs > PRESSURE_POLICY.maxHorizonMs)) return undefined;
  const windows = (quota.windows ?? []).flatMap((w): PressureDecision['windows'] =>
    (w.name === 'weekly' || w.name === 'fiveHour') && bp(w.usedBp) && time(w.resetsAtMs) && w.resetsAtMs > now
      ? [{ name: w.name, usedBp: w.usedBp, resetsAtMs: w.resetsAtMs }] : []);
  if (!windows.length) return undefined;
  // Reset epochs partition plan capacity. Never silently transfer a cohort to a different quota window.
  const key = JSON.stringify([entry.provider, plan.plan, plan.generation, members.map((m) => [m.cell, ageBucket(asOf - m.startedMs)]).sort(), windows.map((w) => [w.name, w.resetsAtMs])]);
  return { version: 1, policy: 'aggregate-conformal-v1', provider: entry.provider, plan: plan.plan, planGeneration: plan.generation, atMs: now, asOfMs: asOf, key, members,
    windows: windows.map((w) => ({ ...w, band: qualifyPressure(history, key, w.name, now) })) };
}

export function observePressure(sample: PressureDecision, history: readonly PressureEntry[], quota: QuotaView, now: number, plan?: QuotaCalibrationIdentity): PressureOutcome | undefined {
  const atMs = quota.asOf ? Date.parse(quota.asOf) : NaN;
  if (!time(atMs) || atMs <= sample.asOfMs || atMs > now || quota.state === 'unknown') return undefined;
  const result: PressureOutcome = { atMs, availableAtMs: now, attribution: 'subscription_group_with_unknown_residual', reason: 'observed', windows: [] };
  if (!plan || (plan.plan !== sample.plan || plan.generation !== sample.planGeneration)) return { ...result, reason: 'reset' };
  const group = sample.members.map((m) => history.find((e) => e.decisionId === m.decisionId));
  if (group.some((e) => !e || (!e.forecastRun && e.spawn === undefined))) return undefined;
  if (group.some((e) => !e || !e.forecastRun || !e.forecastRun.usable)) return { ...result, reason: 'incomplete' };
  if (group.some((e) => e!.forecastRun!.endedMs === undefined || e!.forecastRun!.endedMs! > atMs)) return undefined;
  const end = Math.max(...group.map((e) => e!.forecastRun!.endedMs!));
  if (end - sample.asOfMs > PRESSURE_POLICY.maxHorizonMs) return { ...result, reason: 'incomplete' };
  if (history.some((e) => e.provider === sample.provider && !sample.members.some((m) => m.decisionId === e.decisionId)
    && (e.forecastRun?.startedMs ?? e.decidedAtMs) < atMs
    && (e.forecastRun?.endedMs ?? Infinity) > sample.asOfMs)) return { ...result, reason: 'additional_run' };
  for (const w of sample.windows) {
    const after = quota[w.name];
    if (!after || after.usedPercent === null || !after.resetsAt) continue;
    if (Date.parse(after.resetsAt) !== w.resetsAtMs || atMs >= w.resetsAtMs) return { ...result, reason: 'reset' };
    const value = Math.round(after.usedPercent * 100) - w.usedBp;
    if (value < 0) return { ...result, reason: 'decreased' };
    if (bp(value)) result.windows.push({ name: w.name, remainingBp: value });
  }
  return result.windows.length ? result : { ...result, reason: 'incomplete' };
}

/** Closed local persistence boundary. Unknown versions become cold; they are never interpreted as a prior. */
export function readPressure(value: unknown): PressureDecision | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as PressureDecision;
  if (p.version !== 1 || p.policy !== 'aggregate-conformal-v1' || !QUOTA_CALIBRATION_PLANS.includes(p.plan) || !text(p.planGeneration, 36) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(p.planGeneration) || !text(p.provider, 200) || !text(p.key, 20_000)
    || !time(p.atMs) || !time(p.asOfMs) || p.asOfMs > p.atMs || !Array.isArray(p.members)
    || p.members.length < 1 || p.members.length > PRESSURE_POLICY.maxMembers
    || !p.members.every((m) => m && text(m.decisionId, 200) && text(m.cell) && time(m.startedMs))
    || !Array.isArray(p.windows) || p.windows.length < 1 || p.windows.length > 2
    || !p.windows.every((w) => w && (w.name === 'weekly' || w.name === 'fiveHour') && bp(w.usedBp) && time(w.resetsAtMs))) return undefined;
  const band = (b?: PressureBand): PressureBand | undefined => b && bp(b.meanBp) && bp(b.lowerBp) && bp(b.upperBp)
    && b.lowerBp <= b.meanBp && b.meanBp <= b.upperBp && Number.isInteger(b.samples) && b.samples >= 28 && b.samples <= PRESSURE_POLICY.maxSamples
    && time(b.effectiveSamples) && b.effectiveSamples <= b.samples && time(b.maeBp) && Number.isFinite(b.biasBp) && bp(b.coverageBp)
    ? { meanBp: b.meanBp, lowerBp: b.lowerBp, upperBp: b.upperBp, samples: b.samples, effectiveSamples: b.effectiveSamples, maeBp: b.maeBp, biasBp: b.biasBp, coverageBp: b.coverageBp } : undefined;
  return { version: 1, policy: p.policy, provider: p.provider, plan: p.plan, planGeneration: p.planGeneration, key: p.key, atMs: p.atMs, asOfMs: p.asOfMs,
    members: p.members.map((m) => ({ decisionId: m.decisionId, cell: m.cell, startedMs: m.startedMs })),
    windows: p.windows.map((w) => ({ name: w.name, usedBp: w.usedBp, resetsAtMs: w.resetsAtMs, band: band(w.band) })) };
}
export function readPressureOutcome(value: unknown): PressureOutcome | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as PressureOutcome;
  if (!time(o.atMs) || !time(o.availableAtMs) || o.availableAtMs < o.atMs || o.attribution !== 'subscription_group_with_unknown_residual'
    || !['observed', 'reset', 'decreased', 'incomplete', 'additional_run', 'restart'].includes(o.reason)
    || !Array.isArray(o.windows) || o.windows.length > 2 || !o.windows.every((w) => w && (w.name === 'weekly' || w.name === 'fiveHour') && bp(w.remainingBp))) return undefined;
  return { atMs: o.atMs, availableAtMs: o.availableAtMs, attribution: o.attribution, reason: o.reason,
    windows: o.windows.map((w) => ({ name: w.name, remainingBp: w.remainingBp })) };
}
