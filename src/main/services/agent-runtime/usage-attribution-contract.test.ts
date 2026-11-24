/**
 * The usage contract across providers (docs/usage-attribution.md): what each
 * driver publishes becomes the same kind of `core:usage` line, with figures
 * only where the provider reported them and provenance it can stand behind.
 * Codex and ACP go through their real mappers; Claude and Copilot are the
 * event sequences their drivers push (claude/driver.ts and copilot/driver.ts
 * at turn end).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../dispatcher/dispatcher-service', () => ({ isDispatcherIdentityAgentId: () => false }));
vi.mock('../app-event-sources', () => ({ knownAgent: () => undefined }));

import type { ChatEvent, ChatEventDraft } from '../../../shared/chat';
import type { ChatDriverId } from '../../../shared/chat/capabilities';
import { AcpUpdateMapper } from '../../chat/acp/mapper';
import { CodexChatEventMapper } from '../../orchestrators/adapters/codex-chat-events';
import { _resetUsageAttributionForTesting, _setUsageAttributionDepsForTesting, logUsageChatEvent } from './usage-attribution-log';

let lines: Array<{ msg: string; meta: Record<string, unknown> }>;
let seq = 0;

beforeEach(() => {
  lines = [];
  _resetUsageAttributionForTesting();
  _setUsageAttributionDepsForTesting({ agentInfo: () => ({ role: 'agent' }), log: (msg, meta) => lines.push({ msg, meta }), now: () => 0 });
});
afterEach(() => _resetUsageAttributionForTesting());

function feed(drafts: ChatEventDraft[], turnId?: string): void {
  for (const d of drafts) logUsageChatEvent({ v: 1, agentId: 'a', sessionId: 's', seq: ++seq, ts: seq, ...d, ...(turnId && { turnId }) } as unknown as ChatEvent);
}

function session(driver: string, resumed = false): void {
  feed([{ type: 'session_started', data: { driver: driver as ChatDriverId, provider: driver, cwd: '/w', resumed, capabilities: {} as never } }]);
}

const turns = () => lines.filter((l) => l.msg === 'Usage turn').map((l) => l.meta);
const finals = () => lines.filter((l) => l.msg === 'Usage session total').map((l) => l.meta);
const FIGURES = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'];

function breakdown(input: number, cached: number, output: number, reasoning: number) {
  return { totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: reasoning };
}

describe('usage contract across providers', () => {
  it('Claude: the provider turn figure, main loop; the session total is a separate inclusive final', () => {
    session('claude_agent_sdk');
    const t = { input: 1200, cachedInput: 1000, cacheWrite: 50, output: 40 };
    feed([
      { type: 'turn_started', data: { trigger: 'prompt' } },
      { type: 'usage', data: { scope: 'turn', coverage: 'main', tokens: t, costUsd: 0.01, costIsEstimate: true } },
      { type: 'usage', data: { scope: 'session', coverage: 'inclusive', tokens: { input: 5000, output: 400 }, costUsd: 0.2 } },
      { type: 'turn_ended', data: { stopReason: 'end_turn', usage: t, costUsd: 0.01 } },
    ], 't1');
    feed([{ type: 'session_ended', data: { reason: 'stopped' } }]);
    expect(turns()).toEqual([expect.objectContaining({ source: 'provider_turn', scope: 'main', completeness: 'complete', ...t })]);
    // No reasoning figure from Claude: absent, not zero.
    expect(turns()[0]).not.toHaveProperty('reasoning');
    expect(finals()).toEqual([expect.objectContaining({ kind: 'final', scope: 'inclusive', input: 5000, baseline: 'run' })]);
  });

  it('Codex: the turn is the difference of thread totals, and a resumed thread is not charged its history', () => {
    session('codex_app_server', true);
    const mapper = new CodexChatEventMapper();
    const update = (total: ReturnType<typeof breakdown>, last: ReturnType<typeof breakdown>) => mapper.mapNotification({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'th', turnId: 'n1', tokenUsage: { total, last, modelContextWindow: 200000 } },
    } as never);
    feed(mapper.mapNotification({ method: 'turn/started', params: { threadId: 'th', turn: { id: 'n1' } } } as never), 't1');
    // Resumed: the first total already holds 10,000 tokens of earlier runs; this request's share is `last`.
    feed(update(breakdown(10_000, 8_000, 500, 100), breakdown(1_000, 800, 50, 10)), 't1');
    feed(update(breakdown(12_000, 9_500, 600, 120), breakdown(2_000, 1_500, 100, 20)), 't1');
    feed(mapper.mapNotification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 'n1', status: 'completed', error: null, items: [] } } } as never), 't1');
    feed([{ type: 'session_ended', data: { reason: 'stopped' } }]);
    expect(turns()).toEqual([expect.objectContaining({ source: 'cumulative_delta', scope: 'unscoped', input: 3_000, cachedInput: 2_300, output: 150, reasoning: 30 })]);
    expect(finals()).toEqual([expect.objectContaining({ baseline: 'lifetime', input: 12_000, dedup: 'thread_cumulative' })]);
  });

  it('Copilot: our sum of per-call figures, subagents included', () => {
    session('copilot_sdk');
    const usage = { input: 300, cachedInput: 100, output: 20 };
    feed([
      { type: 'turn_started', data: { trigger: 'prompt' } },
      { type: 'usage', data: { scope: 'turn', coverage: 'inclusive', tokens: usage } },
      { type: 'usage', data: { scope: 'session', coverage: 'inclusive', tokens: usage } },
      { type: 'turn_ended', data: { stopReason: 'end_turn', usage } },
    ], 't1');
    expect(turns()).toEqual([expect.objectContaining({ source: 'summed_calls', scope: 'inclusive', ...usage })]);
  });

  it('ACP: context and cost only make no token figures, and an undeclared driver claims no source', () => {
    session('antigravity_acp');
    const mapper = new AcpUpdateMapper('antigravity_acp' as ChatDriverId);
    feed([{ type: 'turn_started', data: { trigger: 'prompt' } }], 't1');
    feed(mapper.map({ sessionUpdate: 'usage_update', used: 52_000, size: 200_000, cost: { amount: 0.5, currency: 'USD' } }).drafts, 't1');
    // What the ACP driver pushes at the end of a prompt: no usage.
    feed([{ type: 'turn_ended', data: { stopReason: 'end_turn', durationMs: 10 } }], 't1');
    feed([{ type: 'session_ended', data: { reason: 'stopped' } }]);
    const [turn] = turns();
    expect(turn).toMatchObject({ source: 'unknown', completeness: 'none' });
    for (const k of FIGURES) expect(turn).not.toHaveProperty(k);
    expect(finals()).toEqual([]);
  });

  it('a new adapter that declares its source is believed; one that reports figures without it is unknown', () => {
    session('future_driver');
    feed([
      { type: 'turn_started', data: { trigger: 'prompt' } },
      { type: 'turn_ended', data: { stopReason: 'end_turn', usage: { input: 10, output: 2 }, usageSource: 'cumulative_delta' } },
    ], 't1');
    feed([
      { type: 'turn_started', data: { trigger: 'prompt' } },
      { type: 'turn_ended', data: { stopReason: 'end_turn', usage: { input: 10, output: 2 } } },
    ], 't2');
    expect(turns().map((t) => t.source)).toEqual(['cumulative_delta', 'unknown']);
  });

  it('every provider: a turn that reports nothing is logged as none, never as zeros', () => {
    for (const driver of ['claude_agent_sdk', 'claude_stream_json', 'codex_app_server', 'copilot_sdk']) {
      _resetUsageAttributionForTesting();
      _setUsageAttributionDepsForTesting({ agentInfo: () => ({ role: 'agent' }), log: (msg, meta) => lines.push({ msg, meta }), now: () => 0 });
      lines = [];
      session(driver);
      feed([{ type: 'turn_started', data: { trigger: 'prompt' } }, { type: 'turn_ended', data: { stopReason: 'end_turn' } }], 't1');
      const [turn] = turns();
      expect(turn.completeness, driver).toBe('none');
      for (const k of FIGURES) expect(turn, driver).not.toHaveProperty(k);
    }
  });
});
