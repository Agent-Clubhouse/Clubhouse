import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../dispatcher/dispatcher-service', () => ({ isDispatcherIdentityAgentId: () => false }));
const registry = vi.hoisted(() => ({ known: undefined as { projectPath: string; parentAgentId?: string } | undefined }));
vi.mock('../app-event-sources', () => ({ knownAgent: () => registry.known }));
vi.mock('../project-store', () => ({
  list: async () => [{ id: 'proj-1', path: '/Users/someone/src/app' }],
  projectPathKey: (p: string) => p.toLowerCase(),
  onProjectsChanged: () => () => {},
}));

import type { ChatEvent } from '../../../shared/chat';
import { appLog } from '../log-service';
import { createDiagnosticsRing, DIAGNOSTICS_CATALOG } from '../framebriar/feedback-diagnostics';
import { publishChatEvent, removeAllChatEventListeners } from './chat-event-bus';
import {
  USAGE_LOG_MAX_LINES_PER_HOUR,
  USAGE_LOG_NS,
  _resetUsageAttributionForTesting,
  _setUsageAttributionDepsForTesting,
  startUsageAttributionLog,
  type UsageAgentInfo,
} from './usage-attribution-log';

let lines: Array<{ msg: string; meta: Record<string, unknown> }>;
let now: number;
let seq = 0;
const agents: Record<string, UsageAgentInfo> = {
  helper: { role: 'helper', parentAgentId: 'orch', projectId: 'proj-1' },
  orch: { role: 'orchestrator', projectId: 'proj-1' },
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
    emit('helper', 'turn_started', { trigger: 'prompt' }, 't1');
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
    emit('orch', 'session_ended', { reason: 'stopped' });
    const total = lines.find((l) => l.msg === 'Usage session total')!.meta;
    expect(total).toMatchObject({ kind: 'final', baseline: 'lifetime', resumed: true, input: 5000 });
    expect(turnLines()[0]).toMatchObject({ kind: 'turn', input: 50 });
  });

  it('says unknown when the role or model is not established', () => {
    start('stranger', { model: undefined });
    expect(lines[0].meta).toMatchObject({ role: 'unknown', model: 'unknown', effort: 'unknown' });
    expect(lines[0].meta).not.toHaveProperty('parentAgentId');
  });

  it('looks an unknown agent up again on its next line', () => {
    start('late');
    agents.late = { role: 'helper', parentAgentId: 'orch' };
    emit('late', 'turn_started', {}, 't1');
    emit('late', 'turn_ended', { stopReason: 'end_turn' }, 't1');
    delete agents.late;
    emit('late', 'turn_started', {}, 't2');
    emit('late', 'turn_ended', { stopReason: 'end_turn' }, 't2');
    expect(lines[0].meta.role).toBe('unknown');
    // Once known, it stays: a later lookup miss doesn't take it back.
    expect(turnLines().map((l) => l.role)).toEqual(['helper', 'helper']);
  });

  it('says unknown, not the earlier effort, after a Codex server reroute that names only the model', () => {
    start('orch');
    emit('orch', 'model_changed', { modelId: 'a', effort: 'high' });
    emit('orch', 'model_changed', { modelId: 'rerouted' });
    emit('orch', 'turn_started', {}, 't1');
    emit('orch', 'turn_ended', { stopReason: 'end_turn' }, 't1');
    expect(turnLines()[0]).toMatchObject({ model: 'rerouted', effort: 'unknown' });
  });

  it('drops an earlier effort when another driver changes to a model without one', () => {
    start('orch', { driver: 'claude_agent_sdk' });
    emit('orch', 'model_changed', { modelId: 'a', effort: 'high' });
    emit('orch', 'model_changed', { modelId: 'b' });
    emit('orch', 'turn_started', {}, 't1');
    emit('orch', 'turn_ended', { stopReason: 'end_turn' }, 't1');
    expect(turnLines()[0]).toMatchObject({ model: 'b', effort: 'unknown' });
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

  it('writes through appLog at info, with no telemetry bridge, when no test sink is set', () => {
    _setUsageAttributionDepsForTesting(null);
    vi.mocked(appLog).mockClear();
    start('orch');
    emit('orch', 'turn_started', {}, 't1');
    emit('orch', 'turn_ended', { stopReason: 'end_turn', usage: { input: 3, output: 1 } }, 't1');
    const calls = vi.mocked(appLog).mock.calls;
    expect(calls.map((c) => [c[0], c[1], c[2]])).toEqual([[USAGE_LOG_NS, 'info', 'Usage session started'], [USAGE_LOG_NS, 'info', 'Usage turn']]);
    for (const call of calls) expect(call[3]).not.toHaveProperty('telemetry');
    expect(calls[1][3]?.meta).toMatchObject({ role: 'unknown', input: 3, output: 1 });
  });

  it('never reaches a feedback report: the diagnostics allowlist keeps no usage line', () => {
    expect(DIAGNOSTICS_CATALOG[USAGE_LOG_NS]).toBeUndefined();
    start('helper', { nativeSessionId: 'thread-1' });
    emit('helper', 'turn_started', {}, 't1');
    emit('helper', 'turn_ended', { stopReason: 'end_turn', usage: { input: 3, output: 1 } }, 't1');
    emit('helper', 'session_ended', { reason: 'stopped' });
    const ring = createDiagnosticsRing({ now: () => now });
    for (const { msg, meta } of lines) ring.note({ ns: USAGE_LOG_NS, level: 'info', msg, meta });
    expect(ring.collect().lines).toEqual([]);
  });

  it('names the project by id and never writes a path', async () => {
    _resetUsageAttributionForTesting();
    registry.known = { projectPath: '/Users/someone/src/app', parentAgentId: 'orch' };
    vi.mocked(appLog).mockClear();
    startUsageAttributionLog();
    await new Promise((r) => setTimeout(r, 0));
    publishChatEvent({ v: 1, agentId: 'h', sessionId: 's', seq: ++seq, ts: now, type: 'session_started', data: { driver: 'codex_app_server', provider: 'codex', cwd: '/Users/someone/src/app/.clubhouse/agents/h', resumed: false, capabilities: {} } } as unknown as ChatEvent);
    publishChatEvent({ v: 1, agentId: 'h', sessionId: 's', seq: ++seq, ts: now, type: 'turn_started', turnId: 't', data: {} } as unknown as ChatEvent);
    publishChatEvent({ v: 1, agentId: 'h', sessionId: 's', seq: ++seq, ts: now, type: 'turn_ended', turnId: 't', data: { stopReason: 'end_turn', usage: { input: 1, output: 1 } } } as unknown as ChatEvent);
    registry.known = undefined;
    const metas = vi.mocked(appLog).mock.calls.map((c) => c[3]?.meta as Record<string, unknown>);
    expect(metas[1]).toMatchObject({ role: 'helper', parentAgentId: 'orch', projectId: 'proj-1' });
    for (const meta of metas) {
      expect(meta).not.toHaveProperty('projectPath');
      for (const value of Object.values(meta)) if (typeof value === 'string') expect(value).not.toMatch(/^(\/|[A-Za-z]:[\\/]|~)/);
    }
  });

  it('leaves the project out, without failing, when the agent record has no project path', () => {
    _resetUsageAttributionForTesting();
    registry.known = { projectPath: undefined as unknown as string };
    vi.mocked(appLog).mockClear();
    startUsageAttributionLog();
    publishChatEvent({ v: 1, agentId: 'h', sessionId: 's', seq: ++seq, ts: now, type: 'session_started', data: { driver: 'codex_app_server', provider: 'codex', cwd: '/w', resumed: false, capabilities: {} } } as unknown as ChatEvent);
    registry.known = undefined;
    const meta = vi.mocked(appLog).mock.calls[0]?.[3]?.meta as Record<string, unknown>;
    expect(meta).toMatchObject({ role: 'agent' });
    expect(meta).not.toHaveProperty('projectId');
  });
});
