import { describe, expect, it } from 'vitest';
import { AUTO_USE_BURN_FORECASTS, AUTO_WEEK_MS, decideAutoProvider, tieSetKey, type AutoCandidate, type AutoPolicyInput } from './helper-auto-policy';

const NOW = 1_800_000_000_000;
const A = 'claude-code:default';
const B = 'codex-cli:default';
const C = 'copilot-cli:default';

function cand(key: string, used: number | null, extra: Partial<AutoCandidate> = {}): AutoCandidate {
  return {
    key,
    provider: key.split(':')[0],
    quotaState: used === null ? 'unknown' : used >= 95 ? 'near_limit' : used >= 80 ? 'low' : 'known',
    ...(used !== null && { weekly: { usedPercent: used, resetsAtMs: NOW + 3 * 24 * 3_600_000 } }),
    verified: true,
    load: 0,
    ...extra,
  };
}

function decide(candidates: AutoCandidate[], rest: Partial<AutoPolicyInput> = {}) {
  return decideAutoProvider({ now: NOW, candidates, cursors: {}, ...rest });
}

describe('decideAutoProvider', () => {
  it('ignores every forecast byte when the internal experiment is off, including by default', () => {
    expect(AUTO_USE_BURN_FORECASTS).toBe(false);
    const candidates = [cand(A, 10), cand(B, 20), cand(C, null, { quotaUnknownReason: 'not_supported' })];
    const expected = JSON.stringify(decide(candidates));
    const predicted = candidates.map((c, i) => ({ ...c, expectedBurnBp: i === 0 ? 9000 : 0 }));
    expect(JSON.stringify(decide(predicted))).toBe(expected);
    expect(JSON.stringify(decide(predicted, { options: { useBurnForecasts: false } }))).toBe(expected);
    expect(decide(predicted, { options: { useBurnForecasts: true } })).toMatchObject({ ok: true, key: B });
  });

  it('lower weekly use wins, whatever the order and the helper count', () => {
    for (const candidates of [[cand(A, 40, { load: 0 }), cand(B, 20, { load: 5 })], [cand(B, 20, { load: 5 }), cand(A, 40, { load: 0 })]]) {
      expect(decide(candidates)).toMatchObject({ ok: true, key: B, reason: 'lower_pressure', basis: 'weekly_used' });
    }
  });

  it('equal readings tie, and the rotation takes the one after the last chosen', () => {
    const first = decide([cand(A, 30), cand(B, 30)]);
    expect(first).toMatchObject({ ok: true, key: A, reason: 'fair_rotation', tie: { set: [A, B], cursorKey: tieSetKey([A, B]), cursorAfter: A } });
    expect(first.ok && first.tie.cursorBefore).toBeUndefined();
    const second = decide([cand(B, 30), cand(A, 30)], { cursors: { [tieSetKey([A, B])]: A } });
    expect(second).toMatchObject({ ok: true, key: B, tie: { cursorBefore: A, cursorAfter: B } });
  });

  it('among a tie, the lighter one wins before the rotation is asked', () => {
    expect(decide([cand(A, 30, { load: 2 }), cand(B, 30, { load: 1 })], { cursors: { [tieSetKey([A, B])]: B } }))
      .toMatchObject({ ok: true, key: B, reason: 'lower_load', tie: { byLoad: true } });
  });

  it('a tie band widens what ties', () => {
    expect(decide([cand(A, 30), cand(B, 33)], { options: { tieBandBp: 500 } })).toMatchObject({ ok: true, reason: 'fair_rotation', tie: { set: [A, B], bandBp: 500 } });
    expect(decide([cand(A, 30), cand(B, 33)])).toMatchObject({ ok: true, key: A, reason: 'lower_pressure' });
  });

  it('exhausted and near the limit are out, and with nothing left it refuses', () => {
    const decision = decide([cand(A, 97), cand(B, 50, { quotaState: 'exhausted' })]);
    expect(decision.ok).toBe(false);
    expect(decision.evaluations.map((e) => e.excluded)).toEqual(['quota_near_limit', 'quota_exhausted']);
  });

  it('a window past the low mark (5-hour or the model\'s) ranks behind headroom, without adding to the weekly figure', () => {
    // A's weekly is lower, but its 5-hour window made it `low`.
    expect(decide([cand(A, 10, { quotaState: 'low' }), cand(B, 60)])).toMatchObject({ ok: true, key: B, reason: 'better_quota_tier' });
  });

  it('unknown is never scored: it waits behind measured headroom, and goes ahead of a low one', () => {
    const headroom = decide([cand(A, 70), cand(B, null)]);
    expect(headroom).toMatchObject({ ok: true, key: A, reason: 'better_quota_tier' });
    expect(headroom.evaluations.find((e) => e.key === B)).toMatchObject({ tier: 'unmeasured', score: { basis: 'unmeasured' } });
    expect(headroom.evaluations.find((e) => e.key === B)!.score.pressureBp).toBeUndefined();
    expect(decide([cand(A, 85), cand(B, null)])).toMatchObject({ ok: true, key: B, reason: 'unknown_fallback', tier: 'unmeasured' });
  });

  it('only unknowns: they rotate', () => {
    const cursors: Record<string, string> = {};
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const d = decide([cand(A, null), cand(B, null)], { cursors });
      if (!d.ok) throw new Error('refused');
      cursors[d.tie.cursorKey!] = d.tie.cursorAfter!;
      picks.push(d.key);
    }
    expect(picks).toEqual([A, B, A, B]);
  });

  it.each([
    ['headroom', cand(A, 79, { verified: false, load: 100 })],
    ['low', cand(A, 94, { verified: false, load: 100 })],
    ['read failed', cand(A, null, { quotaUnknownReason: 'read_failed', verified: false, load: 100 })],
    ['stale', cand(A, null, { quotaUnknownReason: 'stale', verified: false, load: 100 })],
  ])('unreadable quota never outranks %s, regardless of load, verification or order', (_name, other) => {
    const copilot = cand(C, null, { quotaUnknownReason: 'not_supported' });
    for (const candidates of [[copilot, other], [other, copilot]]) {
      const decision = decide(candidates);
      expect(decision).toMatchObject({ ok: true, key: A });
      expect(decision.evaluations.find((e) => e.key === C)).toEqual({
        key: C, provider: 'copilot-cli', verified: true, load: 0, tier: 'last_resort', rank: 1, score: { basis: 'unmeasured' },
      });
    }
  });

  it('uses the last resort only after exclusions, with an explicit reason even when it is the only candidate', () => {
    const copilot = cand(C, null, { quotaUnknownReason: 'not_supported' });
    for (const candidates of [[copilot], [cand(A, 95), copilot, cand(B, 10, { quotaState: 'exhausted' })]]) {
      expect(decide(candidates)).toMatchObject({ ok: true, key: C, reason: 'last_resort_unmeasured', tier: 'last_resort' });
    }
  });

  it('a mapping that couldn\'t be checked ranks behind one that could', () => {
    expect(decide([cand(A, 10, { verified: false }), cand(B, 50)])).toMatchObject({ ok: true, key: B });
  });

  describe('reset_schedule', () => {
    const reset = (days: number) => ({ resetsAtMs: NOW + days * 24 * 3_600_000 });

    it('prefers the plan that resets sooner, at equal use', () => {
      const d = decide([cand(A, 40, { weekly: { usedPercent: 40, ...reset(1) } }), cand(B, 40, { weekly: { usedPercent: 40, ...reset(6) } })], { options: { basis: 'reset_schedule' } });
      expect(d).toMatchObject({ ok: true, key: A, basis: 'reset_schedule', reason: 'lower_pressure' });
      expect(d.evaluations.find((e) => e.key === A)!.score).toEqual({ basis: 'reset_schedule', weeklyUsedBp: 4000, cyclePhaseBp: 8571, targetBp: 8571, pressureBp: -4571 });
    });

    it('with equal resets, orders as weekly use does', () => {
      const d = decide([cand(A, 40), cand(B, 30)], { options: { basis: 'reset_schedule' } });
      expect(d).toMatchObject({ ok: true, key: B, basis: 'reset_schedule' });
    });

    it('does not require a reset for the last-resort candidate', () => {
      expect(decide([cand(A, 40), cand(C, null, { quotaUnknownReason: 'not_supported' })], { options: { basis: 'reset_schedule' } }))
        .toMatchObject({ ok: true, key: A, basis: 'reset_schedule' });
    });

    it('falls back to weekly use when any measured reset is missing or more than a week out', () => {
      const missing = cand(B, 40, { weekly: { usedPercent: 40, resetsAtMs: null } });
      const tooFar = cand(B, 40, { weekly: { usedPercent: 40, resetsAtMs: NOW + AUTO_WEEK_MS + 1 } });
      const past = cand(B, 40, { weekly: { usedPercent: 40, resetsAtMs: NOW } });
      for (const other of [missing, tooFar, past]) {
        expect(decide([cand(A, 40, { weekly: { usedPercent: 40, ...reset(1) } }), other], { options: { basis: 'reset_schedule' } })).toMatchObject({ basis: 'weekly_used' });
      }
    });
  });

  it('a single candidate is the only one', () => {
    expect(decide([cand(A, 50)])).toMatchObject({ ok: true, key: A, reason: 'only_candidate' });
  });
});
