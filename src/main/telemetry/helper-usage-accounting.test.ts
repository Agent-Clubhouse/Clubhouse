import { describe, expect, it } from 'vitest';
import type { ChatEventDataMap } from '../../shared/chat/events';
import { HELPER_TELEMETRY_LIMITS } from '../../shared/telemetry/helper-usage-contract';
import { RunUsageTracker } from './helper-usage-accounting';

type Usage = ChatEventDataMap['usage'];

const turn = (tracker: RunUsageTracker, id: string | undefined, at: number, usage?: Usage, ended: ChatEventDataMap['turn_ended'] = { stopReason: 'end_turn' }) => {
  tracker.turnStarted(id, at);
  if (usage) tracker.usage(usage, id);
  return tracker.turnEnded(id, ended, at + 1000);
};

describe('turn samples', () => {
  it('reports exactly what the provider reported, with scope and dedup', () => {
    const t = new RunUsageTracker('claude_stream_json');
    const sample = turn(t, 'turn-1', 0, { scope: 'turn', coverage: 'main', tokens: { input: 120, cachedInput: 100, cacheWrite: 0, output: 30 } });
    expect(sample).toMatchObject({
      kind: 'turn', source: 'provider_turn', dedup: 'turn_id', scope: 'main', completeness: 'complete', turnIndex: 1, durationMs: 1000,
      figures: { input: 120, cachedInput: 100, cacheWrite: 0, output: 30 },
    });
    // Not reported (reasoning) is absent. Reported zero (cacheWrite) stays zero.
    expect(sample!.figures).not.toHaveProperty('reasoning');
    expect(sample!.figures.cacheWrite).toBe(0);
  });

  it('counts a turn once however many times its end is delivered', () => {
    const t = new RunUsageTracker('copilot_sdk');
    const first = turn(t, 'turn-1', 0, { scope: 'turn', tokens: { input: 10, output: 5 } });
    const again = t.turnEnded('turn-1', { stopReason: 'end_turn', usage: { input: 10, output: 5 } }, 5000);
    expect(first).toBeDefined();
    expect(again).toBeUndefined();
    expect(t.counts.turns).toBe(1);
  });

  it('a turn usage reported twice replaces, never adds', () => {
    const t = new RunUsageTracker('claude_stream_json');
    t.turnStarted('t', 0);
    t.usage({ scope: 'turn', tokens: { input: 5, output: 1 } }, 't');
    t.usage({ scope: 'turn', tokens: { input: 9, output: 4 } }, 't');
    expect(t.turnEnded('t', { stopReason: 'end_turn' }, 10)!.figures).toEqual({ input: 9, output: 4 });
  });

  it('prefers the usage on turn_ended, as chat telemetry does', () => {
    const t = new RunUsageTracker('codex_app_server');
    const sample = turn(t, 'a', 0, undefined, { stopReason: 'end_turn', usage: { input: 7, output: 3, reasoning: 2 } });
    expect(sample!.figures).toEqual({ input: 7, output: 3, reasoning: 2 });
    expect(sample!.scope).toBe('unscoped');
  });

  it('a turn with no usage is a missing sample, not zeros', () => {
    const t = new RunUsageTracker('acp');
    const sample = turn(t, 'a', 0);
    expect(sample).toMatchObject({ completeness: 'none', figures: {} });
    expect(t.counts).toMatchObject({ turns: 1, turnsMissing: 1 });
  });

  it('half-reported usage is partial', () => {
    const t = new RunUsageTracker('copilot_sdk');
    expect(turn(t, 'a', 0, { scope: 'turn', tokens: { output: 4 } })).toMatchObject({ completeness: 'partial', figures: { output: 4 } });
  });

  it('two distinct turns with no turn id and equal usage are both counted: equal figures prove nothing', () => {
    const t = new RunUsageTracker('copilot_acp');
    const a = turn(t, undefined, 0, undefined, { stopReason: 'end_turn', usage: { input: 5, output: 5 } });
    const b = turn(t, undefined, 5000, undefined, { stopReason: 'end_turn', usage: { input: 5, output: 5 } });
    expect(a).toMatchObject({ dedup: 'none', turnIndex: 1, figures: { input: 5, output: 5 } });
    expect(b).toMatchObject({ dedup: 'none', turnIndex: 2, figures: { input: 5, output: 5 } });
    expect(t.counts.turns).toBe(2);
  });

  it('with no turn id, a second end for a turn already closed is the one actual duplicate', () => {
    const t = new RunUsageTracker('codex_app_server');
    t.turnStarted(undefined, 0);
    expect(t.turnEnded(undefined, { stopReason: 'end_turn', usage: { input: 5, output: 5 } }, 10)).toBeDefined();
    expect(t.turnEnded(undefined, { stopReason: 'end_turn', usage: { input: 5, output: 5 } }, 11)).toBeUndefined();
    expect(t.counts.turns).toBe(1);
  });

  it('drops invalid figures instead of passing them on', () => {
    const t = new RunUsageTracker('claude_stream_json');
    const sample = turn(t, 'a', 0, undefined, { stopReason: 'end_turn', usage: { input: -3, output: Number.NaN, cachedInput: 4 } });
    expect(sample!.figures).toEqual({ cachedInput: 4 });
  });

  it('is capped, keeping room for the closing samples, and counts the drops', () => {
    const t = new RunUsageTracker('copilot_sdk', 2);
    t.usage({ scope: 'session', coverage: 'inclusive', tokens: { input: 1, output: 1 } }, undefined);
    expect(turn(t, 'a', 0, { scope: 'turn', tokens: { input: 1, output: 1 } })).toBeDefined();
    expect(turn(t, 'b', 0, { scope: 'turn', tokens: { input: 1, output: 1 } })).toBeDefined();
    expect(turn(t, 'c', 0, { scope: 'turn', tokens: { input: 1, output: 1 } })).toBeUndefined();
    expect(t.counts.samplesDropped).toBe(1);
    expect(t.finalSamples(10)).toHaveLength(1);
  });

  it('defaults its cap to the stated limit', () => {
    const t = new RunUsageTracker('claude_stream_json');
    let admitted = 0;
    for (let i = 0; i < HELPER_TELEMETRY_LIMITS.maxUsageSamplesPerRun + 5; i++) {
      if (turn(t, `t${i}`, i, { scope: 'turn', tokens: { input: 1, output: 1 } })) admitted++;
    }
    expect(admitted).toBe(HELPER_TELEMETRY_LIMITS.maxUsageSamplesPerRun);
  });
});

describe('closing samples', () => {
  it('Claude: the inclusive session total is its own sample and never summed with turns', () => {
    const t = new RunUsageTracker('claude_stream_json');
    turn(t, 't1', 0, { scope: 'turn', coverage: 'main', tokens: { input: 10, output: 2 } });
    t.usage({ scope: 'session', coverage: 'inclusive', tokens: { input: 40, output: 9 } }, undefined);
    const [final, ...rest] = t.finalSamples(99);
    expect(rest).toEqual([]);
    expect(final).toMatchObject({ kind: 'final', source: 'provider_session_cumulative', scope: 'inclusive', figures: { input: 40, output: 9 } });
  });

  it('a later running total replaces the earlier one', () => {
    const t = new RunUsageTracker('claude_stream_json');
    t.usage({ scope: 'session', coverage: 'inclusive', tokens: { input: 10, output: 2 } }, undefined);
    t.usage({ scope: 'session', coverage: 'inclusive', tokens: { input: 25, output: 6 } }, undefined);
    expect(t.finalSamples(1)[0].figures).toEqual({ input: 25, output: 6 });
    expect(t.finalSamples(1)[0].reset).toBeUndefined();
  });

  it('a running total that goes down is flagged as a reset, not differenced', () => {
    const t = new RunUsageTracker('codex_app_server');
    t.usage({ scope: 'session', threadId: 'th', tokens: { input: 100, output: 20 } }, undefined);
    t.usage({ scope: 'session', threadId: 'th', tokens: { input: 30, output: 5 } }, undefined);
    expect(t.finalSamples(1)[0]).toMatchObject({ reset: true, figures: { input: 30, output: 5 } });
  });

  it('Codex: a subagent thread never overwrites the main thread, and with no documented coverage no inclusive total is made', () => {
    const t = new RunUsageTracker('codex_app_server');
    t.usage({ scope: 'session', threadId: 'main', tokens: { input: 100, output: 10, reasoning: 4 } }, undefined);
    t.usage({ scope: 'session', threadId: 'sub', subagentId: 'sub', tokens: { input: 50, output: 5, reasoning: 1 } }, undefined);
    // Main grows after the subagent reported: still its own.
    t.usage({ scope: 'session', threadId: 'main', tokens: { input: 120, output: 12, reasoning: 5 } }, undefined);
    const samples = t.finalSamples(7);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ scope: 'unscoped', dedup: 'thread_cumulative', subagentExcluded: true, figures: { input: 120, output: 12, reasoning: 5 } });
  });

  it('claims no inclusive total across a reset, even where a driver documents thread-only coverage', () => {
    const t = new RunUsageTracker('acp');
    t.usage({ scope: 'session', coverage: 'main', threadId: 'main', tokens: { input: 100, output: 10 } }, undefined);
    t.usage({ scope: 'session', coverage: 'main', threadId: 'sub', subagentId: 'sub', tokens: { input: 5, output: 1 } }, undefined);
    t.usage({ scope: 'session', coverage: 'main', threadId: 'main', tokens: { input: 10, output: 1 } }, undefined);
    expect(t.finalSamples(7).map((s) => s.scope)).toEqual(['main']);
  });

  it('a driver that gives no scope or identity is unscoped with dedup none', () => {
    const t = new RunUsageTracker('acp');
    t.usage({ scope: 'session', tokens: { total: 5 } as never }, undefined);
    expect(t.finalSamples(1)[0]).toMatchObject({ scope: 'unscoped', dedup: 'none' });
  });

  it('no running totals, no closing sample', () => {
    expect(new RunUsageTracker('acp').finalSamples(1)).toEqual([]);
  });
});

describe('errors and limits', () => {
  it('counts auth, rate limit and exceeded-window quota errors by class', () => {
    const t = new RunUsageTracker('claude_stream_json');
    t.error('auth_required');
    t.error('rate_limited');
    t.error('rate_limited');
    t.error('tool_failed');
    t.usage({ scope: 'session', limits: [{ window: 'week', status: 'exceeded' }] }, undefined);
    t.usage({ scope: 'session', limits: [{ window: 'week', status: 'exceeded' }, { window: '5h', status: 'warning' }] }, undefined);
    expect(t.counts).toMatchObject({ authErrors: 1, rateLimitErrors: 2, quotaErrors: 1 });
  });
});

describe('who did the arithmetic', () => {
  const ended = { stopReason: 'end_turn' as const, usage: { input: 3, output: 1 } };
  it('labels a provider turn, our sum of calls, and our difference of running totals apart', () => {
    expect(turn(new RunUsageTracker('claude_agent_sdk'), 'a', 0, undefined, ended)!.source).toBe('provider_turn');
    expect(turn(new RunUsageTracker('acp'), 'a', 0, undefined, ended)!.source).toBe('provider_turn');
    expect(turn(new RunUsageTracker('copilot_sdk'), 'a', 0, undefined, ended)!.source).toBe('summed_calls');
    expect(turn(new RunUsageTracker('codex_app_server'), 'a', 0, undefined, ended)!.source).toBe('cumulative_delta');
  });

  it('labels a Copilot SDK closing total as our sum, and the others as the provider\'s running total', () => {
    const total = { scope: 'session' as const, coverage: 'inclusive' as const, tokens: { input: 9, output: 2 } };
    const copilot = new RunUsageTracker('copilot_sdk');
    copilot.usage(total, undefined);
    expect(copilot.finalSamples(1)[0].source).toBe('summed_calls');
    const claude = new RunUsageTracker('claude_agent_sdk');
    claude.usage(total, undefined);
    expect(claude.finalSamples(1)[0].source).toBe('provider_session_cumulative');
  });
});

describe('what a running total covers', () => {
  const total = (input: number, output: number, extra: Partial<Usage> = {}): Usage => ({ scope: 'session', coverage: 'inclusive', tokens: { input, output }, ...extra });

  it('a fresh run\'s total is the run\'s own', () => {
    const t = new RunUsageTracker('claude_agent_sdk');
    t.usage(total(40, 9), undefined);
    expect(t.finalSamples(1)[0].baseline).toBe('run');
  });

  it('a resumed native session\'s total carries earlier use: lifetime, with the turn samples still the run\'s share', () => {
    const t = new RunUsageTracker('claude_agent_sdk', undefined, true);
    // The first result of a resumed session already holds the earlier turns.
    const first = turn(t, 'a', 0, { scope: 'turn', coverage: 'main', tokens: { input: 10, output: 2 } });
    t.usage(total(50_010, 902), undefined);
    const [final] = t.finalSamples(9);
    expect(final).toMatchObject({ baseline: 'lifetime', figures: { input: 50_010, output: 902 } });
    // The run's own use is the turn sample, which is not folded into the lifetime total.
    expect(first!.figures).toEqual({ input: 10, output: 2 });
    expect(t.counts.turns).toBe(1);
  });

  it('a reset or /clear mid-run makes the closing total cover only what came after', () => {
    const t = new RunUsageTracker('claude_agent_sdk', undefined, true);
    t.usage(total(900, 80), undefined);
    t.usage(total(30, 4), undefined);
    expect(t.finalSamples(1)[0]).toMatchObject({ baseline: 'after_reset', reset: true, figures: { input: 30, output: 4 } });
  });

  it('a reset on a fresh run is after_reset too, not the run\'s whole use', () => {
    const t = new RunUsageTracker('codex_app_server');
    t.usage({ scope: 'session', threadId: 'th', tokens: { input: 100, output: 20 } }, undefined);
    t.usage({ scope: 'session', threadId: 'th', tokens: { input: 10, output: 2 } }, undefined);
    expect(t.finalSamples(1)[0].baseline).toBe('after_reset');
  });
});

/** A sum is only possible for a driver that documents thread-only coverage (none does today; Codex's protocol does not). */
describe('synthesized inclusive totals', () => {
  const thread = (t: RunUsageTracker, threadId: string, tokens: ChatEventDataMap['usage']['tokens'], over: Partial<Usage> = {}) =>
    t.usage({ scope: 'session', coverage: 'main', threadId, tokens, ...over }, undefined);
  const scopes = (t: RunUsageTracker) => t.finalSamples(1).map((s) => s.scope);

  it('is made from proven-disjoint threads that all report the same figures', () => {
    const t = new RunUsageTracker('acp');
    t.subagentDeclared('sub');
    thread(t, 'main', { input: 100, output: 10 });
    thread(t, 'sub', { input: 5, output: 1 }, { subagentId: 'sub' });
    expect(t.finalSamples(1).find((s) => s.scope === 'inclusive')).toMatchObject({ figures: { input: 105, output: 11 }, completeness: 'complete', baseline: 'run' });
  });

  it('is left out when the parent is already inclusive or its coverage unknown', () => {
    for (const coverage of ['inclusive', undefined] as const) {
      const t = new RunUsageTracker('acp');
      thread(t, 'main', { input: 100, output: 10 }, { coverage });
      thread(t, 'sub', { input: 5, output: 1 }, { subagentId: 'sub' });
      expect(scopes(t)).not.toContain('inclusive');
    }
  });

  it('is left out when a child\'s coverage is unknown', () => {
    const t = new RunUsageTracker('acp');
    thread(t, 'main', { input: 100, output: 10 });
    thread(t, 'sub', { input: 5, output: 1 }, { subagentId: 'sub', coverage: undefined });
    expect(scopes(t)).toEqual(['main']);
  });

  it('is left out when a child leaves out a figure the parent reports: no sum may hide a partial contributor', () => {
    const t = new RunUsageTracker('acp');
    thread(t, 'main', { input: 100, output: 10, reasoning: 4 });
    thread(t, 'sub', { input: 5, output: 1 }, { subagentId: 'sub' });
    expect(scopes(t)).toEqual(['main']);
  });

  it('is left out when a child reports only half the figures', () => {
    const t = new RunUsageTracker('acp');
    thread(t, 'main', { input: 100, output: 10 });
    thread(t, 'sub', { output: 1 }, { subagentId: 'sub' });
    expect(scopes(t)).toEqual(['main']);
  });

  it('is left out when a declared subagent never reported', () => {
    const t = new RunUsageTracker('acp');
    t.subagentDeclared('quiet');
    thread(t, 'main', { input: 100, output: 10 });
    thread(t, 'sub', { input: 5, output: 1 }, { subagentId: 'sub' });
    expect(scopes(t)).toEqual(['main']);
  });

  it('is left out with no thread names, since they cannot be told apart', () => {
    const t = new RunUsageTracker('acp');
    t.usage({ scope: 'session', coverage: 'main', tokens: { input: 100, output: 10 } }, undefined);
    t.usage({ scope: 'session', coverage: 'main', subagentId: 'sub', tokens: { input: 5, output: 1 } }, undefined);
    expect(scopes(t)).not.toContain('inclusive');
  });
});

describe('Codex thread figures', () => {
  it('keep thread identity and cumulative provenance but claim no coverage and never sum', () => {
    const t = new RunUsageTracker('codex_app_server');
    t.subagentDeclared('sub');
    t.usage({ scope: 'session', threadId: 'main', tokens: { input: 100, output: 10 } }, undefined);
    t.usage({ scope: 'session', threadId: 'sub', subagentId: 'sub', tokens: { input: 5, output: 1 } }, undefined);
    const samples = t.finalSamples(1);
    expect(samples.map((s) => [s.scope, s.source, s.dedup])).toEqual([['unscoped', 'provider_session_cumulative', 'thread_cumulative']]);
  });
});
