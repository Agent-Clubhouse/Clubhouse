import { describe, expect, it } from 'vitest';
import { AUTO_WEEK_MS, decideAutoProvider, tieSetKey, type AutoCandidate, type AutoPolicyInput } from './helper-auto-policy';

const NOW = 1_800_000_000_000;
const A = 'claude-code:default';
const B = 'codex-cli:default';

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
