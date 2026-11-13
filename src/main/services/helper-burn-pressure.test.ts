import { describe, expect, it } from 'vitest';
import { preparePressure, observePressure, qualifyPressure, readPressure, readPressureOutcome, type PressureEntry } from './helper-burn-pressure';
import { decideAutoProvider, type AutoCandidate } from './helper-auto-policy';
import type { DecisionQuota } from '../../shared/telemetry/helper-usage-contract';
import type { QuotaView } from '../../shared/helper-routing';

const T = 1_800_000_000_000, MIN = 60_000, RESET = T + 7 * 24 * 60 * MIN;
const revision = '11111111-1111-4111-8111-111111111111';
const plan = { plan: 'pro' as const, generation: revision };
function entry(id: string, now: number, provider = 'claude-code'): PressureEntry {
  return { decisionId: id, decidedAtMs: now, provider, model: 'model-v1', effort: 'high', difficulty: 'hard',
    calibration: { model: 'model-v1', revision }, taskProfile: 'implementation' };
}
function quota(now: number, usedBp = 1000): DecisionQuota {
  return { quality: 'fresh', state: 'known', source: 'cli_query', asOfMs: now, windows: [
    { name: 'weekly', usedBp, resetsAtMs: RESET }, { name: 'fiveHour', usedBp, resetsAtMs: RESET },
  ] };
}
function view(now: number, usedBp = 1200, reset = RESET): QuotaView {
  const window = { usedPercent: usedBp / 100, resetsAt: new Date(reset).toISOString() };
  return { state: 'known', source: 'cli_query', asOf: new Date(now).toISOString(), weekly: window, fiveHour: window };
}
/** Synthetic subscription groups only: the 200bp label is measured ONCE for both overlapping members. */
function replay(burns = Array(40).fill(200) as number[], provider = 'claude-code', overlap = true, windows: 'both' | 'weekly' = 'both'): PressureEntry[] {
  const history: PressureEntry[] = [];
  burns.forEach((burn, i) => {
    const now = T + i * 10 * MIN;
    if (overlap) history.push({ ...entry(`active-${provider}-${i}`, now - 2 * MIN, provider),
      forecastRun: { startedMs: now - 2 * MIN, usageSamples: 1, usable: true } });
    const proposed = entry(`next-${provider}-${i}`, now, provider);
    const baseline = quota(now);
    if (windows === 'weekly') baseline.windows = baseline.windows!.filter((w) => w.name === 'weekly');
    proposed.pressure = preparePressure(proposed, history, overlap ? 1 : 0, baseline, now, plan)!;
    proposed.forecastRun = { startedMs: now, endedMs: now + MIN, usageSamples: 1, usable: true };
    history.push(proposed);
    if (overlap) history.at(-2)!.forecastRun!.endedMs = now + MIN;
    proposed.pressureOutcome = observePressure(proposed.pressure, history, view(now + MIN, 1000 + burn), now + MIN, plan)!;
  });
  return history;
}
function candidate(key: string, usedPercent: number, burn?: number, upper?: number): AutoCandidate {
  return { key, provider: key, quotaState: 'known', verified: true, load: 0,
    weekly: { usedPercent, resetsAtMs: RESET }, expectedBurnBp: burn,
    ...(upper !== undefined && { remainingPressure: [{ usedBp: usedPercent * 100, upperBp: upper }] }) };
}

describe('qualified aggregate remaining burn', () => {
  it('chronologically qualifies exact group/model/profile means and intervals without counting past burn twice', () => {
    const history = replay();
    const samples = history.filter((e) => e.pressure);
    expect(samples.slice(0, 28).every((e) => !e.pressure!.windows[0].band)).toBe(true);
    const receipt = samples.at(-1)!.pressure!;
    expect(receipt.windows[0].band).toMatchObject({ meanBp: 200, lowerBp: 200, upperBp: 200, maeBp: 0, biasBp: 0, coverageBp: 10_000 });
    expect(receipt.members).toHaveLength(2);
    expect(samples.at(-1)!.pressureOutcome).toMatchObject({ attribution: 'subscription_group_with_unknown_residual', windows: [{ name: 'weekly', remainingBp: 200 }, { name: 'fiveHour', remainingBp: 200 }] });
    // Latest quota already includes partial burn: changing it does not add the completed portion back.
    const active = { ...entry('active-new', T + 500 * MIN - 2 * MIN), forecastRun: { startedMs: T + 498 * MIN, usageSamples: 1, usable: true } };
    const prediction = preparePressure(entry('new', T + 500 * MIN), [...history, active], 1, quota(T + 500 * MIN, 6000), T + 500 * MIN, plan)!;
    expect(prediction.windows[0]).toMatchObject({ usedBp: 6000, band: { meanBp: 200 } });
  });
  it('uses qualified mean for balancing and upper bounds for short-window admission', () => {
    const a = candidate('a', 40, 800, 1000), b = candidate('b', 42, 100, 200);
    const decide = (candidates: AutoCandidate[], useBurnForecasts: boolean) => decideAutoProvider({ now: T, candidates, cursors: {}, options: { useBurnForecasts } });
    expect(decide([a, b], false)).toMatchObject({ ok: true, key: 'a' });
    expect(decide([a, b], true)).toMatchObject({ ok: true, key: 'b' });
    expect(decide([a, { ...b, expectedBurnBp: undefined }], true)).toMatchObject({ ok: true, key: 'a' });
    a.remainingPressure!.push({ usedBp: 9300, upperBp: 300 });
    expect(decide([a], true)).toMatchObject({ ok: false, evaluations: [{ excluded: 'quota_near_limit' }] });
    expect(decide([a], false)).toMatchObject({ ok: true });
  });
  it('falls back entirely when any applicable supported window lacks valid baseline/reset coverage', () => {
    const history = replay(Array(40).fill(200), 'claude-code', false, 'weekly'), now = T + 500 * MIN;
    const baseline = quota(now, 9300);
    baseline.windows = baseline.windows!.filter((w) => w.name === 'weekly');
    expect(preparePressure(entry('new', now), history, 0, baseline, now, plan)?.windows[0].band).toBeDefined();
    for (const invalid of [{ usedBp: 100 }, { usedBp: 100, resetsAtMs: NaN }, { usedBp: 100, resetsAtMs: now },
      { resetsAtMs: RESET }, { usedBp: NaN, resetsAtMs: RESET }]) {
      const pressure = preparePressure(entry('new', now), history, 0, { ...baseline,
        windows: [...baseline.windows!, { name: 'fiveHour', ...invalid }] }, now, plan);
      expect(pressure).toBeUndefined();
      // No upper-bound input may wrongly refuse this otherwise usable sole provider.
      const weekly = pressure?.windows.find((w) => w.name === 'weekly')?.band;
      expect(decideAutoProvider({ now, candidates: [candidate('only', 93, weekly?.meanBp, weekly?.upperBp)], cursors: {}, options: { useBurnForecasts: true } }))
        .toMatchObject({ ok: true, key: 'only' });
    }
  });

  it('requalifies after definitively unstarted settled helpers without forgetting pending/unknown or actual runs', () => {
    const history = replay(Array(40).fill(200), 'claude-code', false);
    const settled = ['creation_refused', 'cancelled', 'spawn_failed', 'left_asleep'].map((spawn) => ({ ...entry(`old-${spawn}`, T - MIN), spawn }));
    const all = [...settled, ...history];
    for (const e of history) {
      const at = e.decidedAtMs + 2 * MIN;
      e.pressureOutcome = observePressure(e.pressure!, all, view(at), at, plan);
      expect(e.pressureOutcome?.reason).toBe('observed');
    }
    const now = T + 500 * MIN;
    expect(preparePressure(entry('fresh', now), all, 0, quota(now), now, plan)?.windows[0].band).toBeDefined();
    const sample = history.at(-1)!.pressure!, observedAt = sample.atMs + 2 * MIN;
    for (const spawn of [undefined, 'started', 'orphaned', 'unknown_result']) {
      const unknown = { ...entry(`uncertain-${spawn}`, T - MIN), spawn };
      expect(observePressure(sample, [...all, unknown], view(observedAt), observedAt, plan)?.reason).toBe('additional_run');
    }
    const actualFailed = { ...entry('failed-after-session', sample.asOfMs - 1), spawn: 'spawn_failed',
      forecastRun: { startedMs: sample.asOfMs - 1, endedMs: sample.asOfMs + MIN, usageSamples: 0, usable: false } };
    expect(observePressure(sample, [...all, actualFailed], view(observedAt), observedAt, plan)?.reason).toBe('additional_run');
  });

  it('includes an atomic pending start with confirmed identity once, and never invents a missing reservation identity', () => {
    const now = T + MIN;
    const pending = entry('pending', now);
    const p = preparePressure(entry('next', now), [pending], 1, quota(now), now, plan)!;
    expect(p.members.map((m) => m.decisionId)).toEqual(['pending', 'next']);
    expect(preparePressure(entry('next', now), [pending], 2, quota(now), now, plan)).toBeUndefined();
    expect(preparePressure(entry('next', now), [{ ...pending, calibration: undefined }], 1, quota(now), now, plan)).toBeUndefined();
    expect(preparePressure(entry('next', now), [], 0, quota(now), now)).toBeUndefined();
    expect(p.windows[0].band).toBeUndefined();
  });

  it('demonstrates recency weighting improves chronological replay of changing observed demand', () => {
    const history = replay([...Array(8).fill(100), ...Array(8).fill(120), ...Array(24).fill(140)]);
    const samples = history.filter((e) => e.pressureOutcome?.reason === 'observed');
    const band = qualifyPressure(history, samples[0].pressure!.key, 'weekly', T + 500 * MIN)!;
    const unweightedErrors = samples.slice(8).map((e, i) => {
      const earlier = samples.slice(0, i + 8).map((r) => r.pressureOutcome!.windows[0].remainingBp);
      return Math.abs(e.pressureOutcome!.windows[0].remainingBp - Math.round(earlier.reduce((a, b) => a + b, 0) / earlier.length));
    });
    expect(band).toBeDefined();
    expect(band.maeBp).toBeLessThan(unweightedErrors.reduce((a, b) => a + b, 0) / unweightedErrors.length);
  });

  it('keeps future and delayed labels out, and rolls back immediately on outside bursts/drift', () => {
    const history = replay();
    const p = history.at(-1)!.pressure!;
    expect(qualifyPressure(history, p.key, 'weekly', T + 500 * MIN)).toBeDefined();
    const delayed = structuredClone(history);
    for (const e of delayed) if (e.pressureOutcome) e.pressureOutcome.availableAtMs = T + 600 * MIN;
    expect(qualifyPressure(delayed, p.key, 'weekly', T + 500 * MIN)).toBeUndefined();
    const burst = replay([...Array(39).fill(200), 1200]);
    expect(qualifyPressure(burst, p.key, 'weekly', T + 500 * MIN)).toBeUndefined();
    const noisy = replay(Array.from({ length: 40 }, (_, i) => i % 2 ? 1800 : 100));
    expect(qualifyPressure(noisy, p.key, 'weekly', T + 500 * MIN)).toBeUndefined();
  });
  it('fails cold on affected generations, effort/profile/model changes, missing identity and unsupported load', () => {
    const history = replay(Array(40).fill(200), 'claude-code', false), now = T + 500 * MIN;
    for (const patch of [{ model: null }, { effort: 'xhigh' }, { taskProfile: 'review' as const },
      { model: 'alias' }, { calibration: undefined }, { calibration: { model: 'model-v1', revision: '22222222-2222-4222-8222-222222222222' } }]) {
      const p = preparePressure({ ...entry('new', now), ...patch }, history, 0, quota(now), now, plan);
      expect(p?.windows[0].band).toBeUndefined();
    }
    expect(preparePressure(entry('new', now), history, 1, quota(now), now, plan)).toBeUndefined();
    expect(preparePressure(entry('new', now), history, 0, quota(now - 60 * MIN), now, plan)).toBeUndefined();
    const reset = quota(now); reset.windows![0].resetsAtMs! += MIN;
    expect(preparePressure(entry('new', now), history, 0, reset, now, plan)?.windows[0].band).toBeUndefined();
  });
  it('excludes reset crossings, extra starts, failed/cancelled/partial sessions and incomplete observations', () => {
    const history = replay([200], 'claude-code', false), e = history[0], p = e.pressure!;
    expect(observePressure(p, history, view(T + 2 * MIN, 1200, RESET + MIN), T + 2 * MIN, plan)?.reason).toBe('reset');
    expect(observePressure(p, history, view(T + 2 * MIN, 500), T + 2 * MIN, plan)?.reason).toBe('decreased');
    const extra = { ...entry('outside-helper', T), forecastRun: { startedMs: T, endedMs: T + MIN, usageSamples: 1, usable: true } };
    expect(observePressure(p, [...history, extra], view(T + 2 * MIN), T + 2 * MIN, plan)?.reason).toBe('additional_run');
    e.forecastRun!.usable = false;
    expect(observePressure(p, history, view(T + 2 * MIN), T + 2 * MIN, plan)?.reason).toBe('incomplete');
    e.forecastRun!.usable = true; e.forecastRun!.endedMs = undefined;
    expect(observePressure(p, history, view(T + 2 * MIN), T + 2 * MIN, plan)).toBeUndefined();
  });
  it('reports separate exact-provider cohorts and retains closed, bounded immutable receipts', () => {
    for (const provider of ['claude-code', 'codex-cli']) {
      const history = replay(Array(40).fill(provider === 'claude-code' ? 200 : 600), provider);
      const p = history.at(-1)!.pressure!;
      expect(readPressure({ ...p, taskText: 'must disappear' })).toEqual(p);
      expect(readPressure({ ...p, members: Array(9).fill(p.members[0]) })).toBeUndefined();
      expect(readPressure({ ...p, version: 2 })).toBeUndefined();
      expect(readPressureOutcome({ ...history.at(-1)!.pressureOutcome, secret: 'drop' })).toEqual(history.at(-1)!.pressureOutcome);
      expect(p.windows[0].band?.maeBp).toBe(0);
    }
  });
});
