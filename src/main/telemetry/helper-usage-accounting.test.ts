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

  it('without a turn id, an identical report right after another is a repeat, and says dedup was by content', () => {
    const t = new RunUsageTracker('copilot_acp');
    const a = turn(t, undefined, 0, undefined, { stopReason: 'end_turn', usage: { input: 5, output: 5 } });
    const repeat = turn(t, undefined, 5000, undefined, { stopReason: 'end_turn', usage: { input: 5, output: 5 } });
    expect(a!.dedup).toBe('content_equal');
    expect(repeat).toBeUndefined();
  });

  it('a driver with neither turn id nor content rule says dedup none', () => {
    const t = new RunUsageTracker('codex_app_server');
    expect(turn(t, undefined, 0, undefined, { stopReason: 'end_turn', usage: { input: 1, output: 1 } })!.dedup).toBe('none');
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
    t.usage({ scope: 'session', coverage: 'main', threadId: 'th', tokens: { input: 100, output: 20 } }, undefined);
    t.usage({ scope: 'session', coverage: 'main', threadId: 'th', tokens: { input: 30, output: 5 } }, undefined);
    expect(t.finalSamples(1)[0]).toMatchObject({ reset: true, figures: { input: 30, output: 5 } });
  });

  it('Codex: a subagent thread never overwrites the main thread, and inclusive is the thread sum', () => {
    const t = new RunUsageTracker('codex_app_server');
    t.usage({ scope: 'session', coverage: 'main', threadId: 'main', tokens: { input: 100, output: 10, reasoning: 4 } }, undefined);
    t.usage({ scope: 'session', coverage: 'main', threadId: 'sub', subagentId: 'sub', tokens: { input: 50, output: 5, reasoning: 1 } }, undefined);
    // Main grows after the subagent reported: still its own.
    t.usage({ scope: 'session', coverage: 'main', threadId: 'main', tokens: { input: 120, output: 12, reasoning: 5 } }, undefined);
    const samples = t.finalSamples(7);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({ scope: 'main', dedup: 'thread_cumulative', subagentExcluded: true, figures: { input: 120, output: 12, reasoning: 5 } });
    expect(samples[1]).toMatchObject({ scope: 'inclusive', dedup: 'thread_cumulative', figures: { input: 170, output: 17, reasoning: 6 } });
  });

  it('claims no inclusive total across a reset', () => {
    const t = new RunUsageTracker('codex_app_server');
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
