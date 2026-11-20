/** Proposal acceptance examples only; no provider processes, settings writes or paid prompts. */
import { describe, expect, it } from 'vitest';
import { QUOTA_STALE_MS } from '../../shared/helper-routing';
import { decideAutoProvider, tieSetKey, type AutoCandidate, type AutoPolicyInput } from './helper-auto-policy';
import { DAY, HOUR, runReplay, type SimConfig } from './__fixtures__/helper-auto-replay';
import { observedRate, selectReset, weeklySimulationEvidence, type RateSample, type ResetEvidence, type ResetMode, type ResetOptions } from './__fixtures__/helper-reset-replay';

const NOW = 1_800_000_000_000;
const candidate = (key: string, used: number, hours: number | null, extra: Partial<AutoCandidate> = {}): AutoCandidate => ({
  key, provider: key, verified: true, load: 0, quotaState: used >= 95 ? 'near_limit' : used >= 80 ? 'low' : 'known',
  weekly: { usedPercent: used, resetsAtMs: hours === null ? null : NOW + hours * HOUR }, ...extra,
});
const a = (used = 82, hours: number | null = 24) => candidate('A', used, hours);
const b = () => candidate('B', 20, 144);
const copilot = candidate('C', 0, null, { quotaState: 'unknown', quotaUnknownReason: 'not_supported', weekly: undefined });
const input = (candidates: AutoCandidate[]): AutoPolicyInput => ({ now: NOW, candidates, cursors: {} });
const research = (candidates: AutoCandidate[], options: Partial<ResetOptions> = {}) => selectReset(input(candidates), {
  mode: 'bounded_urgency', evidence: weeklySimulationEvidence, ...options,
});
const chosen = (r: ReturnType<typeof research>) => r.decision.ok ? r.decision.key : null;
const pressurePeers = () => [
  candidate('A', 82, 24, { expectedBurnBp: 100, remainingPressure: [{ usedBp: 8200, upperBp: 100 }] }),
  candidate('B', 20, 24, { expectedBurnBp: 6800, remainingPressure: [{ usedBp: 2000, upperBp: 6900 }] }),
];
const assumedZeroRate = (c: AutoCandidate, now: number) => ({ ...weeklySimulationEvidence(c, now)!, rateBpPerHour: 0 });

describe('reset-aware Auto proposal (isolated)', () => {
  it('AR1: equal urgency/reset compares supplied comparable pressure before legacy quota tiers', () => {
    // Supplied qualified-coverage inputs for this discriminator, not a newly qualified model.
    const candidates = pressurePeers();
    const result = selectReset({ ...input(candidates), options: { useBurnForecasts: true } }, {
      mode: 'bounded_urgency', evidence: (c, now) => ({ ...weeklySimulationEvidence(c, now)!, rateBpPerHour: 0 }),
    });
    expect(result.evaluations.every((e) => !e.excluded && e.urgency === 2)).toBe(true);
    process.stdout.write(`AR1_DISCRIMINATOR=${JSON.stringify({ chosen: chosen(result), evaluations: result.decision.evaluations })}\n`);
    expect(chosen(result)).toBe('A');
    expect(result.decision.evaluations.find((e) => e.key === 'A')?.tier).toBe('low');
  });

  it('AR1 controls: preserves legacy ranking and never fabricates cold or partial mean coverage', () => {
    const run = (candidates: AutoCandidate[], mode: ResetMode = 'bounded_urgency', useBurnForecasts = true) =>
      selectReset({ ...input(candidates), options: { useBurnForecasts } }, { mode, evidence: assumedZeroRate });
    expect(chosen(run(pressurePeers(), 'cycle_legacy_tiers'))).toBe('B');
    expect(chosen(run(pressurePeers(), 'bounded_urgency', false))).toBe('B');
    expect(chosen(run(pressurePeers().map((c) => ({ ...c, weekly: { ...c.weekly!, resetsAtMs: NOW + 72 * HOUR } }))))).toBe('B');
    for (const cold of ['A', 'B', 'both']) {
      const candidates = pressurePeers().map((c) => c.key === cold || cold === 'both' ? { ...c, expectedBurnBp: undefined } : c);
      const result = run(candidates);
      expect(chosen(result)).toBe('B');
      expect(result.decision.evaluations.map((e) => e.score.pressureBp)).toEqual([8200, 2000]);
      expect(candidates.find((c) => c.key === (cold === 'both' ? 'A' : cold))!.expectedBurnBp).toBeUndefined();
    }
  });

  it('AR1 controls: equal urgent pressure uses load then the unchanged deterministic rotation', () => {
    const peers = pressurePeers();
    peers[1].expectedBurnBp = 6300;
    peers[1].remainingPressure = [{ usedBp: 2000, upperBp: 6400 }];
    const run = (candidates: AutoCandidate[], cursors: Record<string, string> = {}) => selectReset({
      ...input(candidates), cursors, options: { useBurnForecasts: true },
    }, { mode: 'bounded_urgency', evidence: assumedZeroRate });
    const load = run(peers.map((c) => ({ ...c, load: c.key === 'A' ? 1 : 0 })));
    expect(chosen(load)).toBe('B');
    expect(load.decision.ok && load.decision.tie.byLoad).toBe(true);
    expect(chosen(run(peers))).toBe('A');
    expect(chosen(run(peers, { [tieSetKey(['A', 'B'])]: 'A' }))).toBe('B');
  });

  it('AR1 controls: promotion still requires verified mappings, readable usage and every reserve/window gate', () => {
    for (const patch of [{ verified: false }, { quotaState: 'unknown' as const }, { quotaState: 'near_limit' as const },
      { remainingPressure: [{ usedBp: 8200, upperBp: 800 }] }]) {
      const peers = pressurePeers();
      Object.assign(peers[0], patch);
      expect(chosen(selectReset({ ...input(peers), options: { useBurnForecasts: true } }, {
        mode: 'bounded_urgency', evidence: assumedZeroRate,
      }))).toBe('B');
    }
    const result = selectReset({ ...input(pressurePeers()), options: { useBurnForecasts: true } }, {
      mode: 'bounded_urgency', evidence: (c, now) => ({ ...assumedZeroRate(c, now),
        windows: [...assumedZeroRate(c, now).windows, { name: 'fiveHour', usedBp: c.key === 'A' ? 9000 : 1000 }] }),
    });
    expect(chosen(result)).toBe('B');
    expect(result.evaluations[0].excluded).toBe('auto_reserve');
  });

  it('exposes the tier barrier, then promotes useful low-tier work without crossing its reserve', () => {
    for (const basis of ['weekly_used', 'reset_schedule'] as const) {
      const current = decideAutoProvider({ ...input([a(), b()]), options: { basis } });
      expect(current.ok && current.key).toBe('B');
    }
    expect(chosen(research([a(), b()], { mode: 'cycle_legacy_tiers' }))).toBe('B');
    expect(chosen(research([a(), b()]))).toBe('A');
    expect(chosen(research([a(90), b()]))).toBe('B');
  });

  it.each([
    [24 - 1 / HOUR, 2], [24, 2], [24 + 1 / HOUR, 1],
    [48 - 1 / HOUR, 1], [48, 1], [48 + 1 / HOUR, 0],
  ])('uses inclusive 24/48h boundaries at %s hours', (hours, urgency) => {
    const result = research([a(82, hours), b()]);
    expect(result.evaluations[0].urgency).toBe(urgency);
    expect(chosen(result)).toBe(urgency ? 'A' : 'B');
  });

  it('makes relaxation explicit, weekly-only, bounded and expired at reset', () => {
    expect(chosen(research([a(92), copilot]))).toBe('C');
    const relaxed = research([a(92), copilot], { reserveWithin24hBp: 500 });
    expect(chosen(relaxed)).toBe('A');
    expect(relaxed.evaluations[0].relaxed).toBe(true);
    expect(chosen(research([a(95), copilot], { reserveWithin24hBp: 500 }))).toBe('C');
    expect(chosen(research([a(92, 24 + 1 / HOUR), copilot], { reserveWithin24hBp: 500 }))).toBe('C');
    expect(chosen(research([a(92, 0), copilot], { reserveWithin24hBp: 500 }))).toBe('C');
  });

  it('keeps provider exhaustion and short/model window constraints ahead of urgency and relaxation', () => {
    for (const extra of [
      { name: 'fiveHour' as const, usedBp: 9000, resetsAtMs: NOW + HOUR },
      { name: 'model' as const, usedBp: 7000, limitReached: true },
    ]) {
      const result = research([a(82), b()], { reserveWithin24hBp: 500,
        evidence: (c, now) => { const e = weeklySimulationEvidence(c, now)!; return c.key === 'A' ? { ...e, windows: [...e.windows, extra] } : e; } });
      expect(chosen(result)).toBe('B');
      expect(result.evaluations[0].excluded).toBe(extra.limitReached ? 'provider_limit' : 'auto_reserve');
    }
    const result = research([a(70, 1), copilot], { evidence: (c, now) => ({ ...weeklySimulationEvidence(c, now)!,
      windows: [{ name: 'weekly', usedBp: 7000, resetsAtMs: NOW + HOUR, limitReached: true }] }) });
    expect(result.evaluations[0].excluded).toBe('provider_limit');
    expect(chosen(result)).toBe('C');
    // A percentage alone is never called provider-reported exhaustion.
    expect(research([a(100)]).evaluations[0].excluded).toBe('auto_reserve');
  });

  it('does not turn missing reset, missing usage, stale, future or unreadable evidence into urgency', () => {
    expect(chosen(research([a(82, null), b()]))).toBe('B');
    expect(chosen(research([a(82, 169), b()]))).toBe('B');
    expect(research([a(82, null)]).evaluations[0].sustainableBpPerHour).toBeUndefined();
    for (const edit of [
      (e: ResetEvidence) => ({ ...e, asOfMs: NOW - QUOTA_STALE_MS - 1 }),
      (e: ResetEvidence) => ({ ...e, asOfMs: NOW + 1 }),
      (e: ResetEvidence) => ({ ...e, asOfMs: NaN }),
      (e: ResetEvidence) => ({ ...e, complete: false }),
      (e: ResetEvidence) => ({ ...e, windows: [] as ResetEvidence['windows'] }),
    ]) {
      const result = research([a(82), copilot], { evidence: (c, now) => edit(weeklySimulationEvidence(c, now)!) });
      expect(chosen(result)).toBe('C');
      expect(result.evaluations[0].excluded).toBe('unknown_usage');
    }
    expect(chosen(research([candidate('A', 0, null, { quotaState: 'unknown', weekly: undefined }), copilot]))).toBe('C');
  });

  it('distinguishes unknown pace from a reported zero, and suppresses urgency when whole-login burn is already sufficient', () => {
    const measured = (rate: number) => research([a(82), b()], { evidence: (c, now) => ({ ...weeklySimulationEvidence(c, now)!, rateBpPerHour: rate }) });
    const unknown = research([a(82), b()]);
    expect(unknown.evaluations[0]).toMatchObject({ usableBp: 800, sustainableBpPerHour: 800 / 24, urgency: 2 });
    expect(unknown.evaluations[0].observedBpPerHour).toBeUndefined();
    expect(chosen(measured(0))).toBe('A');
    expect(chosen(measured(100))).toBe('B');
    // Pace comparator requires comparable evidence; unknown is never inserted as zero.
    expect(chosen(research([a(82), b()], { mode: 'pace_deficit' }))).toBe('B');
  });

  it('shows why raw pace deficit and bounded calendar urgency express different product preferences', () => {
    const candidates = [candidate('A', 30, 72), candidate('B', 82, 24)];
    const evidence = (c: AutoCandidate, now: number) => ({ ...weeklySimulationEvidence(c, now)!, rateBpPerHour: 0 });
    // A needs 60/72 pp/hour; B needs 8/24. Raw pace picks A outside the useful-work window.
    expect(chosen(research(candidates, { mode: 'pace_deficit', evidence }))).toBe('A');
    expect(chosen(research(candidates, { mode: 'bounded_urgency', evidence }))).toBe('B');
    // An assumed whole-login rate removes B's urgency; this is not a closed-loop rate observation.
    expect(chosen(research(candidates, { evidence: (c, now) => ({ ...evidence(c, now), rateBpPerHour: c.key === 'B' ? 100 : 0 }) }))).toBe('A');
  });

  it('applies a supplied aggregate upper bound and exposes cold-forecast concurrency overshoot', () => {
    const forecast = (upperBp: number) => research([a(88), b()], { evidence: (c, now) => ({ ...weeklySimulationEvidence(c, now)!,
      windows: [{ name: 'weekly', usedBp: c.weekly!.usedPercent! * 100, resetsAtMs: c.weekly!.resetsAtMs!, upperBp: c.key === 'A' ? upperBp : 0 }] }) });
    expect(chosen(forecast(199))).toBe('A');
    expect(chosen(forecast(200))).toBe('B');
    expect(chosen(forecast(201))).toBe('B');
    expect(chosen(research([a(90 - 0.01)]))).toBe('A');
    expect(chosen(research([a(90)]))).toBeNull();
    // Missing group coverage is observation-only admission, not a zero-burn forecast or guarantee.
    expect(chosen(research([a(88, 24)]))).toBe('A');
    const burst = runReplay({ subscriptions: [{ key: 'A', provider: 'A', capacity: 100, used: 89, resetsAt: NOW + DAY }],
      start: NOW, end: NOW + HOUR, tickMs: HOUR, arrivals: () => 4, work: 1, runMs: HOUR, sampleEveryMs: 0,
      select: (i) => selectReset(i, { mode: 'bounded_urgency', evidence: weeklySimulationEvidence }).decision });
    // Deliberately demonstrates the unqualified-concurrency limitation; load is not consumption.
    expect(burst.minHeadroomPercent).toBe(7);
    expect(burst.refused).toBe(0);
  });

  it('keeps unknown Copilot last, respects its opt-out, and refuses if nothing is eligible', () => {
    expect(chosen(research([a(89), copilot]))).toBe('A');
    const fallback = research([a(90), copilot]);
    expect(chosen(fallback)).toBe('C');
    expect(fallback.decision.ok && fallback.decision.reason).toBe('last_resort_unmeasured');
    expect(fallback.decision.evaluations.find((e) => e.key === 'C')?.score).toEqual({ basis: 'unmeasured' });
    expect(chosen(research([a(90), copilot], { copilotFallback: false }))).toBeNull();
  });

  it('derives a past-only whole-login rate, invalidating resets, identity changes, decreases and sparse evidence', () => {
    const samples: RateSample[] = [6, 4, 2, 0].map((hours, i) => ({ atMs: NOW - hours * HOUR - 1, availableAtMs: NOW - hours * HOUR,
      usedBp: 1000 + i * 200, resetsAtMs: NOW + DAY, identity: 'same-plan-generation' }));
    const valid = samples.map((s) => ({ ...s, availableAtMs: s.availableAtMs - 0.5 }));
    expect(observedRate(valid, NOW)).toBe(100);
    expect(observedRate(samples, NOW)).toBeUndefined(); // equal-time availability is not earlier evidence
    expect(observedRate(valid.slice(1), NOW)).toBeUndefined();
    for (const edit of [
      { resetsAtMs: NOW + 7 * DAY }, { identity: 'other-login' }, { usedBp: 900 }, { atMs: NOW + 1 },
    ]) {
      const changed = structuredClone(valid); Object.assign(changed[2], edit);
      expect(observedRate(changed, NOW)).toBeUndefined();
    }
    const idle = valid.map((s) => ({ ...s, usedBp: 1000 }));
    expect(observedRate(idle, NOW)).toBe(0);
  });

  it('compares identical staggered-reset workloads with high, low and absent useful demand', () => {
    const report: object[] = [];
    for (const demand of ['high', 'low', 'absent'] as const) {
      const base: SimConfig = {
        subscriptions: [
          { key: 'A', provider: 'A', capacity: 100, used: 40, resetsAt: NOW + DAY },
          { key: 'B', provider: 'B', capacity: 100, used: 40, resetsAt: NOW + 6 * DAY },
        ],
        start: NOW, end: NOW + DAY + HOUR, tickMs: HOUR, runMs: HOUR, sampleEveryMs: 0, work: 2.5,
        arrivals: (t) => t >= NOW + DAY || demand === 'absent' ? 0 : demand === 'high' || (t - NOW) % (6 * HOUR) === 0 ? 1 : 0,
      };
      const selectors: Array<{ policy: string; assumedRateBpPerHour?: number; options?: SimConfig['options']; select?: SimConfig['select'] }> = [
        { policy: 'weekly_used' }, { policy: 'reset_schedule', options: { basis: 'reset_schedule' } },
        ...(['cycle_legacy_tiers', 'pace_deficit', 'bounded_urgency'] as ResetMode[]).map((mode) => ({ policy: mode, assumedRateBpPerHour: 25,
          select: (i: AutoPolicyInput) => selectReset(i, { mode, evidence: (c, now) => ({ ...weeklySimulationEvidence(c, now)!, rateBpPerHour: 25 }) }).decision })),
        { policy: 'bounded_relax_24h', select: (i) => selectReset(i, { mode: 'bounded_urgency', reserveWithin24hBp: 500,
          evidence: weeklySimulationEvidence }).decision },
        { policy: 'bounded_relax_24h_rate25', assumedRateBpPerHour: 25,
          select: (i) => selectReset(i, { mode: 'bounded_urgency', reserveWithin24hBp: 500,
            evidence: (c, now) => ({ ...weeklySimulationEvidence(c, now)!, rateBpPerHour: 25 }) }).decision },
        { policy: 'bounded_urgency_unknown_rate', select: (i) => selectReset(i, { mode: 'bounded_urgency', evidence: weeklySimulationEvidence }).decision },
      ];
      const results = selectors.map(({ policy, assumedRateBpPerHour, ...selector }) => {
        const r = runReplay({ ...base, ...selector });
        const requested = demand === 'high' ? 24 : demand === 'low' ? 4 : 0;
        expect(r.refused).toBe(0);
        expect(r.sequence).toHaveLength(requested);
        expect(r.exhaustedAt).toEqual({});
        return { demand, policy, assumedRateBpPerHour: assumedRateBpPerHour ?? null,
          requested, accepted: r.sequence.length, refused: r.refused, picks: r.picks,
          unusedA: r.unusedAtReset.A[0], minHeadroom: r.minHeadroomPercent };
      });
      const at = (policy: string) => results.find((r) => r.policy === policy)!;
      if (demand === 'high') {
        expect(at('weekly_used').unusedA).toBe(30);
        expect(at('reset_schedule').unusedA).toBe(20);
        expect(at('cycle_legacy_tiers').unusedA).toBe(20);
        expect(at('pace_deficit').unusedA).toBe(10);
        expect(at('bounded_urgency').unusedA).toBe(10);
        expect(at('bounded_relax_24h').unusedA).toBe(5);
        expect(at('bounded_relax_24h_rate25').unusedA).toBe(5);
        expect(at('bounded_urgency_unknown_rate').unusedA).toBe(10);
      }
      for (const [normal, relaxed] of [
        ['bounded_urgency', 'bounded_relax_24h_rate25'], ['bounded_urgency_unknown_rate', 'bounded_relax_24h'],
      ]) {
        expect(at(normal).assumedRateBpPerHour).toBe(at(relaxed).assumedRateBpPerHour);
        expect(at(normal).requested).toBe(at(relaxed).requested);
        expect(at(normal).unusedA - at(relaxed).unusedA).toBe(demand === 'high' ? 5 : 0);
      }
      if (demand === 'absent') expect(results.every((r) => r.accepted === 0 && r.unusedA === 60)).toBe(true);
      report.push(...results);
    }
    expect(report).toHaveLength(24);
    process.stdout.write(`RESET_REPLAY_REPORT=${JSON.stringify(report)}\n`);
  });
});
