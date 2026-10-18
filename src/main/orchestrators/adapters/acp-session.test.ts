import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { AcpResumeStalledError, AcpSession, CLUBHOUSE_ACP_CLIENT_CAPABILITIES, GENERIC_ACP_PROFILE, SESSION_CLOSE_TIMEOUT_MS, type AcpSessionEvent, type AcpSessionOpts } from './acp-session';
import { RpcError } from './acp-client';
import { selectAcpProfile } from './copilot-acp';
import {
  AcpFixtureReplayer,
  loadAcpFixture,
  promptAnsweredEarly,
  withoutRequest,
  type AcpFixtureRecord,
  type OutMatcher,
} from './__fixtures__/acp/acp-replay';
import type { SessionConfigSelect, SessionUpdate } from './acp-schema';

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stdin = { writable: true, write: vi.fn((..._args: unknown[]) => true) };
  return Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    exitCode: null as number | null,
    pid: 4242,
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const CWD = '/workspace/project';
const COPILOT = 'copilot-cli';

function setup(records: AcpFixtureRecord[], opts: Partial<AcpSessionOpts> = {}, matcher?: OutMatcher) {
  const proc = createMockProcess();
  mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  const replayer = new AcpFixtureReplayer(proc, records, matcher);
  const events: AcpSessionEvent[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const session = new AcpSession({
    binary: 'copilot',
    args: ['--acp', '--stdio'],
    cwd: CWD,
    profile: selectAcpProfile,
    onLog: (level, message) => logs.push({ level, message }),
    ...opts,
    onEvent: (e) => {
      events.push(e);
      opts.onEvent?.(e);
    },
  });
  return { proc, replayer, session, events, logs };
}

const updates = (events: AcpSessionEvent[], kind?: SessionUpdate['sessionUpdate']) =>
  events.flatMap((e) => (e.type === 'update' && (!kind || e.update.sessionUpdate === kind) ? [e] : []));

// ── Inline scripts for agents other than Copilot ─────────────────────────────

const out = (id: number | undefined, method?: string, extra: Record<string, unknown> = {}): AcpFixtureRecord =>
  ({ dir: 'out', msg: { jsonrpc: '2.0', ...(id !== undefined && { id }), ...(method && { method }), ...extra } });
const inMsg = (msg: Record<string, unknown>): AcpFixtureRecord => ({ dir: 'in', msg: { jsonrpc: '2.0', ...msg } });
const update = (u: Record<string, unknown>, sessionId = 's1') =>
  inMsg({ method: 'session/update', params: { sessionId, update: u } });

function genericStart(agentCapabilities: Record<string, unknown> = {}, protocolVersion = 1): AcpFixtureRecord[] {
  return [
    out(1, 'initialize'),
    inMsg({ id: 1, result: { protocolVersion, agentCapabilities, agentInfo: { name: 'example-agent', version: '0.1.0' } } }),
  ];
}
const genericNew = (result: Record<string, unknown> = {}): AcpFixtureRecord[] => [
  out(2, 'session/new'),
  inMsg({ id: 2, result: { sessionId: 's1', ...result } }),
];

beforeEach(() => {
  mockSpawn.mockReset();
});

// ── Copilot recordings ───────────────────────────────────────────────────────

describe('AcpSession against Copilot 1.0.92 recordings', () => {
  it('initializes with Clubhouse capabilities and picks the Copilot profile', async () => {
    const { session, replayer } = setup(loadAcpFixture(COPILOT, 'handshake-list-close.jsonl'));
    const caps = await session.start();

    expect(replayer.written[0]).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: CLUBHOUSE_ACP_CLIENT_CAPABILITIES },
    });
    expect(session.profileId).toBe('copilot');
    expect(caps).toMatchObject({ resume: 'load', listSessions: true, closeSession: true, login: 'terminal' });
    expect(replayer.errors).toEqual([]);
  });

  it('creates a session with modes, deduped config options and early commands', async () => {
    const { session, replayer, events } = setup(loadAcpFixture(COPILOT, 'handshake-list-close.jsonl'));
    await session.start();
    const state = await session.newSession({ cwd: CWD });

    expect(state.sessionId).toBe('0e649d35-c02a-4b55-af6b-dd4815f511fd');
    expect(state.modes?.availableModes.map((m) => m.name)).toEqual(['Agent', 'Plan', 'Autopilot']);
    expect(state.configOptions.map((o) => o.id)).toEqual(['mode', 'model', 'reasoning_effort', 'allow_all']);
    const model = state.configOptions.find((o) => o.id === 'model') as SessionConfigSelect;
    const values = (model.options as Array<{ value: string }>).map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(state.legacyModels!.availableModels.map((m) => m.modelId)).size).toBe(state.legacyModels!.availableModels.length);
    // The command list arrived before the session/new response.
    expect(state.availableCommands.length).toBeGreaterThan(20);
    expect(updates(events, 'available_commands_update').length).toBeGreaterThanOrEqual(1);
    expect(replayer.errors).toEqual([]);
  });

  it('lists every session, rejects an invalid mode with the agent error, and closes', async () => {
    const records = withoutRequest(loadAcpFixture(COPILOT, 'handshake-list-close.jsonl'), 'session/does_not_exist');
    const { session, replayer } = setup(records);
    await session.start();
    await session.newSession({ cwd: CWD });

    const listed = await session.listSessions();
    expect(listed.sessions).toHaveLength(3);

    const err = await session.setMode('__nonexistent__').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32602);

    await session.close();
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });

  it('runs one prompt turn: thoughts, tool call, permission, usage, stop reason', async () => {
    const matchModel: OutMatcher = (expected, actual) =>
      expected.method === 'session/set_config_option'
        && JSON.stringify(expected.params) !== JSON.stringify(actual.params)
        ? `set_config_option params differ: ${JSON.stringify(actual.params)}`
        : null;
    let sessionRef: AcpSession | null = null;
    const { session, replayer, events } = setup(loadAcpFixture(COPILOT, 'one-prompt.jsonl'), {
      onEvent: (e) => {
        if (e.type === 'permission_request') sessionRef!.respondToPermission(e.requestId, { optionId: 'allow_once' });
      },
    }, matchModel);
    sessionRef = session;
    await session.start();
    await session.newSession({ cwd: CWD });
    await session.setModel('gpt-5-mini');

    const result = await session.prompt('Create a file named hello.txt in the current directory containing exactly the word hi. Do nothing else and reply with one word.');

    expect(result).toEqual({
      stopReason: 'end_turn',
      usage: { inputTokens: 26255, outputTokens: 854, totalTokens: 27109, thoughtTokens: 704, cachedReadTokens: 12800, cachedWriteTokens: 0 },
    });

    const turn = events.slice(events.findIndex((e) => e.type === 'turn_started'));
    expect(turn[0].type).toBe('turn_started');
    expect(turn[turn.length - 1]).toMatchObject({ type: 'turn_ended', stopReason: 'end_turn' });

    expect(updates(turn, 'agent_thought_chunk')).toHaveLength(192);
    const text = updates(turn, 'agent_message_chunk')
      .map((e) => (e.update.sessionUpdate === 'agent_message_chunk' && e.update.content.type === 'text' ? e.update.content.text : ''))
      .join('');
    expect(text).toBe("Creating hello.txt containing 'hi' to satisfy the request.Done");

    const toolCall = updates(turn, 'tool_call')[0].update;
    expect(toolCall).toMatchObject({ kind: 'edit', status: 'pending', content: [{ type: 'diff', path: '/workspace/project/hello.txt', newText: 'hi' }] });
    expect(updates(turn, 'tool_call_update')[0].update).toMatchObject({ status: 'completed' });

    const permission = turn.find((e) => e.type === 'permission_request');
    expect(permission).toMatchObject({ options: [{ kind: 'allow_once' }, { kind: 'allow_always' }, { kind: 'reject_once' }] });
    expect(turn.find((e) => e.type === 'permission_resolved')).toMatchObject({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

    const state = session.getState();
    expect(state.title).toMatch(/^Create a file named hello.txt/);
    expect(state.context).toEqual({ used: 14981, size: 128000 });
    expect(state.turnInFlight).toBe(false);
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });

  it('resumes through session/load and marks the history replay', async () => {
    const { session, replayer, events } = setup(loadAcpFixture(COPILOT, 'load-replay.jsonl'));
    await session.start();
    const res = await session.resumeSession('5af70548-c3ac-4e25-b105-bec13faa1f20', { cwd: CWD });

    expect(res).toEqual({ method: 'load' });
    expect(replayer.written[1]).toMatchObject({ method: 'session/load', params: { sessionId: '5af70548-c3ac-4e25-b105-bec13faa1f20', cwd: CWD, mcpServers: [] } });
    const replayed = updates(events).filter((e) => e.replay).map((e) => e.update.sessionUpdate);
    expect(replayed).toEqual(expect.arrayContaining(['user_message_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update']));
    // The command list that follows the load response in the same chunk is live, not replay.
    const commandLists = updates(events, 'available_commands_update');
    expect(commandLists.map((e) => e.replay)).toEqual([true, false]);
    expect(session.getState().configOptions.length).toBe(4);
    expect(replayer.errors).toEqual([]);
  });

  it('sets config options and modes, filters the machine-wide list by cwd, authenticates', async () => {
    let records = loadAcpFixture(COPILOT, 'method-coverage.jsonl');
    for (const skipped of ['session/set_model', 'session/resume', 'session/fork', '$/cancel_request', 'session/load']) {
      records = withoutRequest(records, skipped);
    }
    const { session, replayer, events } = setup(records);
    await session.start();
    await session.newSession({ cwd: CWD });

    const options = await session.setConfigOption('reasoning_effort', 'low');
    expect(options.find((o) => o.id === 'reasoning_effort')?.currentValue).toBe('low');

    const plan = 'https://agentclientprotocol.com/protocol/session-modes#plan';
    await session.setMode(plan);
    expect(session.getState().modes?.currentModeId).toBe(plan);
    expect(updates(events, 'current_mode_update')[0].update).toMatchObject({ currentModeId: plan });

    const listed = await session.listSessions({ cwd: CWD });
    expect(listed.sessions.map((s) => s.cwd)).toEqual([CWD, CWD]);

    await session.authenticate('copilot-login');
    await session.close();
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });
});

// ── Generic ACP agents ───────────────────────────────────────────────────────

describe('AcpSession as a generic ACP driver', () => {
  it('uses the generic profile and session/resume when the agent offers it', async () => {
    const { session, replayer, events } = setup([
      ...genericStart({ loadSession: true, sessionCapabilities: { resume: {} } }),
      out(2, 'session/resume'),
      update({ sessionUpdate: 'current_mode_update', currentModeId: 'code' }),
      inMsg({ id: 2, result: { modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] } } }),
    ]);
    const caps = await session.start();
    expect(session.profileId).toBe(GENERIC_ACP_PROFILE.id);
    expect(caps.resume).toBe('resume');

    expect(await session.resumeSession('s1', { cwd: CWD })).toEqual({ method: 'resume' });
    expect(updates(events)[0].replay).toBe(false);
    expect(session.getState().modes?.currentModeId).toBe('code');
    expect(replayer.errors).toEqual([]);
  });

  it('close() kills an agent that never answers session/close after a short wait, not the full RPC timeout', async () => {
    const { session, proc } = setup([
      ...genericStart({ sessionCapabilities: { close: {} } }),
      ...genericNew(),
      out(3, 'session/close'), // sent, never answered
    ], { rpcTimeoutMs: 60_000 });
    await session.start();
    await session.newSession({ cwd: CWD });

    vi.useFakeTimers();
    try {
      const closed = session.close();
      await vi.advanceTimersByTimeAsync(SESSION_CLOSE_TIMEOUT_MS);
      await closed;
    } finally {
      vi.useRealTimers();
    }
    expect(proc.kill).toHaveBeenCalled();
  });

  it('leaves no state behind when a load replays history and then fails', async () => {
    const { session, events } = setup([
      ...genericStart({ loadSession: true }),
      out(2, 'session/load'),
      update({ sessionUpdate: 'session_info_update', title: 'Old' }, 'gone'),
      update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'x', description: 'x' }] }, 'gone'),
      update({ sessionUpdate: 'usage_update', used: 5, size: 10 }, 'gone'),
      update({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'old', status: 'pending' }, 'gone'),
      inMsg({ id: 2, error: { code: -32002, message: 'Resource not found' } }),
      ...genericNew(),
    ]);
    await session.start();
    await expect(session.resumeSession('gone', { cwd: CWD })).rejects.toThrow(/Resource not found/);
    expect(events.filter((e) => e.type === 'update').every((e) => e.type === 'update' && e.replay)).toBe(true);
    const state = await session.newSession({ cwd: CWD });
    expect(state).toMatchObject({ sessionId: 's1', title: null, availableCommands: [], context: null, modes: null, configOptions: [] });
  });

  it('rejects an agent that negotiates another protocol version', async () => {
    const { session, proc } = setup(genericStart({}, 2));
    await expect(session.start()).rejects.toThrow(/protocol version 2/);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('skips unknown and malformed updates, logging each kind once', async () => {
    const { session, events, logs } = setup([
      ...genericStart(),
      ...genericNew(),
      out(3, 'session/prompt'),
      update({ sessionUpdate: 'subagent_started', id: 'a' }),
      update({ sessionUpdate: 'subagent_started', id: 'b' }),
      update({ sessionUpdate: 'usage_update', used: 1 }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'other session' } }, 's2'),
      inMsg({ id: 3, result: { stopReason: 'end_turn' } }),
    ]);
    await session.start();
    await session.newSession({ cwd: CWD });
    await session.prompt('hi');

    const unknown = events.filter((e) => e.type === 'unknown_update');
    expect(unknown.map((e) => e.type === 'unknown_update' && e.kind)).toEqual(['subagent_started', 'subagent_started', 'usage_update']);
    expect(logs.filter((l) => l.message === 'Skipping unsupported ACP session/update')).toHaveLength(2);
    expect(updates(events, 'agent_message_chunk')).toHaveLength(1);
    expect(session.getState().context).toBeNull();
  });

  it('cancel answers pending permissions as cancelled before session/cancel', async () => {
    const permission = {
      id: 7,
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
        toolCall: { toolCallId: 't1', title: 'rm -rf build', kind: 'execute' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'never', name: 'Never', kind: 'reject_always' },
        ],
      },
    };
    let sessionRef: AcpSession | null = null;
    const { session, replayer, events } = setup([
      ...genericStart(),
      ...genericNew(),
      out(3, 'session/prompt'),
      inMsg(permission),
      out(7, undefined, { result: { outcome: { outcome: 'cancelled' } } }),
      out(undefined, 'session/cancel'),
      inMsg({ id: 3, result: { stopReason: 'cancelled' } }),
    ], {
      onEvent: (e) => {
        if (e.type === 'permission_request') queueMicrotask(() => sessionRef!.cancel());
      },
    }, (expected, actual) =>
      expected.result && JSON.stringify(expected.result) !== JSON.stringify(actual.result) ? `bad outcome ${JSON.stringify(actual.result)}` : null);
    sessionRef = session;
    await session.start();
    await session.newSession({ cwd: CWD });

    const result = await session.prompt('clean up');
    expect(result.stopReason).toBe('cancelled');
    expect(events.find((e) => e.type === 'permission_resolved')).toMatchObject({ outcome: { outcome: 'cancelled' } });
    expect(session.pendingPermissionIds).toEqual([]);
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });

  it('refuses a permission option the agent did not offer', async () => {
    let requestId = '';
    const { session } = setup([
      ...genericStart(),
      ...genericNew(),
      out(3, 'session/prompt'),
      inMsg({
        id: 0,
        method: 'session/request_permission',
        params: { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: [{ optionId: 'ok', name: 'OK', kind: 'allow_once' }] },
      }),
    ], { onEvent: (e) => { if (e.type === 'permission_request') requestId = e.requestId; } });
    await session.start();
    await session.newSession({ cwd: CWD });
    void session.prompt('x').catch((): void => undefined);
    await tick();

    expect(requestId).toBe('0');
    expect(() => session.respondToPermission(requestId, { optionId: 'allow_always' })).toThrow(/not offered/);
    expect(session.pendingPermissionIds).toEqual(['0']);
  });

  it('keeps an unknown stop reason and rejects overlapping prompts', async () => {
    const { session } = setup([
      ...genericStart(),
      ...genericNew(),
      out(3, 'session/prompt'),
      inMsg({ id: 3, result: { stopReason: 'paused_for_review' } }),
    ]);
    await session.start();
    await session.newSession({ cwd: CWD });
    const first = session.prompt('one');
    await expect(session.prompt('two')).rejects.toThrow(/already in flight/);
    expect(await first).toEqual({ stopReason: 'unknown', rawStopReason: 'paused_for_review' });
  });

  it('answers client methods it does not serve with method-not-found', async () => {
    const { session, replayer } = setup([
      ...genericStart(),
      ...genericNew(),
      out(3, 'session/prompt'),
      inMsg({ id: 9, method: 'fs/read_text_file', params: { sessionId: 's1', path: '/etc/hosts' } }),
      out(9),
      inMsg({ id: 3, result: { stopReason: 'end_turn' } }),
    ]);
    await session.start();
    await session.newSession({ cwd: CWD });
    await session.prompt('read it');

    expect(replayer.written.find((m) => m.id === 9)).toMatchObject({ error: { code: -32601, data: { method: 'fs/read_text_file' } } });
    expect(replayer.errors).toEqual([]);
  });

  it('sends boolean config options with their type tag', async () => {
    const { session, replayer } = setup([
      ...genericStart(),
      ...genericNew({ configOptions: [{ type: 'boolean', id: 'yolo', name: 'YOLO', currentValue: false }] }),
      out(3, 'session/set_config_option'),
      inMsg({ id: 3, result: { configOptions: [{ type: 'boolean', id: 'yolo', name: 'YOLO', currentValue: true }] } }),
    ]);
    await session.start();
    await session.newSession({ cwd: CWD });
    await session.setConfigOption('yolo', true);

    expect(replayer.written[2]).toMatchObject({ params: { sessionId: 's1', configId: 'yolo', type: 'boolean', value: true } });
    expect(session.getState().configOptions[0].currentValue).toBe(true);
  });

  it('falls back to session/set_model for agents with only the legacy model list', async () => {
    const { session, replayer } = setup([
      ...genericStart(),
      ...genericNew({ models: { currentModelId: 'a', availableModels: [{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }] } }),
      out(3, 'session/set_model'),
      inMsg({ id: 3, result: {} }),
    ]);
    await session.start();
    await session.newSession({ cwd: CWD });
    await session.setModel('b');

    expect(replayer.written[2]).toMatchObject({ method: 'session/set_model', params: { sessionId: 's1', modelId: 'b' } });
    expect(session.getState().legacyModels?.currentModelId).toBe('b');
  });

  it('ends the turn with an error when the agent exits mid-turn', async () => {
    const { session, proc, events } = setup([...genericStart(), ...genericNew(), out(3, 'session/prompt')]);
    await session.start();
    await session.newSession({ cwd: CWD });
    const turn = session.prompt('hello');
    await tick();
    proc.emit('exit', 1, null);

    await expect(turn).rejects.toThrow(/exited with code 1/);
    await tick();
    const types = events.map((e) => e.type);
    // turn_ended must precede exit so consumers that stop at exit still see it.
    expect(types.slice(-2)).toEqual(['turn_ended', 'exit']);
    expect(events.find((e) => e.type === 'turn_ended')).toMatchObject({ stopReason: 'error', errorKind: 'process_exited' });
    expect(events.find((e) => e.type === 'exit')).toEqual({ type: 'exit', code: 1, signal: null });
    expect(session.getState().turnInFlight).toBe(false);
  });
});

/** The rejection of a settled load, or undefined when it succeeded. */
const errOf = (r: { ok: boolean }): unknown => (r as { err?: unknown }).err;

describe('AcpSession resume timeouts (#2155)', () => {
  const loadOnly = () => [...genericStart({ loadSession: true }), out(2, 'session/load')];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function startLoad(opts: Partial<AcpSessionOpts>) {
    const { session, proc, replayer } = setup(loadOnly(), opts);
    await session.start();
    const loading = session.resumeSession('s1', { cwd: CWD }).then(
      (v) => ({ ok: true as const, v }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await vi.waitFor(() => expect(replayer.written[1]).toMatchObject({ method: 'session/load' }), { interval: 5 });
    const say = (msg: Record<string, unknown>) => proc.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    const replay = (i: number) => say({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `old ${i}` } } } });
    return { loading, say, replay, loadId: replayer.written[1].id };
  }

  it('waits out a silent start longer than the between-updates window', async () => {
    const { loading, say, replay, loadId } = await startLoad({ resumeFirstReplyTimeoutMs: 400, resumeStallTimeoutMs: 60 });
    // Silent for 200ms (over the 60ms stall window, under the 400ms first-reply window),
    // then replays steadily and answers.
    await sleep(200);
    for (let i = 0; i < 3; i++) { replay(i); await sleep(30); }
    say({ id: loadId, result: {} });
    expect(await loading).toMatchObject({ ok: true, v: { method: 'load' } });
  });

  it('gives up when nothing comes back within the first-reply window', async () => {
    const { loading } = await startLoad({ resumeFirstReplyTimeoutMs: 50, resumeStallTimeoutMs: 1_000 });
    const result = await loading;
    expect(result.ok).toBe(false);
    expect(errOf(result)).toMatchObject({ name: 'AcpResumeStalledError', reason: 'no_reply', timeoutMs: 50 });
  });

  it('gives up when replay goes quiet', async () => {
    const { loading, replay } = await startLoad({ resumeFirstReplyTimeoutMs: 1_000, resumeStallTimeoutMs: 50 });
    replay(0);
    const result = await loading;
    expect(errOf(result)).toMatchObject({ reason: 'stalled', timeoutMs: 50 });
  });

  it('caps a load that keeps replaying forever', async () => {
    const { loading, replay } = await startLoad({ resumeFirstReplyTimeoutMs: 1_000, resumeStallTimeoutMs: 1_000, resumeMaxMs: 150 });
    let i = 0;
    const timer = setInterval(() => replay(i++), 20);
    const result = await loading;
    clearInterval(timer);
    expect(errOf(result)).toBeInstanceOf(AcpResumeStalledError);
    expect(errOf(result)).toMatchObject({ reason: 'too_long', timeoutMs: 150 });
  });
});

describe('AcpSession cancelled turns (#2158)', () => {
  it('reports a turn the user stopped as cancelled even when the agent says end_turn', async () => {
    const { session, events } = setup([
      ...genericStart(),
      ...genericNew(),
      out(3, 'session/prompt'),
      out(undefined, 'session/cancel'),
      inMsg({ id: 3, result: { stopReason: 'end_turn' } }),
    ]);
    await session.start();
    await session.newSession({ cwd: CWD });
    const turn = session.prompt('long task');
    await tick();
    session.cancel();
    expect(await turn).toMatchObject({ stopReason: 'cancelled' });
    expect(events.find((e) => e.type === 'turn_ended')).toMatchObject({ stopReason: 'cancelled' });
  });

  it('does not carry a cancel into the next turn', async () => {
    const { session } = setup([
      ...genericStart(),
      ...genericNew(),
      out(3, 'session/prompt'),
      out(undefined, 'session/cancel'),
      inMsg({ id: 3, result: { stopReason: 'cancelled' } }),
      out(4, 'session/prompt'),
      inMsg({ id: 4, result: { stopReason: 'end_turn' } }),
    ]);
    await session.start();
    await session.newSession({ cwd: CWD });
    const first = session.prompt('one');
    await tick();
    session.cancel();
    await first;
    expect(await session.prompt('two')).toMatchObject({ stopReason: 'end_turn' });
  });
});

// ── Agent-initiated turns (#2191) ────────────────────────────────────────────

const MODE = 'https://agentclientprotocol.com/protocol/session-modes#';
const turnEvents = (events: AcpSessionEvent[]) => events.flatMap((e) => {
  if (e.type === 'turn_started') return [`started:${e.trigger}`];
  if (e.type === 'turn_ended') return [`ended:${e.stopReason}`];
  return [];
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await wait(5);
  }
}
const isText = (text: string) => (r: AcpFixtureRecord) =>
  r.dir === 'in' && (r.msg.params as { update?: { content?: { text?: string } } } | undefined)?.update?.content?.text === text;
/** Answer every permission request with its allow_once option. */
const allowAll = (ref: { session?: AcpSession }) => (e: AcpSessionEvent) => {
  if (e.type === 'permission_request') {
    queueMicrotask(() => ref.session!.respondToPermission(e.requestId, { optionId: e.options.find((o) => o.kind === 'allow_once')!.optionId }));
  }
};
const BACKGROUND_PROMPT = 'Start a background agent, end the turn, report when notified.';
const FAST = { agentTurnIdleMs: 40, agentTurnToolIdleMs: 400, agentTurnCancelSettleMs: 20 };

async function startRecordedSession(session: AcpSession, mode: 'agent' | 'autopilot') {
  await session.start();
  await session.newSession({ cwd: CWD });
  await session.setConfigOption('model', 'claude-haiku-4.5');
  await session.setMode(MODE + mode);
}

describe('AcpSession agent-initiated turns, Copilot 1.0.98 recordings', () => {
  it('autopilot does its whole loop inside the prompt and ends with task_complete: no agent turn', async () => {
    const ref: { session?: AcpSession } = {};
    const { replayer, events, session } = setup(loadAcpFixture(COPILOT, 'autopilot-task-complete.jsonl'), { ...FAST, onEvent: allowAll(ref) });
    ref.session = session;
    await startRecordedSession(session, 'autopilot');
    expect(session.getState().modes?.currentModeId).toBe(MODE + 'autopilot');

    const result = await session.prompt('Create a.txt, b.txt and c.txt, one tool call each, then say DONE.');
    expect(result.stopReason).toBe('end_turn');
    await wait(FAST.agentTurnIdleMs * 3);

    expect(turnEvents(events)).toEqual(['started:prompt', 'ended:end_turn']);
    const titles = updates(events, 'tool_call').map((e) => (e.update as { title?: string }).title);
    expect(titles.at(-1)).toBe('task_complete');
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });

  it('a background agent that outlives the turn: 1.0.98 holds the prompt open until its follow-up is done', async () => {
    const ref: { session?: AcpSession } = {};
    const { replayer, events, session } = setup(loadAcpFixture(COPILOT, 'background-agent.jsonl'), { ...FAST, onEvent: allowAll(ref) });
    ref.session = session;
    await startRecordedSession(session, 'agent');

    expect((await session.prompt(BACKGROUND_PROMPT)).stopReason).toBe('end_turn');
    await wait(FAST.agentTurnIdleMs * 3);

    expect(turnEvents(events)).toEqual(['started:prompt', 'ended:end_turn']);
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });
});

describe('AcpSession agent-initiated turns, prompt answered before background work (1.0.82 ordering)', () => {
  // The 1.0.98 recording with the prompt's answer moved to right after
  // "STARTED", where 1.0.82 sent it (lucky-mantis, #2191). Everything after
  // it is Copilot working on its own once the background agent finishes.
  const early = () => promptAnsweredEarly(loadAcpFixture(COPILOT, 'background-agent.jsonl'), isText('STARTED'));

  it('opens an agent turn for the work, and closes it once the agent goes quiet', async () => {
    const ref: { session?: AcpSession } = {};
    const { replayer, events, logs, session } = setup(early(), { ...FAST, onEvent: allowAll(ref) });
    ref.session = session;
    await startRecordedSession(session, 'agent');

    expect((await session.prompt(BACKGROUND_PROMPT)).stopReason).toBe('end_turn');
    await wait(FAST.agentTurnIdleMs * 2);
    expect(turnEvents(events)).toEqual(['started:prompt', 'ended:end_turn']);
    expect(session.getState().agentTurnInFlight).toBe(false);

    const before = events.length;
    replayer.openGate();
    await until(() => session.getState().agentTurnInFlight);
    expect(turnEvents(events)).toEqual(['started:prompt', 'ended:end_turn', 'started:agent']);
    // The turn opens before the update that started it.
    expect(events[before]).toMatchObject({ type: 'turn_started', trigger: 'agent' });
    expect(events[before + 1]).toMatchObject({ type: 'update', replay: false });

    await until(() => !session.getState().agentTurnInFlight);
    expect(turnEvents(events)).toEqual(['started:prompt', 'ended:end_turn', 'started:agent', 'ended:end_turn']);
    const agentTurn = events.slice(events.findIndex((e) => e.type === 'turn_started' && e.trigger === 'agent'));
    expect(agentTurn.some((e) => e.type === 'permission_request')).toBe(true);
    expect(updates(agentTurn, 'tool_call').map((e) => (e.update as { title?: string }).title))
      .toEqual(['Sleep for 30 seconds then list files', 'read_agent', expect.stringContaining('found.txt')]);
    expect(logs.some((l) => l.message === 'Permission request outside a prompt turn')).toBe(false);
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });

  it('keeps the turn open while a permission request waits for the user', async () => {
    const { replayer, events, session } = setup(early(), FAST);
    await startRecordedSession(session, 'agent');
    await session.prompt(BACKGROUND_PROMPT);
    replayer.openGate();
    await until(() => events.some((e) => e.type === 'permission_request'));

    await wait(FAST.agentTurnToolIdleMs + 100);
    expect(session.getState().agentTurnInFlight).toBe(true);

    const request = events.find((e) => e.type === 'permission_request')!;
    session.respondToPermission((request as { requestId: string }).requestId, { optionId: 'allow_once' });
    // The rest streams in, and the second permission request waits for us again.
    await until(() => events.filter((e) => e.type === 'permission_request').length === 2);
    const second = events.filter((e) => e.type === 'permission_request')[1] as { requestId: string };
    session.respondToPermission(second.requestId, { optionId: 'allow_once' });
    await until(() => !session.getState().agentTurnInFlight);
    expect(turnEvents(events).slice(-1)).toEqual(['ended:end_turn']);
    expect(replayer.errors).toEqual([]);
  });

  it('cancel sends session/cancel, answers the pending permission, and ends the agent turn as cancelled', async () => {
    const records = early();
    // Stop at the first permission request of the agent's own work: the user hits Stop there.
    const firstAsk = records.findIndex((r) => r.dir === 'in' && r.msg.method === 'session/request_permission');
    const { replayer, events, session } = setup([
      ...records.slice(0, firstAsk + 1),
      { dir: 'out', msg: { jsonrpc: '2.0', id: records[firstAsk].msg.id, result: { outcome: { outcome: 'cancelled' } } } },
      { dir: 'out', msg: { jsonrpc: '2.0', method: 'session/cancel' } },
    ], FAST);
    await startRecordedSession(session, 'agent');
    await session.prompt(BACKGROUND_PROMPT);
    replayer.openGate();
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(session.getState().agentTurnInFlight).toBe(true);

    session.cancel();
    expect(replayer.written.at(-1)).toMatchObject({ method: 'session/cancel' });
    await until(() => !session.getState().agentTurnInFlight);
    expect(turnEvents(events)).toEqual(['started:prompt', 'ended:end_turn', 'started:agent', 'ended:cancelled']);
    expect(events.find((e) => e.type === 'permission_resolved')).toMatchObject({ outcome: { outcome: 'cancelled' } });
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });

  it('a prompt during the agent turn closes it and runs as its own turn', async () => {
    const records = early();
    const firstAsk = records.findIndex((r) => r.dir === 'in' && r.msg.method === 'session/request_permission');
    // The agent's first tool call arrives, then the user sends a prompt; the agent answers it.
    const { replayer, events, session } = setup([
      ...records.slice(0, firstAsk),
      { dir: 'out', msg: { jsonrpc: '2.0', id: 6, method: 'session/prompt' } },
      { dir: 'in', msg: { jsonrpc: '2.0', id: 6, result: { stopReason: 'end_turn' } } },
    ], { ...FAST, agentTurnToolIdleMs: 60_000 });
    await startRecordedSession(session, 'agent');
    await session.prompt(BACKGROUND_PROMPT);
    replayer.openGate();
    await until(() => session.getState().agentTurnInFlight);

    expect((await session.prompt('What did it find?')).stopReason).toBe('end_turn');
    expect(turnEvents(events)).toEqual(['started:prompt', 'ended:end_turn', 'started:agent', 'ended:end_turn', 'started:prompt', 'ended:end_turn']);
    expect(session.getState().agentTurnInFlight).toBe(false);
    expect(replayer.errors).toEqual([]);
  });

  it('a prompt right after Stop still ends the agent turn as cancelled (#2158)', async () => {
    const records = early();
    const firstAsk = records.findIndex((r) => r.dir === 'in' && r.msg.method === 'session/request_permission');
    const { replayer, events, session } = setup([
      ...records.slice(0, firstAsk),
      { dir: 'out', msg: { jsonrpc: '2.0', method: 'session/cancel' } },
      { dir: 'out', msg: { jsonrpc: '2.0', id: 6, method: 'session/prompt' } },
      { dir: 'in', msg: { jsonrpc: '2.0', id: 6, result: { stopReason: 'end_turn' } } },
    ], { ...FAST, agentTurnToolIdleMs: 60_000, agentTurnCancelSettleMs: 60_000 });
    await startRecordedSession(session, 'agent');
    await session.prompt(BACKGROUND_PROMPT);
    replayer.openGate();
    await until(() => session.getState().agentTurnInFlight);

    session.cancel();
    expect((await session.prompt('Never mind, do this instead')).stopReason).toBe('end_turn');
    expect(turnEvents(events)).toEqual(['started:prompt', 'ended:end_turn', 'started:agent', 'ended:cancelled', 'started:prompt', 'ended:end_turn']);
    expect(replayer.errors).toEqual([]);
  });

  it('ends the agent turn with an error, before exit, when the agent dies mid-work', async () => {
    const { replayer, events, session, proc } = setup(early(), FAST);
    await startRecordedSession(session, 'agent');
    await session.prompt(BACKGROUND_PROMPT);
    replayer.openGate();
    await until(() => session.getState().agentTurnInFlight);

    proc.emit('exit', 1, null);
    await tick();
    expect(events.slice(-2).map((e) => e.type)).toEqual(['turn_ended', 'exit']);
    expect(events.at(-2)).toMatchObject({ type: 'turn_ended', stopReason: 'error', errorKind: 'process_exited' });
    expect(session.getState().agentTurnInFlight).toBe(false);
  });

  it('kill() ends an agent turn as cancelled', async () => {
    const { replayer, events, session } = setup(early(), FAST);
    await startRecordedSession(session, 'agent');
    await session.prompt(BACKGROUND_PROMPT);
    replayer.openGate();
    await until(() => session.getState().agentTurnInFlight);

    session.kill();
    expect(turnEvents(events).slice(-1)).toEqual(['ended:cancelled']);
    expect(session.getState().agentTurnInFlight).toBe(false);
  });
});

describe('AcpSession agent-initiated turns, edge cases', () => {
  it('activity before the first prompt (a resume replay tail) opens no turn', async () => {
    const { session, events } = setup([
      ...genericStart(), ...genericNew(),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } }),
    ], FAST);
    await session.start();
    await session.newSession({ cwd: CWD });
    await wait(FAST.agentTurnIdleMs * 2);
    expect(updates(events, 'agent_message_chunk')).toHaveLength(1);
    expect(turnEvents(events)).toEqual([]);
  });

  it('session state updates after a prompt (usage, commands) open no turn', async () => {
    const { session, events, replayer } = setup([
      ...genericStart(), ...genericNew(),
      out(3, 'session/prompt'),
      inMsg({ id: 3, result: { stopReason: 'end_turn' } }),
      { dir: 'gate', msg: {} },
      update({ sessionUpdate: 'usage_update', used: 10, size: 100 }),
      update({ sessionUpdate: 'available_commands_update', availableCommands: [] }),
    ], FAST);
    await session.start();
    await session.newSession({ cwd: CWD });
    await session.prompt('hi');
    replayer.openGate();
    await wait(FAST.agentTurnIdleMs * 2);
    expect(updates(events, 'usage_update')).toHaveLength(1);
    expect(turnEvents(events)).toEqual(['started:prompt', 'ended:end_turn']);
  });

  it('an open tool call holds the turn for the longer tool idle time', async () => {
    const { session, events, replayer } = setup([
      ...genericStart(), ...genericNew(),
      out(3, 'session/prompt'),
      inMsg({ id: 3, result: { stopReason: 'end_turn' } }),
      { dir: 'gate', msg: {} },
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'npm test', kind: 'execute', status: 'in_progress' }),
    ], { agentTurnIdleMs: 20, agentTurnToolIdleMs: 150 });
    await session.start();
    await session.newSession({ cwd: CWD });
    await session.prompt('hi');
    replayer.openGate();
    await until(() => session.getState().agentTurnInFlight);
    await wait(80);
    expect(session.getState().agentTurnInFlight).toBe(true);
    await until(() => !session.getState().agentTurnInFlight);
    expect(turnEvents(events)).toEqual(['started:prompt', 'ended:end_turn', 'started:agent', 'ended:end_turn']);
  });

  it('a compaction with no prompt in flight opens an agent turn and holds it until it finishes (#2194)', async () => {
    const { session, events, replayer } = setup([
      ...genericStart(), ...genericNew(),
      out(3, 'session/prompt'),
      inMsg({ id: 3, result: { stopReason: 'end_turn' } }),
      { dir: 'gate', msg: {} },
      update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' }),
      { dir: 'gate', msg: {} },
      update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' }),
    ], { agentTurnIdleMs: 20, agentTurnToolIdleMs: 2_000 });
    await session.start();
    await session.newSession({ cwd: CWD });
    await session.prompt('hi');
    replayer.openGate();
    await until(() => session.getState().agentTurnInFlight);
    // Well past the plain quiet time: a running compaction sends nothing until it ends.
    await wait(100);
    expect(session.getState().agentTurnInFlight).toBe(true);
    replayer.openGate();
    await until(() => !session.getState().agentTurnInFlight, 500);
    // The start and the result both land inside the agent turn, so the chat row opens and settles there.
    const order = events.flatMap((e) => {
      if (e.type === 'turn_started') return [`started:${e.trigger}`];
      if (e.type === 'turn_ended') return [`ended:${e.stopReason}`];
      if (e.type === 'update' && e.update.sessionUpdate === 'compaction_update') return [`compaction:${e.update.status}`];
      return [];
    });
    expect(order).toEqual(['started:prompt', 'ended:end_turn', 'started:agent', 'compaction:in_progress', 'compaction:completed', 'ended:end_turn']);
  });

  it('a compaction result alone, after the turn ended, opens no turn', async () => {
    const { session, events, replayer } = setup([
      ...genericStart(), ...genericNew(),
      out(3, 'session/prompt'),
      inMsg({ id: 3, result: { stopReason: 'end_turn' } }),
      { dir: 'gate', msg: {} },
      update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' }),
    ], FAST);
    await session.start();
    await session.newSession({ cwd: CWD });
    await session.prompt('hi');
    replayer.openGate();
    await wait(FAST.agentTurnIdleMs * 2);
    expect(updates(events, 'compaction_update')).toHaveLength(1);
    expect(turnEvents(events)).toEqual(['started:prompt', 'ended:end_turn']);
  });
});
