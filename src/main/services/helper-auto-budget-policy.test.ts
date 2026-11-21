import { describe, expect, it } from 'vitest';
import { defaultAutoBudgetPolicy, type AutoBudgetRules } from '../../shared/helper-auto-budget';
import { classifyQuota, QUOTA_STALE_MS } from '../../shared/helper-routing';
import { decideAutoProvider, tieSetKey, type AutoCandidate, type AutoPolicyInput } from './helper-auto-policy';

const NOW = 1_800_000_000_000, HOUR = 3_600_000;
const A = 'claude-code', B = 'codex-cli';
const rules = (): AutoBudgetRules => ({ mode: 'reset_aware', reserves: defaultAutoBudgetPolicy().reserves });
function candidate(provider = A, used = 82, hours: number | null = 24): AutoCandidate {
  return { key: provider, provider, verified: true, load: 0,
    quotaState: used >= 95 ? 'near_limit' : used >= 80 ? 'low' : 'known',
    weekly: { usedPercent: used, resetsAtMs: hours === null ? null : NOW + hours * HOUR },
    budgetQuota: { complete: true, asOfMs: NOW, windows: [
      { name: 'weekly', usedBp: Math.round(used * 100), ...(hours !== null && { resetsAtMs: NOW + hours * HOUR }) },
      { name: 'fiveHour', usedBp: 1000, resetsAtMs: NOW + 5 * HOUR },
    ] } };
}
function forecast(c: AutoCandidate, mean: number, upper = mean): AutoCandidate {
  return { ...c, expectedBurnBp: mean, remainingPressure: c.budgetQuota!.windows.map((w) => ({
    name: w.name, usedBp: w.usedBp!, resetsAtMs: w.resetsAtMs, upperBp: w.name === 'weekly' ? upper : 0,
  })) };
}
const copilot = (): AutoCandidate => ({ key: 'copilot-cli', provider: 'copilot-cli', verified: true, load: 0,
  quotaState: 'unknown', quotaUnknownReason: 'not_supported' });
const decide = (candidates: AutoCandidate[], options: AutoPolicyInput['options'] = {}, cursors = {}) =>
  decideAutoProvider({ now: NOW, candidates, cursors, options: { useBurnForecasts: true, budget: rules(), ...options } });

describe('opt-in reset-aware Auto admission and selection', () => {
  it('promotes usable near-reset budget above the old low tier without requiring burn history', () => {
    const candidates = [candidate(), candidate(B, 20, 144)];
    expect(decide(candidates)).toMatchObject({ ok: true, key: A, reason: 'reset_urgency', tier: 'low' });
    expect(decide(candidates).evaluations[0].budget).toMatchObject({ retainedPercent: 10, ceilingBp: 9000,
      usableBp: 800, urgency: 'within_24h', forecast: 'unavailable' });
    expect(decide(candidates, { budget: undefined })).toMatchObject({ ok: true, key: B, reason: 'better_quota_tier' });
  });

  it.each([[24 - 1 / HOUR, 'within_24h'], [24, 'within_24h'], [24 + 1 / HOUR, 'within_48h'],
    [48 - 1 / HOUR, 'within_48h'], [48, 'within_48h'], [48 + 1 / HOUR, 'none']])(
    'uses the authoritative inclusive boundary at %s hours', (hours, urgency) => {
      const result = decide([candidate(A, 82, Number(hours)), candidate(B, 20, 144)]);
      expect(result.evaluations[0].budget?.urgency).toBe(urgency);
      expect(result).toMatchObject({ ok: true, key: urgency === 'none' ? B : A });
    });

  it('AR1: equal urgency/reset uses comparable pressure, then load and rotation across original quota tiers', () => {
    const a = forecast(candidate(), 100), b = forecast(candidate(B, 20, 24), 6800, 6900);
    const result = decide([a, b]);
    expect(result).toMatchObject({ ok: true, key: A, tier: 'low' });
    expect(result.evaluations.map((e) => e.score.pressureBp)).toEqual([8300, 8800]);
    expect(result.evaluations.map((e) => e.budget?.forecast)).toEqual(['qualified', 'qualified']);
    const equal = forecast(candidate(B, 20, 24), 6300, 6400);
    expect(decide([{ ...a, load: 1 }, equal])).toMatchObject({ ok: true, key: B, tie: { byLoad: true } });
    expect(decide([a, equal], {}, { [tieSetKey([A, B])]: A })).toMatchObject({ ok: true, key: B });
  });

  it.each(['A', 'B', 'both', 'disabled'])('falls back to observed weekly pressure for cold/partial coverage (%s)', (cold) => {
    let a = forecast(candidate(), 100), b = forecast(candidate(B, 20, 24), 6800, 6900);
    if (cold === 'A' || cold === 'both') a = { ...a, expectedBurnBp: undefined, remainingPressure: undefined };
    if (cold === 'B' || cold === 'both') b = { ...b, expectedBurnBp: undefined, remainingPressure: undefined };
    const result = decide([a, b], { useBurnForecasts: cold !== 'disabled' });
    expect(result).toMatchObject({ ok: true, key: B });
    expect(result.evaluations.map((e) => e.score.pressureBp)).toEqual([8200, 2000]);
  });

  it('enforces each configurable provider reserve at equality without automatic relaxation', () => {
    const budget: AutoBudgetRules = { mode: 'reset_aware', reserves: { [A]: 12, [B]: 20 } };
    expect(decide([candidate(A, 88, 1), candidate(B, 79.99)], { budget })).toMatchObject({ ok: true, key: B });
    const stopped = decide([candidate(A, 88, 1), candidate(B, 80)], { budget });
    expect(stopped.ok).toBe(false);
    expect(stopped.evaluations.map((e) => [e.excluded, e.budget?.block])).toEqual([
      ['auto_reserve', 'observed_reserve'], ['auto_reserve', 'observed_reserve'],
    ]);
    expect(decide([candidate(A, 87.99, 1)], { budget })).toMatchObject({ ok: true, key: A });
    // Zero and 100 are deliberate user settings; 95% is legacy policy reserve, not provider exhaustion.
    expect(decide([candidate(A, 96)], { budget: { mode: 'reset_aware', reserves: { [A]: 0, [B]: 10 } } })).toMatchObject({ ok: true });
    expect(decide([candidate(A, 0)], { budget: { mode: 'reset_aware', reserves: { [A]: 100, [B]: 10 } } }).ok).toBe(false);
  });

  it('checks every short/model/other window and provider-reported hard limits before urgency', () => {
    for (const name of ['fiveHour', 'model', 'other'] as const) {
      const a = candidate();
      a.budgetQuota!.windows.push({ name, usedBp: 9000 });
      expect(decide([a, candidate(B, 20, 144)])).toMatchObject({ ok: true, key: B });
    }
    const a = candidate(); a.budgetQuota!.windows[0].limitReached = true;
    expect(decide([a, copilot()])).toMatchObject({ ok: true, key: 'copilot-cli' });
    expect(decide([a]).evaluations[0].excluded).toBe('quota_exhausted');
    expect(decide([candidate(A, 100)]).evaluations[0].excluded).toBe('auto_reserve');
  });

  it('admits against one aggregate upper bound and rejects before concurrent/inflight pressure hits reserve', () => {
    expect(decide([forecast(candidate(A, 88), 100, 199)])).toMatchObject({ ok: true });
    const result = decide([forecast(candidate(A, 88), 100, 200)]);
    expect(result).toMatchObject({ ok: false });
    expect(result.evaluations[0].budget).toMatchObject({ block: 'predicted_reserve', forecast: 'qualified' });
    const partial = forecast(candidate(A, 88), 100, 200); partial.remainingPressure!.pop();
    expect(decide([partial])).toMatchObject({ ok: true });
    expect(decide([partial]).evaluations[0].budget?.forecast).toBe('unavailable');
  });

  it('requires fresh complete usage, but missing weekly reset disables only urgency', () => {
    expect(decide([candidate(A, 82, null), candidate(B, 20, 144)])).toMatchObject({ ok: true, key: B });
    expect(decide([candidate(A, 82, null)]).evaluations[0].budget?.urgency).toBe('none');
    for (const patch of [{ asOfMs: NOW - QUOTA_STALE_MS - 1 }, { asOfMs: NOW + 1 }, { complete: false }]) {
      const a = candidate(); Object.assign(a.budgetQuota!, patch);
      expect(decide([a]).evaluations[0].excluded).toBe('quota_incomplete');
    }
    const missing = candidate(); missing.budgetQuota!.windows[0].usedBp = undefined;
    expect(decide([missing]).evaluations[0].excluded).toBe('quota_incomplete');
  });

  it('invalidates expired windows and prior reset-epoch inflight forecasts, rather than inventing reset capacity', () => {
    const expired = classifyQuota([{ name: 'week', usedPercent: 40, resetsAt: NOW, asOf: NOW - 1 },
      { name: '5h', usedPercent: 10, resetsAt: NOW + HOUR, asOf: NOW }], NOW);
    expect(expired.incompleteWindows).toEqual(['weekly']);
    const a = candidate(); a.weekly = undefined;
    a.budgetQuota = { asOfMs: NOW, complete: !expired.incompleteWindows?.length,
      windows: [{ name: 'fiveHour', usedBp: 1000, resetsAtMs: NOW + HOUR }] };
    expect(decide([a]).evaluations[0].excluded).toBe('quota_incomplete');
    // Same percentage and window name cannot transfer a previous epoch's group bound into the new window.
    const newEpoch = forecast(candidate(A, 88), 100, 200);
    newEpoch.remainingPressure![0].resetsAtMs = NOW + 7 * 24 * HOUR;
    expect(decide([newEpoch])).toMatchObject({ ok: true });
    expect(decide([newEpoch]).evaluations[0].budget?.forecast).toBe('unavailable');
  });

  it('keeps unverified urgency and unknown Copilot unscored, and refuses when every candidate is out', () => {
    expect(decide([{ ...candidate(), verified: false }, candidate(B, 20, 144)])).toMatchObject({ ok: true, key: B });
    expect(decide([candidate(A, 89), copilot()])).toMatchObject({ ok: true, key: A });
    const fallback = decide([candidate(A, 90), copilot()]);
    expect(fallback).toMatchObject({ ok: true, key: 'copilot-cli', reason: 'last_resort_unmeasured' });
    expect(fallback.evaluations[1]).toMatchObject({ score: { basis: 'unmeasured' } });
    expect(fallback.evaluations[1].budget).toBeUndefined();
    expect(decide([candidate(A, 90)]).ok).toBe(false);
    expect(decide([candidate(), copilot()], { budget: { mode: 'invalid' } }).ok).toBe(false);
    expect(decide([candidate(), candidate(B, 20, 144)], { budget: { mode: 'reserve_only', reserves: defaultAutoBudgetPolicy().reserves } }))
      .toMatchObject({ ok: true, key: B });
  });
});
