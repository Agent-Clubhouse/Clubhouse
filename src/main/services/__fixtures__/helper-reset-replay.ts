/** Research only: no production imports this module. Rates are whole-login quota bp/hour. */
import { QUOTA_STALE_MS } from '../../../shared/helper-routing';
import { AUTO_WEEK_MS, decideAutoProvider, type AutoCandidate, type AutoDecision, type AutoPolicyInput } from '../helper-auto-policy';
import { HOUR } from './helper-auto-replay';

export type ResetMode = 'cycle_legacy_tiers' | 'pace_deficit' | 'bounded_urgency';
export interface RateSample {
  atMs: number;
  availableAtMs: number;
  usedBp: number;
  resetsAtMs: number;
  identity: string;
}

/** Illustrative evidence floor, NOT an empirically qualified predictor or per-helper attribution. */
export function observedRate(samples: readonly RateSample[], now: number): number | undefined {
  const rows = samples.filter((s) => s.availableAtMs < now && s.atMs <= s.availableAtMs && now - s.atMs <= 24 * HOUR)
    .sort((a, b) => a.atMs - b.atMs);
  const first = rows[0], last = rows.at(-1);
  if (rows.length < 4 || !first || !last || last.atMs - first.atMs < 6 * HOUR
    || now - last.atMs > QUOTA_STALE_MS || last.resetsAtMs <= now) return undefined;
  if (rows.some((s, i) => !Number.isFinite(s.atMs) || !Number.isFinite(s.availableAtMs) || !Number.isFinite(s.resetsAtMs)
    || !s.identity || s.identity !== first.identity || s.resetsAtMs !== first.resetsAtMs
    || !Number.isInteger(s.usedBp) || s.usedBp < 0 || s.usedBp > 10_000
    || (i > 0 && (s.atMs <= rows[i - 1].atMs || s.usedBp < rows[i - 1].usedBp)))) return undefined;
  return (last.usedBp - first.usedBp) / ((last.atMs - first.atMs) / HOUR);
}

export interface ResetWindow {
  name: 'weekly' | 'fiveHour' | 'model' | 'other';
  usedBp: number;
  resetsAtMs?: number;
  limitReached?: boolean;
  /** One qualified aggregate remaining upper bound beyond this sample, including this start. */
  upperBp?: number;
}
export interface ResetEvidence {
  asOfMs: number;
  complete: boolean;
  windows: ResetWindow[];
  rateBpPerHour?: number;
}
export interface ResetOptions {
  mode: ResetMode;
  reserveBp?: number;
  /** Explicit opt-in, weekly ONLY: a smaller retained reserve inside 24h. Absent = never relax. */
  reserveWithin24hBp?: number;
  copilotFallback?: boolean;
  evidence: (candidate: AutoCandidate, now: number) => ResetEvidence | undefined;
}
export interface ResetEvaluation {
  key: string;
  excluded?: 'provider_limit' | 'auto_reserve' | 'unknown_usage';
  usableBp?: number;
  hoursLeft?: number;
  sustainableBpPerHour?: number;
  observedBpPerHour?: number;
  deficitBpPerHour?: number;
  urgency?: 0 | 1 | 2;
  relaxed?: boolean;
}

/** All invented policy parameters live here, in a test fixture, not runtime settings. */
export function selectReset(input: AutoPolicyInput, options: ResetOptions): { decision: AutoDecision; evaluations: ResetEvaluation[] } {
  const reserve = options.reserveBp ?? 1000;
  const validBp = (n: number) => Number.isInteger(n) && n >= 0 && n <= 10_000;
  if (!validBp(reserve) || (options.reserveWithin24hBp !== undefined
    && (!validBp(options.reserveWithin24hBp) || options.reserveWithin24hBp > reserve))) throw new Error('Invalid research reserve');
  const evaluations: ResetEvaluation[] = [];
  const eligible: AutoCandidate[] = [];
  for (const c of input.candidates) {
    const e: ResetEvaluation = { key: c.key };
    evaluations.push(e);
    if (c.quotaState === 'exhausted') { e.excluded = 'provider_limit'; continue; }
    if (c.quotaUnknownReason === 'not_supported') {
      if (options.copilotFallback !== false) eligible.push(c); else e.excluded = 'unknown_usage';
      continue;
    }
    const evidence = options.evidence(c, input.now);
    if (c.quotaState === 'unknown' || !evidence || !evidence.complete || !Number.isFinite(evidence.asOfMs)
      || evidence.asOfMs > input.now || input.now - evidence.asOfMs > QUOTA_STALE_MS
      || !evidence.windows.length || evidence.windows.some((w) => !validBp(w.usedBp)
        || (w.resetsAtMs !== undefined && (!Number.isFinite(w.resetsAtMs) || w.resetsAtMs <= input.now))
        || (w.upperBp !== undefined && !validBp(w.upperBp)))) {
      e.excluded = 'unknown_usage'; continue;
    }
    if (evidence.windows.some((w) => w.limitReached)) { e.excluded = 'provider_limit'; continue; }
    const weekly = evidence.windows.find((w) => w.name === 'weekly');
    const left = weekly?.resetsAtMs === undefined ? undefined : weekly.resetsAtMs - input.now;
    const validReset = left !== undefined && left > 0 && left <= AUTO_WEEK_MS;
    e.relaxed = !!(validReset && left <= 24 * HOUR && options.reserveWithin24hBp !== undefined
      && options.reserveWithin24hBp < reserve);
    const effectiveReserve = e.relaxed ? options.reserveWithin24hBp! : reserve;
    if (evidence.windows.some((w) => w.usedBp + (w.upperBp ?? 0) >= 10_000 - (w.name === 'weekly' ? effectiveReserve : reserve))) {
      e.excluded = 'auto_reserve'; continue;
    }
    if (weekly && validReset) {
      e.hoursLeft = left / HOUR;
      e.usableBp = Math.max(0, 10_000 - effectiveReserve - weekly.usedBp);
      e.sustainableBpPerHour = e.usableBp / e.hoursLeft;
      if (evidence.rateBpPerHour !== undefined && Number.isFinite(evidence.rateBpPerHour) && evidence.rateBpPerHour >= 0) {
        e.observedBpPerHour = evidence.rateBpPerHour;
        e.deficitBpPerHour = e.sustainableBpPerHour - evidence.rateBpPerHour;
      }
      // Missing pace is not zero pace: calendar urgency is explicitly labeled as such.
      const needsWork = e.deficitBpPerHour === undefined || e.deficitBpPerHour > 0;
      e.urgency = needsWork && e.hoursLeft <= 24 ? 2 : needsWork && e.hoursLeft <= 48 ? 1 : 0;
    }
    eligible.push(c);
  }

  let candidates = eligible;
  if (options.mode === 'pace_deficit') {
    // Raw pace comparator only when ALL measured eligible candidates have evidence.
    const measured = eligible.filter((c) => c.quotaUnknownReason !== 'not_supported');
    const scores = measured.map((c) => evaluations.find((e) => e.key === c.key)!);
    if (scores.length && scores.every((e) => e.deficitBpPerHour !== undefined)) {
      const best = Math.max(...scores.map((e) => e.deficitBpPerHour!));
      if (best > 0) candidates = measured.filter((c) => evaluations.find((e) => e.key === c.key)!.deficitBpPerHour === best);
    }
  } else if (options.mode === 'bounded_urgency') {
    const urgent = eligible.filter((c) => c.verified && (evaluations.find((e) => e.key === c.key)!.urgency ?? 0) > 0);
    if (urgent.length) {
      const band = Math.max(...urgent.map((c) => evaluations.find((e) => e.key === c.key)!.urgency!));
      const inBand = urgent.filter((c) => evaluations.find((e) => e.key === c.key)!.urgency === band);
      const soonest = Math.min(...inBand.map((c) => evaluations.find((e) => e.key === c.key)!.hoursLeft!));
      candidates = inBand.filter((c) => evaluations.find((e) => e.key === c.key)!.hoursLeft === soonest);
    }
  }
  return { evaluations, decision: decideAutoProvider({ ...input, candidates,
    options: { ...input.options, basis: options.mode === 'cycle_legacy_tiers' ? 'reset_schedule' : 'weekly_used' } }) };
}

/** For the synthetic weekly-only, zero-lag simulation. Never use this invented freshness in production. */
export function weeklySimulationEvidence(c: AutoCandidate, now: number): ResetEvidence | undefined {
  if (c.weekly?.usedPercent === null || c.weekly?.usedPercent === undefined) return undefined;
  return { asOfMs: now, complete: true, windows: [{ name: 'weekly', usedBp: Math.round(c.weekly.usedPercent * 100),
    ...(c.weekly.resetsAtMs !== null && { resetsAtMs: c.weekly.resetsAtMs }),
    ...(c.remainingPressure?.[0] && { upperBp: c.remainingPressure[0].upperBp }) }] };
}
