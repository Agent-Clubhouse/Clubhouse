import { describe, expect, it } from 'vitest';
import { decideAutoProvider, type AutoCandidate } from './helper-auto-policy';

const A = 'claude-code';
const B = 'codex-cli';
const both = (a: AutoCandidate['quotaState'] = 'known', b: AutoCandidate['quotaState'] = 'known'): AutoCandidate[] => [{ provider: A, quotaState: a }, { provider: B, quotaState: b }];

describe('decideAutoProvider', () => {
  it('stays on the orchestrator\'s CLI when nothing argues otherwise', () => {
    expect(decideAutoProvider({ candidates: both(), load: {}, orchestratorCli: B })).toMatchObject({ provider: B, reason: 'default_order' });
  });

  it('with no orchestrator CLI among them, takes registration order', () => {
    expect(decideAutoProvider({ candidates: both(), load: {}, orchestratorCli: 'copilot-cli' })).toMatchObject({ provider: A, reason: 'default_order' });
  });

  it('a margin of one isn\'t enough to leave the anchor, and two is', () => {
    expect(decideAutoProvider({ candidates: both(), load: { [A]: 1 }, orchestratorCli: A })).toMatchObject({ provider: A });
    expect(decideAutoProvider({ candidates: both(), load: { [A]: 2 }, orchestratorCli: A })).toMatchObject({ provider: B, reason: 'lower_load' });
  });

  it('a sticky provider holds the anchor over the orchestrator\'s CLI', () => {
    expect(decideAutoProvider({ candidates: both(), load: { [A]: 1 }, orchestratorCli: A, sticky: B })).toMatchObject({ provider: B, reason: 'sticky' });
  });

  it('a burst doesn\'t all pick the same provider: A A B B B B A, spread within 2', () => {
    const load: Record<string, number> = { [A]: 0, [B]: 0 };
    let sticky: string | undefined;
    const picks: string[] = [];
    for (let i = 0; i < 7; i++) {
      const decision = decideAutoProvider({ candidates: both(), load, orchestratorCli: A, sticky });
      if (decision.ok === false) throw new Error('no provider');
      picks.push(decision.provider === A ? 'A' : 'B');
      load[decision.provider]++;
      sticky = decision.provider;
    }
    expect(picks.join(' ')).toBe('A A B B B B A');
    expect(Math.abs(load[A] - load[B])).toBeLessThanOrEqual(2);
  });

  it('leaves nobody starved under steady load', () => {
    const load: Record<string, number> = { [A]: 0, [B]: 0 };
    let sticky: string | undefined;
    for (let i = 0; i < 50; i++) {
      const decision = decideAutoProvider({ candidates: both(), load, orchestratorCli: A, sticky });
      if (decision.ok === false) throw new Error('no provider');
      load[decision.provider]++;
      sticky = decision.provider;
    }
    expect(load[A]).toBeGreaterThan(20);
    expect(load[B]).toBeGreaterThan(20);
  });

  it('near the limit and exhausted are out, for different stated reasons', () => {
    expect(decideAutoProvider({ candidates: both('near_limit'), load: {}, orchestratorCli: A })).toMatchObject({ provider: B, skipped: { [A]: 'quota_near_limit' } });
    expect(decideAutoProvider({ candidates: both('exhausted'), load: {}, orchestratorCli: A })).toMatchObject({ provider: B, skipped: { [A]: 'quota_exhausted' } });
  });

  it('nothing left is no decision, with each reason', () => {
    expect(decideAutoProvider({ candidates: both('near_limit', 'exhausted'), load: {} })).toEqual({ ok: false, skipped: { [A]: 'quota_near_limit', [B]: 'quota_exhausted' } });
  });

  it('unknown shares the best tier with known, so it isn\'t starved', () => {
    expect(decideAutoProvider({ candidates: both('unknown', 'known'), load: {}, orchestratorCli: A })).toMatchObject({ provider: A });
    expect(decideAutoProvider({ candidates: both('unknown', 'known'), load: { [A]: 2 }, orchestratorCli: A })).toMatchObject({ provider: B });
  });

  it('a worse tier always loses, whatever the load, and the margin doesn\'t apply across tiers', () => {
    expect(decideAutoProvider({ candidates: both('low', 'known'), load: { [B]: 40 }, orchestratorCli: A })).toMatchObject({ provider: B, reason: 'better_quota_tier' });
  });

  it('a sticky provider that fell a tier is released', () => {
    expect(decideAutoProvider({ candidates: both('low', 'known'), load: {}, orchestratorCli: A, sticky: A })).toMatchObject({ provider: B, reason: 'better_quota_tier' });
  });

  it('low is used if nothing better is left, by the same rules', () => {
    expect(decideAutoProvider({ candidates: both('low', 'low'), load: { [A]: 3 }, orchestratorCli: A })).toMatchObject({ provider: B, reason: 'lower_load' });
  });

  it('one candidate is only_candidate', () => {
    expect(decideAutoProvider({ candidates: [{ provider: B, quotaState: 'low' }], load: { [B]: 9 }, orchestratorCli: A })).toMatchObject({ provider: B, reason: 'only_candidate' });
  });

  it('is deterministic: the same input gives the same answer', () => {
    const input = { candidates: both(), load: { [A]: 3, [B]: 1 }, orchestratorCli: A, sticky: A };
    expect(decideAutoProvider(input)).toEqual(decideAutoProvider(input));
  });
});

describe('decideAutoProvider: an unverified preset', () => {
  it('ranks behind one that could be checked, within a tier, and is used if it is all there is', () => {
    const a: AutoCandidate = { provider: A, quotaState: 'known', unverified: true };
    const b: AutoCandidate = { provider: B, quotaState: 'known' };
    expect(decideAutoProvider({ candidates: [a, b], load: { [B]: 9 }, orchestratorCli: A })).toMatchObject({ provider: B });
    expect(decideAutoProvider({ candidates: [a, { ...b, unverified: true }], load: {}, orchestratorCli: A })).toMatchObject({ provider: A });
  });
});
