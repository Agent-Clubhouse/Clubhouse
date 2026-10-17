import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { AcpSession, CLUBHOUSE_ACP_CLIENT_CAPABILITIES, GENERIC_ACP_PROFILE, type AcpSessionEvent, type AcpSessionOpts } from './acp-session';
import { RpcError } from './acp-client';
import { selectAcpProfile } from './copilot-acp';
import {
  AcpFixtureReplayer,
  loadAcpFixture,
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
    args: ['--acp', '--stdio', '--no-auto-update'],
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
