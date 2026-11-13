/** Offline-only stage-4 experiment. No provider calls, persistence, prompts or runtime training. */
import { HELPER_TASK_PROFILES, type HelperTaskProfile } from '../../shared/telemetry/helper-usage-contract';

export const ADAPTIVE_RESEARCH_POLICY = Object.freeze({
  version: 'local-adaptive-evaluation-v1', maxRows: 512, retentionMs: 30 * 86_400_000,
  maxBytes: 1024 * 1024, minCohort: 8, minLearned: 32, maxLatencyMs: 10,
  minRealHeldOut: 100, minImprovement: 0.10, minCoverage: 0.90, maxMemoryBytes: 8 * 1024 * 1024,
});
/** The evaluation has not qualified a production adaptive predictor. Retain stages 1/3 indefinitely. */
export const ADAPTIVE_MODEL_ENABLED = false;
export interface AdaptiveEvidence {
  schemaVersion: 1;
  id: string;
  atMs: number;
  availableAtMs: number;
  provider: 'claude-code' | 'codex-cli';
  model: string;
  effort: string | null;
  mappingGeneration: string;
  planGeneration: string;
  resetEpoch: number;
  difficulty: 'easy' | 'medium' | 'hard';
  profile: HelperTaskProfile;
  elapsedMs: number;
  /** Explanatory counter only; none of these candidates converts tokens into quota. */
  usageTokens?: number;
  remainingBp: number;
  endUsedBp: number;
  outcome: 'completed' | 'failed' | 'cancelled';
  source: 'synthetic' | 'ordinary_consented';
}
export interface AdaptiveBand { meanBp: number; lowerBp: number; upperBp: number }
export type AdaptiveMethod = 'stage1' | 'cohort' | 'versioned_initial' | 'device_linear';
export interface AdaptiveMetrics {
  evaluated: number; unavailable: number; maeBp: number | null; biasBp: number | null; coverage: number | null;
  p95LatencyMs: number;
}
export interface AdaptiveEvaluation {
  policy: string;
  input: number; retained: number; dropped: number; train: number; test: number; retainedBytes: number;
  provenance: 'synthetic_only' | 'includes_ordinary_consented';
  initialPredictor: { version: 'synthetic-initial-v1'; units: 'window_basis_points'; portableToOtherSubscriptions: false; productionEligible: false };
  methods: Record<AdaptiveMethod, AdaptiveMetrics>;
  byCohort: Record<string, Record<AdaptiveMethod, AdaptiveMetrics>>;
  outcomes: { completed: number; failed: number; cancelled: number; depletedIntervals: number; simulated: boolean };
  verdict: 'retain_non_ml';
  reasons: string[];
}
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const bp = (x: unknown): x is number => finite(x) && Number.isInteger(x) && x <= 10_000;
const short = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;
const age = (ms: number) => ms <= 0 ? 0 : ms <= 60_000 ? 1 : ms <= 300_000 ? 2 : ms <= 900_000 ? 3 : ms <= 3_600_000 ? 4 : 5;
const key = (r: AdaptiveEvidence) => JSON.stringify([r.provider, r.model, r.effort, r.mappingGeneration, r.planGeneration, r.resetEpoch, r.difficulty, r.profile]);
const quantile = (values: number[], q: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(q * (values.length + 1)) - 1)] : 10_000;
const clamp = (x: number) => Math.max(0, Math.min(10_000, x));
const empty = (): AdaptiveMetrics => ({ evaluated: 0, unavailable: 0, maeBp: null, biasBp: null, coverage: null, p95LatencyMs: 0 });
const methods = (): Record<AdaptiveMethod, AdaptiveMetrics> => ({ stage1: empty(), cohort: empty(), versioned_initial: empty(), device_linear: empty() });

/** Closed projection, bounded by rows/bytes/age. Unknown fields and versions never become model inputs. */
export function retainAdaptiveEvidence(input: readonly unknown[], now: number): AdaptiveEvidence[] {
  const seen = new Set<string>();
  let bytes = 0;
  return input.slice(-ADAPTIVE_RESEARCH_POLICY.maxRows * 4).flatMap((v): AdaptiveEvidence[] => {
    if (!v || typeof v !== 'object') return [];
    const r = v as AdaptiveEvidence;
    if (r.schemaVersion !== 1 || !short(r.id, 100) || !finite(r.atMs) || !finite(r.availableAtMs) || r.availableAtMs < r.atMs
      || r.availableAtMs > now || now - r.atMs > ADAPTIVE_RESEARCH_POLICY.retentionMs
      || !['claude-code', 'codex-cli'].includes(r.provider) || !short(r.model, 200)
      || (r.effort !== null && !short(r.effort, 20)) || !short(r.mappingGeneration, 100) || !short(r.planGeneration, 100)
      || !finite(r.resetEpoch) || r.resetEpoch <= r.availableAtMs || !['easy', 'medium', 'hard'].includes(r.difficulty)
      || !HELPER_TASK_PROFILES.includes(r.profile) || !finite(r.elapsedMs) || r.elapsedMs > 86_400_000
      || (r.usageTokens !== undefined && (!finite(r.usageTokens) || r.usageTokens > 1e9))
      || !bp(r.remainingBp) || !bp(r.endUsedBp) || !['completed', 'failed', 'cancelled'].includes(r.outcome)
      || !['synthetic', 'ordinary_consented'].includes(r.source)) return [];
    return [{ schemaVersion: 1, id: r.id, atMs: r.atMs, availableAtMs: r.availableAtMs, provider: r.provider, model: r.model, effort: r.effort,
      mappingGeneration: r.mappingGeneration, planGeneration: r.planGeneration, resetEpoch: r.resetEpoch,
      difficulty: r.difficulty, profile: r.profile, elapsedMs: r.elapsedMs, ...(r.usageTokens !== undefined && { usageTokens: r.usageTokens }),
      remainingBp: r.remainingBp, endUsedBp: r.endUsedBp, outcome: r.outcome, source: r.source }];
  }).sort((a, b) => b.atMs - a.atMs).filter((r) => {
    const cost = JSON.stringify(r).length * 2;
    if (seen.has(r.id) || bytes + cost > ADAPTIVE_RESEARCH_POLICY.maxBytes) return false;
    seen.add(r.id); bytes += cost; return true;
  }).slice(0, ADAPTIVE_RESEARCH_POLICY.maxRows).reverse();
}

function linear(train: readonly AdaptiveEvidence[], target: AdaptiveEvidence): number | undefined {
  if (train.length < ADAPTIVE_RESEARCH_POLICY.minCohort) return undefined;
  const x = train.map((r) => r.elapsedMs / 60_000), y = train.map((r) => r.remainingBp);
  const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
  const variance = x.reduce((s, v) => s + (v - mx) ** 2, 0);
  if (variance === 0 || target.elapsedMs < Math.min(...train.map((r) => r.elapsedMs)) || target.elapsedMs > Math.max(...train.map((r) => r.elapsedMs))) return undefined;
  const slope = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / variance;
  const prediction = my + slope * (target.elapsedMs / 60_000 - mx);
  return Number.isFinite(prediction) ? Math.round(clamp(prediction)) : undefined;
}
function predict(method: AdaptiveMethod, allTrain: readonly AdaptiveEvidence[], row: AdaptiveEvidence): AdaptiveBand | undefined {
  if (method === 'stage1') return undefined; // Stage 1 has no burn predictor. Do not score an invented zero.
  const train = allTrain.filter((r) => key(r) === key(row) && r.availableAtMs < row.atMs);
  if (train.length < ADAPTIVE_RESEARCH_POLICY.minCohort || row.atMs - train[train.length - 1].availableAtMs > 86_400_000) return undefined;
  if (method === 'cohort') {
    const cohort = train.filter((r) => age(r.elapsedMs) === age(row.elapsedMs));
    if (cohort.length < ADAPTIVE_RESEARCH_POLICY.minCohort) return undefined;
    const weights = cohort.map((r) => 2 ** (-(row.atMs - r.availableAtMs) / (7 * 86_400_000)));
    const meanBp = cohort.reduce((s, r, i) => s + r.remainingBp * weights[i], 0) / weights.reduce((a, b) => a + b, 0);
    return { meanBp: Math.round(meanBp), lowerBp: quantile(cohort.map((r) => r.remainingBp), 0.1), upperBp: quantile(cohort.map((r) => r.remainingBp), 0.9) };
  }
  if (method === 'versioned_initial') {
    // A versioned prior must disclose its source. This candidate is synthetic-only and cannot ship to a real subscription.
    const initial = train.slice(0, ADAPTIVE_RESEARCH_POLICY.minCohort);
    if (initial.some((r) => r.source !== 'synthetic')) return undefined;
    const prior = linear(initial, row);
    const calibration = train.slice(initial.length);
    if (prior === undefined || calibration.length < ADAPTIVE_RESEARCH_POLICY.minCohort) return undefined;
    const residuals = calibration.flatMap((r) => { const p = linear(initial, r); return p === undefined ? [] : [r.remainingBp - p]; });
    if (residuals.length < ADAPTIVE_RESEARCH_POLICY.minCohort) return undefined;
    const offset = residuals.reduce((a, b) => a + b, 0) / residuals.length;
    const radius = quantile(residuals.map((v) => Math.abs(v - offset)), 0.9);
    return { meanBp: clamp(prior + offset), lowerBp: clamp(prior + offset - radius), upperBp: clamp(prior + offset + radius) };
  }
  if (train.length < ADAPTIVE_RESEARCH_POLICY.minLearned) return undefined;
  const split = Math.floor(train.length * 2 / 3), fit = train.slice(0, split), calibration = train.slice(split);
  const point = linear(fit, row);
  if (point === undefined) return undefined;
  const residuals = calibration.flatMap((r) => { const p = linear(fit, r); return p === undefined ? [] : [Math.abs(r.remainingBp - p)]; });
  if (residuals.length < ADAPTIVE_RESEARCH_POLICY.minCohort) return undefined;
  const radius = quantile(residuals, 0.9);
  return { meanBp: point, lowerBp: clamp(point - radius), upperBp: clamp(point + radius) };
}

/** Fixed chronological split; test outcomes are NEVER used in any fit or uncertainty calibration. */
export function evaluateAdaptiveEvidence(input: readonly unknown[], now: number, clock: () => number = () => performance.now()): AdaptiveEvaluation {
  const rows = retainAdaptiveEvidence(input, now), split = Math.floor(rows.length * 0.6), train = rows.slice(0, split), test = rows.slice(split);
  const report: AdaptiveEvaluation = {
    policy: ADAPTIVE_RESEARCH_POLICY.version, input: input.length, retained: rows.length, dropped: input.length - rows.length,
    train: train.length, test: test.length, retainedBytes: JSON.stringify(rows).length * 2,
    provenance: rows.some((r) => r.source === 'ordinary_consented') ? 'includes_ordinary_consented' : 'synthetic_only',
    initialPredictor: { version: 'synthetic-initial-v1', units: 'window_basis_points', portableToOtherSubscriptions: false, productionEligible: false },
    methods: methods(), byCohort: {}, outcomes: { completed: 0, failed: 0, cancelled: 0, depletedIntervals: 0, simulated: rows.every((r) => r.source === 'synthetic') },
    verdict: 'retain_non_ml', reasons: [],
  };
  const scores = new Map<AdaptiveMetrics, { absolute: number; signed: number; covered: number; times: number[] }>();
  for (const row of test) {
    report.outcomes[row.outcome]++;
    if (row.endUsedBp >= 10000) report.outcomes.depletedIntervals++;
    const cohort = report.byCohort[key(row)] ??= methods();
    for (const method of Object.keys(report.methods) as AdaptiveMethod[]) {
      const start = clock();
      const prediction = predict(method, train, row);
      const elapsed = Math.max(0, clock() - start);
      const bounded = elapsed <= ADAPTIVE_RESEARCH_POLICY.maxLatencyMs && validAdaptiveBand(prediction) ? prediction : undefined;
      for (const metric of [report.methods[method], cohort[method]]) {
        const s = scores.get(metric) ?? { absolute: 0, signed: 0, covered: 0, times: [] };
        scores.set(metric, s); s.times.push(elapsed);
        if (!bounded) { metric.unavailable++; continue; }
        metric.evaluated++;
        const error = row.remainingBp - bounded.meanBp;
        s.absolute += Math.abs(error); s.signed += error;
        if (row.remainingBp >= bounded.lowerBp && row.remainingBp <= bounded.upperBp) s.covered++;
      }
    }
  }
  for (const [metric, s] of scores) {
    if (metric.evaluated) { metric.maeBp = s.absolute / metric.evaluated; metric.biasBp = s.signed / metric.evaluated; metric.coverage = s.covered / metric.evaluated; }
    metric.p95LatencyMs = quantile(s.times, 0.95);
  }
  const baseline = report.methods.cohort, learned = report.methods.device_linear;
  const realTest = test.filter((r) => r.source === 'ordinary_consented').length;
  if (realTest < ADAPTIVE_RESEARCH_POLICY.minRealHeldOut) report.reasons.push('insufficient_ordinary_consented_held_out_evidence');
  if (baseline.maeBp === null || learned.maeBp === null || learned.maeBp > baseline.maeBp * (1 - ADAPTIVE_RESEARCH_POLICY.minImprovement)) report.reasons.push('accuracy_benefit_not_demonstrated');
  if (learned.coverage === null || learned.coverage < ADAPTIVE_RESEARCH_POLICY.minCoverage) report.reasons.push('coverage_below_target');
  if (learned.evaluated < baseline.evaluated) report.reasons.push('availability_fairness_regression');
  if (learned.p95LatencyMs > ADAPTIVE_RESEARCH_POLICY.maxLatencyMs) report.reasons.push('latency_budget');
  report.reasons.push('no_production_qualification_or_portable_shipped_prior');
  return report;
}

export function validAdaptiveBand(value: AdaptiveBand | undefined): value is AdaptiveBand {
  return !!value && [value.meanBp, value.lowerBp, value.upperBp].every((n) => finite(n) && n <= 10000)
    && value.lowerBp <= value.meanBp && value.meanBp <= value.upperBp;
}
/** Immediate bounded fallback. No learned inference is invoked on the production path. */
export function adaptiveFallback(stage3: AdaptiveBand | undefined, evidence: { fresh: boolean; inDistribution: boolean; elapsedMs: number; failed?: boolean }): { source: 'stage1' | 'stage3'; band?: AdaptiveBand } {
  return evidence.fresh && evidence.inDistribution && !evidence.failed && finite(evidence.elapsedMs)
    && evidence.elapsedMs <= ADAPTIVE_RESEARCH_POLICY.maxLatencyMs && validAdaptiveBand(stage3)
    ? { source: 'stage3', band: { meanBp: stage3.meanBp, lowerBp: stage3.lowerBp, upperBp: stage3.upperBp } } : { source: 'stage1' };
}
