import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../dispatcher/dispatcher-service', () => ({ isDispatcherIdentityAgentId: () => false }));
vi.mock('../app-event-sources', () => ({ knownAgent: () => undefined }));

import type { ChatEvent } from '../../../shared/chat';
import { publishChatEvent, removeAllChatEventListeners } from './chat-event-bus';
import {
  USAGE_LOG_MAX_LINES_PER_HOUR,
  _resetUsageAttributionForTesting,
  _setUsageAttributionDepsForTesting,
  startUsageAttributionLog,
  type UsageAgentInfo,
} from './usage-attribution-log';

let lines: Array<{ msg: string; meta: Record<string, unknown> }>;
let now: number;
let seq = 0;
const agents: Record<string, UsageAgentInfo> = {
  helper: { role: 'helper', parentAgentId: 'orch', projectPath: '/p' },
  orch: { role: 'orchestrator', projectPath: '/p' },
};

beforeEach(() => {
  lines = [];
  now = 1_000_000;
  _resetUsageAttributionForTesting();
  _setUsageAttributionDepsForTesting({
    agentInfo: (id) => agents[id] ?? { role: 'unknown' },
    log: (msg, meta) => lines.push({ msg, meta }),
    now: () => now,
  });
  startUsageAttributionLog();
});
afterEach(() => {
  _resetUsageAttributionForTesting();
  removeAllChatEventListeners();
});

function emit(agentId: string, type: string, data: unknown, turnId?: string, sessionId = 's1'): void {
  publishChatEvent({ v: 1, agentId, sessionId, seq: ++seq, ts: now, type, data, ...(turnId && { turnId }) } as unknown as ChatEvent);
}

function start(agentId: string, data: Record<string, unknown> = {}, sessionId = 's1'): void {
  emit(agentId, 'session_started', { driver: 'codex_app_server', provider: 'codex', cwd: '/w', resumed: false, model: 'gpt-x', capabilities: {}, ...data }, undefined, sessionId);
}

const turnLines = () => lines.filter((l) => l.msg === 'Usage turn').map((l) => l.meta);

describe('usage attribution log', () => {
  it('logs each turn with role, parent, provider, model, effort and its own figures', () => {
    start('helper', { nativeSessionId: 'thread-1' });
    emit('helper', 'model_changed', { modelId: 'gpt-y', effort: 'high' });
    emit('helper', 'turn_started', { trigger: 'immediate' }, 't1');
    // Codex: the thread's running total is not the turn's figure.
    emit('helper', 'usage', { scope: 'session', threadId: 'thread-1', tokens: { input: 900, output: 90 } }, 't1');
    emit('helper', 'turn_ended', { stopReason: 'end_turn', usage: { input: 100, cachedInput: 80, output: 10 } }, 't1');

    expect(lines[0]).toMatchObject({ msg: 'Usage session started', meta: { agentId: 'helper', role: 'helper', parentAgentId: 'orch', provider: 'codex', model: 'gpt-x', resumed: false } });
    expect(turnLines()).toEqual([expect.objectContaining({
      agentId: 'helper', role: 'helper', parentAgentId: 'orch', sessionId: 's1', nativeSessionId: 'thread-1', turnId: 't1',
      driver: 'codex_app_server', provider: 'codex', model: 'gpt-y', effort: 'high',
      kind: 'turn', source: 'cumulative_delta', dedup: 'turn_id', completeness: 'complete',
      input: 100, cachedInput: 80, output: 10,
    })]);
  });

  it('keeps a missing figure missing, and a reported zero as zero', () => {
    start('orch');
    emit('orch', 'turn_started', {}, 't1');
    emit('orch', 'turn_ended', { stopReason: 'end_turn' }, 't1');
    emit('orch', 'turn_started', {}, 't2');
    emit('orch', 'turn_ended', { stopReason: 'end_turn', usage: { input: 0, output: 0 } }, 't2');
    const [missing, zero] = turnLines();
    expect(missing.completeness).toBe('none');
    expect(missing).not.toHaveProperty('input');
    expect(zero).toMatchObject({ completeness: 'complete', input: 0, output: 0 });
  });

  it('logs a repeated turn end once', () => {
    start('orch');
    emit('orch', 'turn_started', {}, 't1');
    emit('orch', 'turn_ended', { stopReason: 'end_turn', usage: { input: 5, output: 1 } }, 't1');
    emit('orch', 'turn_ended', { stopReason: 'end_turn', usage: { input: 5, output: 1 } }, 't1');
    expect(turnLines()).toHaveLength(1);
  });

  it('marks a resumed session total as lifetime, apart from its turns', () => {
    start('orch', { resumed: true });
    emit('orch', 'turn_started', {}, 't1');
    emit('orch', 'usage', { scope: 'session', threadId: 'th', tokens: { input: 5000, output: 500 } }, 't1');
    emit('orch', 'turn_ended', { stopReason: 'end_turn', usage: { input: 50, output: 5 } }, 't1');
    emit('orch', 'session_ended', { reason: 'exited' });
    const total = lines.find((l) => l.msg === 'Usage session total')!.meta;
    expect(total).toMatchObject({ kind: 'final', baseline: 'lifetime', resumed: true, input: 5000 });
    expect(turnLines()[0]).toMatchObject({ kind: 'turn', input: 50 });
  });

  it('says unknown when the role or model is not established', () => {
    start('stranger', { model: undefined });
    expect(lines[0].meta).toMatchObject({ role: 'unknown', model: 'unknown', effort: 'unknown' });
    expect(lines[0].meta).not.toHaveProperty('parentAgentId');
  });

  it('ignores events from a session it did not see start', () => {
    emit('orch', 'turn_started', {}, 't1');
    emit('orch', 'turn_ended', { stopReason: 'end_turn', usage: { input: 1 } }, 't1');
    expect(lines).toEqual([]);
  });

  it('keeps figures flat, with no nested tokens object for redaction to swallow', () => {
    start('orch');
    emit('orch', 'turn_started', {}, 't1');
    emit('orch', 'turn_ended', { stopReason: 'end_turn', usage: { input: 1, output: 1 } }, 't1');
    for (const value of Object.values(turnLines()[0])) expect(typeof value === 'object' && value !== null).toBe(false);
  });

  it('caps lines per hour and reports the drop when the hour turns', () => {
    start('orch');
    for (let i = 0; i < USAGE_LOG_MAX_LINES_PER_HOUR + 5; i++) {
      emit('orch', 'turn_started', {}, `t${i}`);
      emit('orch', 'turn_ended', { stopReason: 'end_turn', usage: { input: 1, output: 1 } }, `t${i}`);
    }
    expect(lines).toHaveLength(USAGE_LOG_MAX_LINES_PER_HOUR);
    now += 60 * 60_000;
    emit('orch', 'turn_started', {}, 'late');
    emit('orch', 'turn_ended', { stopReason: 'end_turn', usage: { input: 1, output: 1 } }, 'late');
    expect(lines.at(-2)).toMatchObject({ msg: 'Usage lines dropped over the hourly limit', meta: { dropped: 6 } });
    expect(lines.at(-1)!.meta.turnId).toBe('late');
  });
});
