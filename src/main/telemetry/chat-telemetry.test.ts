import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/agent-exit-broadcast', () => ({ onAgentExit: vi.fn() }));

import type { ChatEvent } from '../../shared/chat';
import { ATTR, type TelAttr } from '../../shared/telemetry/attributes';
import { publishChatEvent, removeAllChatEventListeners } from '../services/agent-runtime/chat-event-bus';
import { ChatFixture, chatFixture, FIXTURE_AGENT_ID, FIXTURE_PROVIDERS, FIXTURE_SCENARIOS, PROFILES, type FixtureProvider } from '../../renderer/features/agents/chat/fixtures';
import { _activeRunsForTests, _resetAgentTelemetryForTests, installAgentTelemetry } from './agent-telemetry';
import {
  TURN_STALL_MS,
  _openTurnsForTests,
  _resetChatTelemetryForTests,
  _scanStallsForTests,
  endReasonFor,
  installChatTelemetry,
} from './chat-telemetry';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import type { ReplaySpan, TelemetryRuntime } from './types';

function fakeRuntime(): TelemetryRuntime {
  return {
    level: 'standard', flow: vi.fn(), step: vi.fn(), count: vi.fn(), event: vi.fn(), exception: vi.fn(),
    replaySpan: vi.fn(), replayTree: vi.fn(), recentExports: () => [], preview: () => [],
    forceFlush: vi.fn(async () => {}), shutdown: vi.fn(async () => {}),
  } as unknown as TelemetryRuntime;
}

let rt: TelemetryRuntime;
const publish = (events: ChatEvent[]) => events.forEach(publishChatEvent);
const spans = (name: string): ReplaySpan[] =>
  vi.mocked(rt.replaySpan).mock.calls.map((c) => c[0]).filter((s) => s.name === name);
const counts = (name: string): Array<{ value: number; attrs: TelAttr[] }> =>
  vi.mocked(rt.count).mock.calls.filter((c) => c[0] === name).map((c) => ({ value: c[1] as number, attrs: (c[2] ?? []) as TelAttr[] }));
const attr = (attrs: TelAttr[], key: string) => attrs.find((a) => a.key === key)?.value;

/** Append every other event kind a session can carry, with text in each free-form field, then end it. */
function withEverything(events: ChatEvent[], secret: string): ChatEvent[] {
  const last = events[events.length - 1];
  let seq = last.seq;
  const ev = (type: ChatEvent['type'], data: unknown, turnId?: string) =>
    ({ ...last, seq: ++seq, ts: last.ts + seq, type, data, ...(turnId ? { turnId } : { turnId: undefined }) }) as ChatEvent;
  return [
    ...events,
    ev('session_info', { title: secret, nativeSessionId: secret, cliVersion: '9.9.9', model: secret }),
    ev('notice', { level: 'warn', code: 'untested_cli_version', message: secret }),
    ev('commands_available', { commands: [{ name: secret, description: secret }] }),
    ev('permission_request', { requestId: 'p-x', title: secret, description: secret, toolName: secret, rawInput: { command: secret }, options: [] }),
    ev('permission_resolved', { requestId: 'p-x', decision: 'allow', by: 'user', optionId: secret }),
    ev('permission_request', { requestId: 'p-y', title: secret, toolName: 'Bash', options: [] }),
    ev('permission_resolved', { requestId: 'p-y', decision: 'cancelled', by: 'timeout' }),
    ev('question', { requestId: 'q-x', questions: [{ id: 'a', prompt: secret, allowFreeText: true }] }),
    ev('question_resolved', { requestId: 'q-x', answers: { a: secret } }),
    ev('error', { code: 'tool_failed', message: secret, fatal: false }),
    ev('session_ended', { reason: 'process_exit', exitCode: 1, message: secret }),
  ];
}

function session(p: FixtureProvider): ChatFixture {
  const f = new ChatFixture();
  const prof = PROFILES[p];
  f.start(prof.driver, prof.provider, prof.capabilities);
  return f;
}

beforeEach(() => {
  rt = fakeRuntime();
  setProducingRuntime(rt);
  installAgentTelemetry(() => undefined);
  installChatTelemetry();
});
afterEach(() => {
  setProducingRuntime(null);
  _resetChatTelemetryForTests();
  _resetAgentTelemetryForTests();
  removeAllChatEventListeners();
});

describe('chat turns', () => {
  it.each(FIXTURE_PROVIDERS)('replays one turn span with driver, end reason, tool calls and tokens (%s)', (p) => {
    publish(chatFixture(p, 'conversation'));
    const [turn] = spans('clubhouse.agent.turn');
    expect(turn).toBeDefined();
    expect(turn.outcome).toBe('ok');
    expect(turn.endMs - turn.startMs).toBe(72_000);
    expect(attr(turn.attrs, 'clubhouse.chat.driver')).toBe(PROFILES[p].driver);
    expect(attr(turn.attrs, 'clubhouse.orchestrator')).toBe(PROFILES[p].provider);
    expect(attr(turn.attrs, 'clubhouse.turn.end_reason')).toBe('complete');
    // Five explore calls, two edits and one command.
    expect(attr(turn.attrs, 'clubhouse.turn.tool_calls')).toBe(8);
    expect(attr(turn.attrs, 'clubhouse.turn.time_to_first_token_ms')).toBeGreaterThan(0);
    expect(_openTurnsForTests()).toBe(0);

    const durations = counts('clubhouse.agent.turn.duration');
    expect(durations).toHaveLength(1);
    expect(durations[0].value).toBe(72);
    expect(counts('clubhouse.agent.turn.time_to_first_token')).toHaveLength(1);
  });

  it('counts tokens by type from the turn usage event when turn_ended has none', () => {
    publish(chatFixture('codex', 'conversation'));
    const tokens = counts('clubhouse.agent.tokens');
    expect(tokens.map((t) => [attr(t.attrs, 'gen_ai.token.type'), t.value])).toEqual([['input', 24_600], ['output', 1_800]]);
    const [turn] = spans('clubhouse.agent.turn');
    expect(attr(turn.attrs, 'gen_ai.usage.input_tokens')).toBe(24_600);
    expect(counts('clubhouse.agent.cost')).toHaveLength(0);
  });

  it('counts cost and flags API-price estimates', () => {
    publish(chatFixture('claude', 'conversation'));
    const [cost] = counts('clubhouse.agent.cost');
    expect(cost.value).toBe(0.31);
    expect(attr(cost.attrs, 'clubhouse.cost.estimate')).toBe(true);
  });

  it('marks a failed turn with the chat error code', () => {
    publish(chatFixture('claude', 'turn_error'));
    const [turn] = spans('clubhouse.agent.turn');
    expect(turn.outcome).toBe('error');
    expect(turn.errorType).toBe('rate_limited');
    expect(attr(turn.attrs, 'clubhouse.turn.end_reason')).toBe('error');
  });

  it.each([
    ['end_turn', 'complete'], ['cancelled', 'cancelled'], ['timeout', 'timeout'],
    ['max_tokens', 'error'], ['max_turns', 'error'], ['refusal', 'error'], ['error', 'error'],
  ] as const)('maps stop reason %s to %s', (stop, reason) => {
    expect(endReasonFor(stop)).toBe(reason);
  });

  it('uses the stop reason as error.type for max_tokens and refusal', () => {
    const f = new ChatFixture();
    const prof = PROFILES.claude;
    f.start(prof.driver, prof.provider, prof.capabilities);
    f.prompt('t1', 'hi');
    f.end('t1', { stopReason: 'refusal' });
    publish(f.events);
    expect(spans('clubhouse.agent.turn')[0]).toMatchObject({ outcome: 'error', errorType: 'refusal' });
  });

  it('records a cancelled turn as cancelled, not an error', () => {
    const f = new ChatFixture();
    const prof = PROFILES.codex;
    f.start(prof.driver, prof.provider, prof.capabilities);
    f.prompt('t1', 'hi');
    f.end('t1', { stopReason: 'cancelled' });
    publish(f.events);
    expect(spans('clubhouse.agent.turn')[0]).toMatchObject({ outcome: 'cancelled' });
  });
});

describe('tool calls and permissions', () => {
  it('counts each completed tool call once, bucketed by built-in name', () => {
    publish(chatFixture('claude', 'conversation'));
    const calls = counts('clubhouse.agent.tool_calls');
    // Reads and searches carry no native tool name in the fixture, so they bucket as `other`.
    expect(calls).toHaveLength(8);
    expect(calls.filter((c) => attr(c.attrs, 'clubhouse.tool.bucket') === 'Bash')).toHaveLength(1);
    expect(calls.filter((c) => attr(c.attrs, 'clubhouse.tool.bucket') === 'Edit')).toHaveLength(1);
    expect(calls.filter((c) => attr(c.attrs, 'clubhouse.tool.bucket') === 'Write')).toHaveLength(1);
    expect(calls.every((c) => attr(c.attrs, 'clubhouse.tool.result') === 'ok')).toBe(true);
  });

  it('never exports a native tool name outside the built-in list', () => {
    publish(chatFixture('codex', 'conversation'));
    const buckets = counts('clubhouse.agent.tool_calls').map((c) => attr(c.attrs, 'clubhouse.tool.bucket'));
    expect(buckets).not.toContain('commandExecution');
    expect(buckets).not.toContain('fileChange');
  });

  it.each(FIXTURE_PROVIDERS)('replays a chat-path permission span when the request resolves (%s)', (p) => {
    const events = chatFixture(p, 'approval');
    const last = events[events.length - 1];
    publish([...events, { ...last, seq: last.seq + 1, ts: last.ts + 4000, type: 'permission_resolved', data: { requestId: 'perm-1', decision: 'deny', by: 'annex' } } as ChatEvent]);
    const [perm] = spans('clubhouse.agent.permission');
    expect(perm.endMs - perm.startMs).toBe(4200);
    expect(attr(perm.attrs, 'clubhouse.permission.path')).toBe('chat');
    expect(attr(perm.attrs, 'clubhouse.permission.decision')).toBe('deny');
    expect(attr(perm.attrs, 'clubhouse.permission.source')).toBe('annex');
    expect(attr(perm.attrs, 'clubhouse.permission.result')).toBe('resolved');
    const [wait] = counts('clubhouse.agent.permission.wait');
    expect(wait.value).toBeCloseTo(4.2);
    expect(attr(wait.attrs, 'clubhouse.permission.path')).toBe('chat');
  });
});

describe('drift and stalls', () => {
  it.each(FIXTURE_PROVIDERS)('counts protocol_unknown by driver and kind, never by name (%s)', (p) => {
    publish(chatFixture(p, 'protocol_drift'));
    const unknown = counts('clubhouse.chat.protocol.unknown');
    expect(unknown.map((u) => attr(u.attrs, 'clubhouse.chat.protocol.kind'))).toEqual(['notification', 'field']);
    expect(unknown.every((u) => attr(u.attrs, 'clubhouse.chat.driver') === PROFILES[p].driver)).toBe(true);
    expect(unknown.flatMap((u) => u.attrs).some((a) => String(a.value).includes('/') || String(a.value).includes('premium'))).toBe(false);
  });

  it('counts a turn with no events for five minutes as stalled, once', () => {
    const events = chatFixture('codex', 'steer');
    publish(events);
    const last = events[events.length - 1].ts;
    _scanStallsForTests(last + TURN_STALL_MS - 1);
    expect(counts('clubhouse.agent.turn.stalled')).toHaveLength(0);
    _scanStallsForTests(last + TURN_STALL_MS);
    _scanStallsForTests(last + 2 * TURN_STALL_MS);
    const stalled = counts('clubhouse.agent.turn.stalled');
    expect(stalled).toHaveLength(1);
    expect(attr(stalled[0].attrs, 'clubhouse.chat.driver')).toBe('codex_app_server');
  });

  it('does not count a turn waiting on the user as stalled', () => {
    const events = chatFixture('claude', 'approval');
    publish(events);
    _scanStallsForTests(events[events.length - 1].ts + 2 * TURN_STALL_MS);
    expect(counts('clubhouse.agent.turn.stalled')).toHaveLength(0);
  });
});

describe('runs, privacy and cost when off', () => {
  it('opens one chat run per agent and records first output', () => {
    publish(chatFixture('claude', 'conversation'));
    expect(_activeRunsForTests()).toBe(1);
    expect(counts('clubhouse.agent.time_to_first_output')).toHaveLength(1);
    expect(attr(counts('clubhouse.agent.time_to_first_output')[0].attrs, 'clubhouse.agent.runtime')).toBe('chat');
  });

  it('exports no text, ids or paths from any fixture or lifecycle event', () => {
    const SECRET = 'SECRET-text /Users/me/project';
    for (const p of FIXTURE_PROVIDERS) {
      for (const s of FIXTURE_SCENARIOS) {
        const agentId = `${FIXTURE_AGENT_ID}-${p}-${s}`;
        publish(withEverything(chatFixture(p, s, agentId), SECRET));
      }
    }
    const all: TelAttr[] = [
      ...vi.mocked(rt.replaySpan).mock.calls.flatMap((c) => c[0].attrs),
      ...vi.mocked(rt.count).mock.calls.flatMap((c) => (c[2] ?? []) as TelAttr[]),
      ...vi.mocked(rt.event).mock.calls.flatMap((c) => (c[1] ?? []) as TelAttr[]),
      ...vi.mocked(rt.replayTree).mock.calls.flatMap((c) => [c[0].root, ...c[0].children].flatMap((n) => n.attrs)),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const a of all) {
      expect(['enum', 'int', 'bool']).toContain(a.kind);
      if (typeof a.value === 'string') {
        expect(a.value).not.toMatch(/[/\s]/);
        expect(a.value).not.toContain(FIXTURE_AGENT_ID);
        expect(a.value).not.toContain('SECRET');
      }
    }
    // Exceptions would carry stack text; the subscriber never reports any.
    expect(rt.exception).not.toHaveBeenCalled();
    // Every span and metric emitted is a registered name.
    for (const c of vi.mocked(rt.replaySpan).mock.calls) expect(c[0].name).toMatch(/^clubhouse\./);
  });

  it('does nothing while telemetry is off', () => {
    setProducingRuntime(null);
    publish(chatFixture('claude', 'conversation'));
    expect(_openTurnsForTests()).toBe(0);
    expect(_activeRunsForTests()).toBe(0);
    expect(rt.count).not.toHaveBeenCalled();
    expect(rt.replaySpan).not.toHaveBeenCalled();
  });

  it('keeps the attribute values inside the registry', () => {
    publish(chatFixture('copilot', 'conversation'));
    const [turn] = spans('clubhouse.agent.turn');
    expect(() => ATTR.chatDriver(attr(turn.attrs, 'clubhouse.chat.driver') as never)).not.toThrow();
  });
});

describe('review fixes', () => {
  it('fails an open turn when the CLI exits mid-turn without turn_ended', () => {
    const f = session('codex');
    f.prompt('t1', 'go');
    f.emit('session_ended', { reason: 'process_exit', exitCode: 1 }, { advanceMs: 3000 });
    publish(f.events);
    const [turn] = spans('clubhouse.agent.turn');
    expect(turn).toMatchObject({ outcome: 'error', errorType: 'process_exited' });
    expect(attr(turn.attrs, 'clubhouse.turn.end_reason')).toBe('error');
    expect(_openTurnsForTests()).toBe(0);
  });

  it('keeps a chat error code when the CLI then exits mid-turn', () => {
    const f = session('codex');
    f.prompt('t1', 'go');
    f.emit('error', { code: 'driver_stream_failed', message: 'x', fatal: true }, { turnId: 't1' });
    f.emit('session_ended', { reason: 'error' });
    publish(f.events);
    expect(spans('clubhouse.agent.turn')[0]).toMatchObject({ outcome: 'error', errorType: 'driver_stream_failed' });
  });

  it('cancels an open turn when the session is stopped', () => {
    const f = session('claude');
    f.prompt('t1', 'go');
    f.emit('session_ended', { reason: 'stopped', exitCode: 0 });
    publish(f.events);
    const [turn] = spans('clubhouse.agent.turn');
    expect(turn.outcome).toBe('cancelled');
    expect(attr(turn.attrs, 'clubhouse.turn.end_reason')).toBe('cancelled');
  });

  it('does not count a chat start that fell back to the terminal', () => {
    const f = session('claude');
    f.emit('session_ended', { reason: 'fallback', message: 'Chat start failed; using the terminal' });
    publish(f.events);
    expect(_activeRunsForTests()).toBe(0);
    expect(spans('clubhouse.agent.turn')).toHaveLength(0);
    expect(counts('clubhouse.agent.runs')).toHaveLength(0);
  });

  it('skips permissions the agent withdrew itself', () => {
    const f = session('claude');
    f.prompt('t1', 'go');
    f.emit('permission_request', { requestId: 'r1', title: 't', toolName: 'Bash', options: [] }, { turnId: 't1' });
    f.emit('permission_resolved', { requestId: 'r1', decision: 'cancelled', by: 'agent' });
    publish(f.events);
    expect(spans('clubhouse.agent.permission')).toHaveLength(0);
    expect(counts('clubhouse.agent.permission.wait')).toHaveLength(0);
  });

  it('records a timed-out chat permission as a timeout', () => {
    const f = session('claude');
    f.emit('permission_request', { requestId: 'r1', title: 't', toolName: 'Bash', options: [] });
    f.emit('permission_resolved', { requestId: 'r1', decision: 'cancelled', by: 'timeout' });
    publish(f.events);
    const [perm] = spans('clubhouse.agent.permission');
    expect(perm.outcome).toBe('timeout');
    expect(attr(perm.attrs, 'clubhouse.permission.result')).toBe('timeout');
  });

  it('counts a tool call once even if it repeats or updates after completing', () => {
    const f = session('claude');
    f.prompt('t1', 'go');
    f.emit('tool_call', { toolCallId: 'c1', kind: 'execute', title: 'ls', status: 'in_progress', toolName: 'Bash' }, { turnId: 't1' });
    f.emit('tool_call_update', { toolCallId: 'c1', status: 'completed' }, { turnId: 't1' });
    f.emit('tool_call_update', { toolCallId: 'c1', status: 'completed' }, { turnId: 't1' });
    f.emit('tool_call', { toolCallId: 'c1', kind: 'execute', title: 'ls', status: 'completed', toolName: 'Bash' }, { turnId: 't1' });
    f.end('t1', { stopReason: 'end_turn' });
    publish(f.events);
    expect(counts('clubhouse.agent.tool_calls')).toHaveLength(1);
    expect(attr(spans('clubhouse.agent.turn')[0].attrs, 'clubhouse.turn.tool_calls')).toBe(1);
  });
});
