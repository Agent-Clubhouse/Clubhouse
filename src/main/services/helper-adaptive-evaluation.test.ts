import { describe, expect, it } from 'vitest';
import { ADAPTIVE_MODEL_ENABLED, ADAPTIVE_RESEARCH_POLICY, adaptiveFallback, evaluateAdaptiveEvidence, retainAdaptiveEvidence } from './helper-adaptive-evaluation';
import { ADAPTIVE_FIXTURE_START, adaptiveEvidenceFixture } from './__fixtures__/helper-adaptive-evidence';
const NOW = ADAPTIVE_FIXTURE_START + 500 * 60_000;

describe('stage 4 local adaptive evaluation', () => {
  it('prefers transparent cohorts on stationary held-out profiles and retains the non-ML production policy', () => {
    const report = evaluateAdaptiveEvidence(adaptiveEvidenceFixture(), NOW, () => 0);
    expect(report).toMatchObject({ train: 240, test: 160, provenance: 'synthetic_only', verdict: 'retain_non_ml',
      methods: { stage1: { evaluated: 0, unavailable: 160, maeBp: null }, cohort: { evaluated: 160, maeBp: 0, biasBp: 0, coverage: 1 } } });
    expect(report.initialPredictor).toMatchObject({ units: 'window_basis_points', portableToOtherSubscriptions: false, productionEligible: false });
    expect(report.reasons).toContain('insufficient_ordinary_consented_held_out_evidence');
    expect(ADAPTIVE_MODEL_ENABLED).toBe(false);
    expect(Object.keys(report.byCohort)).toHaveLength(2);
  });
  it('does not mistake a synthetic learned improvement for qualification on a real subscription', () => {
    const report = evaluateAdaptiveEvidence(adaptiveEvidenceFixture('linear'), NOW, () => 0);
    expect(report.methods.device_linear.maeBp).toBeLessThan(report.methods.cohort.maeBp!);
    expect(report.verdict).toBe('retain_non_ml');
    expect(report.reasons).toContain('insufficient_ordinary_consented_held_out_evidence');
  });
  it.each(['reset', 'upgrade', 'sparse'] as const)('falls cold on %s cohorts without transferring other subscriptions/models', (scenario) => {
    const report = evaluateAdaptiveEvidence(adaptiveEvidenceFixture(scenario), NOW, () => 0);
    expect(report.methods.device_linear).toMatchObject({ evaluated: 0, unavailable: 160, maeBp: null, coverage: null });
    expect(report.methods.cohort.evaluated).toBe(0);
  });
  it('detects drift on outside bursts and includes failures/cancellations/depletion as factual simulated outcomes', () => {
    const report = evaluateAdaptiveEvidence(adaptiveEvidenceFixture('outside'), NOW, () => 0);
    expect(report.methods.device_linear.coverage).toBeLessThan(0.9);
    expect(report.reasons).toContain('coverage_below_target');
    expect(report.outcomes.simulated).toBe(true);
    expect(report.outcomes.failed).toBeGreaterThan(0);
    expect(report.outcomes.cancelled).toBeGreaterThan(0);
    expect(report.outcomes.depletedIntervals).toBeGreaterThan(0);
  });
  it('excludes delayed/equal-time labels from earlier fits and never trains on the chronological holdout', () => {
    const rows = adaptiveEvidenceFixture('linear');
    for (const r of rows.slice(0, 240)) r.availableAtMs = NOW - 1;
    const report = evaluateAdaptiveEvidence(rows, NOW, () => 0);
    expect(report.methods.device_linear.evaluated).toBe(0);
    expect(report.methods.cohort.evaluated).toBe(0);
    const baseline = adaptiveEvidenceFixture('linear');
    const before = evaluateAdaptiveEvidence(baseline, NOW, () => 0);
    const changed = structuredClone(baseline);
    // Changing later held-out targets cannot alter the fitted predictions: it changes only their signed scoring error.
    for (const r of changed.slice(240)) r.remainingBp += 1;
    const after = evaluateAdaptiveEvidence(changed, NOW, () => 0);
    expect(after.methods.device_linear.biasBp! - before.methods.device_linear.biasBp!).toBeCloseTo(1);
  });
  it('bounds storage, strips content/paths/secrets and rejects missing/partial or foreign evidence', () => {
    const row = adaptiveEvidenceFixture()[0];
    const clean = retainAdaptiveEvidence([{ ...row, prompt: 'private', path: 'private', secret: 'private' }], NOW);
    expect(clean).toEqual([row]);
    expect(retainAdaptiveEvidence([{ ...row, schemaVersion: 2 }, { ...row, availableAtMs: undefined }, { ...row, profile: 'free text' }, { ...row, elapsedMs: Infinity }], NOW)).toEqual([]);
    const many = Array.from({ length: 1000 }, (_, i) => ({ ...row, id: String(i), atMs: row.atMs + i }));
    const bounded = retainAdaptiveEvidence(many, NOW);
    expect(bounded).toHaveLength(ADAPTIVE_RESEARCH_POLICY.maxRows);
    expect(JSON.stringify(bounded).length * 2).toBeLessThanOrEqual(ADAPTIVE_RESEARCH_POLICY.maxBytes);
    expect(retainAdaptiveEvidence([row], NOW + ADAPTIVE_RESEARCH_POLICY.retentionMs)).toEqual([]);
  });
  it('rejects excessive latency and returns a bounded stage-3 or immediate stage-1 fallback for every failure', () => {
    let clock = 0;
    const report = evaluateAdaptiveEvidence(adaptiveEvidenceFixture(), NOW, () => (clock += 11));
    expect(report.methods.device_linear.evaluated).toBe(0);
    const band = { meanBp: 200, lowerBp: 100, upperBp: 300 };
    expect(adaptiveFallback(band, { fresh: true, inDistribution: true, elapsedMs: 1 })).toEqual({ source: 'stage3', band });
    for (const evidence of [{ fresh: false, inDistribution: true, elapsedMs: 1 }, { fresh: true, inDistribution: false, elapsedMs: 1 },
      { fresh: true, inDistribution: true, elapsedMs: 11 }, { fresh: true, inDistribution: true, elapsedMs: NaN },
      { fresh: true, inDistribution: true, elapsedMs: 1, failed: true }]) expect(adaptiveFallback(band, evidence)).toEqual({ source: 'stage1' });
    for (const invalid of [undefined, { meanBp: 20000, lowerBp: 0, upperBp: 100 }, { meanBp: 20, lowerBp: 30, upperBp: 40 }]) {
      expect(adaptiveFallback(invalid, { fresh: true, inDistribution: true, elapsedMs: 1 })).toEqual({ source: 'stage1' });
    }
  });
});
