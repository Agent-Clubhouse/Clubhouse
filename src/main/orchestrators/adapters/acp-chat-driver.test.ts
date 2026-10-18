import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import * as path from 'path';
import { pathToFileURL } from 'url';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { createCopilotAcpChatDriver, createGenericAcpChatDriver } from './acp-chat-driver';
import { AcpChatEventMapper, toAcpMcpServers, toAcpPrompt, toChatCapabilities } from './acp-chat-mapper';
import { copilotAcpCapabilities, COPILOT_PERMISSION_LEVELS } from './copilot-acp';
import { AcpFixtureReplayer, loadAcpFixture, withoutRequest, type AcpFixtureRecord } from './__fixtures__/acp/acp-replay';
import { CHAT_EVENT_TYPES, type ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverSession, ChatDriverStartOptions } from '../../../shared/chat/runtime';
import type { InitializeResponse } from './acp-schema';
import type { AcpSessionState } from './acp-session';

const mockSpawn = vi.mocked(spawn);
const CWD = '/workspace/project';
const COPILOT = 'copilot-cli';
const PROMPT = 'Create a file named hello.txt in the current directory containing exactly the word hi. Do nothing else and reply with one word.';

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stdin: { writable: true, write: vi.fn((..._args: unknown[]) => true) },
    exitCode: null as number | null,
    pid: 4343,
    kill: vi.fn(),
  });
  proc.kill.mockImplementation(() => {
    queueMicrotask(() => proc.emit('exit', null, 'SIGTERM'));
    return true;
  });
  return proc;
}

function startOpts(extra: Partial<ChatDriverStartOptions> = {}): ChatDriverStartOptions {
  return { agentId: 'agent-1', provider: 'copilot-cli', cwd: CWD, binaryPath: 'copilot', level: 'ask', ...extra };
}

function setup(records: AcpFixtureRecord[]) {
  const proc = createMockProcess();
  mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  const replayer = new AcpFixtureReplayer(proc, records);
  return { proc, replayer, driver: createCopilotAcpChatDriver() };
}

/** Read drafts until one matches `until` (inclusive), answering permission requests with `allow_once`. */
async function collect(session: ChatDriverSession, until: (d: ChatEventDraft) => boolean): Promise<ChatEventDraft[]> {
  const out: ChatEventDraft[] = [];
  for await (const draft of session.events) {
    out.push(draft);
    if (draft.type === 'permission_request') await session.respondPermission(draft.data.requestId, 'allow_once');
    if (until(draft)) break;
  }
  return out;
}

const init = loadAcpFixture(COPILOT, 'handshake-list-close.jsonl').find((r) => r.dir === 'in' && r.msg.id === 1)!.msg.result as InitializeResponse;

beforeEach(() => {
  mockSpawn.mockReset();
});

describe('Copilot ACP chat driver', () => {
  it('runs a recorded turn and emits contract drafts', async () => {
    const { driver, replayer } = setup(loadAcpFixture(COPILOT, 'one-prompt.jsonl'));
    const session = await driver.start(startOpts({ model: 'gpt-5-mini' }));

    expect(mockSpawn.mock.calls[0][1]).toEqual(['--acp', '--stdio', '--no-auto-update']);
    expect(session.nativeSessionId).toBe('5af70548-c3ac-4e25-b105-bec13faa1f20');
    expect(session.capabilities).toMatchObject({
      steer: false, queue: 'client', interrupt: true, resume: 'replay', usage: 'tokens',
      images: true, slashCommands: true, modelSwitch: 'live', effortSwitch: 'live', liveLevels: ['plan', 'ask', 'full_access'], login: 'terminal',
    });
    // ACP config options have no "unset": no Default effort row, and a reset is refused before any request (#2136).
    expect(session.capabilities.effortDefault).toBeUndefined();
    await expect(session.setModel('gpt-5-mini', null)).rejects.toThrow(/can't return effort to its default/);

    expect(await session.send([{ type: 'text', text: PROMPT }], 'prompt')).toBe('prompt');
    const drafts = await collect(session, (d) => d.type === 'turn_ended');

    for (const d of drafts) expect(CHAT_EVENT_TYPES).toContain(d.type);
    const types = drafts.map((d) => d.type);
    // Setup changes (the model switch) are not reported as live changes.
    expect(types).not.toContain('model_changed');
    expect(drafts[0]).toMatchObject({
      type: 'session_info',
      data: {
        nativeSessionId: '5af70548-c3ac-4e25-b105-bec13faa1f20',
        cliVersion: '1.0.98',
        model: 'gpt-5-mini',
        // Copilot narrows the effort list to what the selected model supports.
        efforts: ['low', 'medium', 'high'],
        levelNames: { plan: 'Plan', ask: 'Agent', full_access: 'Agent, allow all' },
      },
    });
    // The model picker gets each model once, with Copilot's cost multiplier.
    const models = drafts[0].type === 'session_info' ? drafts[0].data.models ?? [] : [];
    expect(models.length).toBeGreaterThan(10);
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    expect(models.find((m) => m.id === 'auto')).toEqual({ id: 'auto', label: 'Auto', costHint: '1x' });
    expect(types[1]).toBe('commands_available');
    expect(types).toContain('turn_started');
    expect(types[types.length - 1]).toBe('turn_ended');

    const turnScoped = drafts.slice(types.indexOf('turn_started'));
    const thoughtIds = new Set(turnScoped.flatMap((d) => (d.type === 'agent_thought_chunk' ? [d.data.messageId] : [])));
    expect(thoughtIds.size).toBe(1);
    const text = turnScoped.flatMap((d) => (d.type === 'agent_message_chunk' ? [d.data.text] : [])).join('');
    expect(text).toBe("Creating hello.txt containing 'hi' to satisfy the request.Done");
    const turnId = turnScoped[0].turnId;
    expect(turnId).toMatch(/^turn-[0-9a-f]{8}-1$/);
    expect(turnScoped.filter((d) => d.type !== 'usage' && d.type !== 'session_info').every((d) => d.turnId === turnId)).toBe(true);
    expect(drafts.find((d) => d.type === 'session_info' && d.data.title)).toMatchObject({ data: { title: PROMPT } });

    expect(drafts.find((d) => d.type === 'tool_call')).toMatchObject({
      data: { kind: 'edit', status: 'pending', content: [{ type: 'diff', path: '/workspace/project/hello.txt', newText: 'hi' }] },
    });
    const update = drafts.find((d) => d.type === 'tool_call_update');
    expect(update).toMatchObject({ data: { status: 'completed', contentMode: 'replace' } });
    expect(update?.type === 'tool_call_update' && update.data.content?.[0]).toMatchObject({ type: 'diff', unifiedDiff: expect.stringContaining('@@ -1,0 +1,1 @@') });

    expect(drafts.find((d) => d.type === 'permission_request')).toMatchObject({
      data: {
        title: 'Create file',
        options: [
          { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
          { optionId: 'allow_always', kind: 'allow_always', label: 'Always allow' },
          { optionId: 'reject_once', kind: 'reject_once', label: 'Deny' },
        ],
      },
    });
    // The chat runtime reports answers it gives; the driver doesn't echo them.
    expect(drafts.some((d) => d.type === 'permission_resolved')).toBe(false);
    expect(drafts.find((d) => d.type === 'usage' && d.data.scope === 'session')).toMatchObject({ data: { context: { used: 14047, size: 128000 } } });
    expect(drafts[drafts.length - 1]).toMatchObject({
      type: 'turn_ended',
      data: { stopReason: 'end_turn', usage: { input: 26255, cachedInput: 12800, cacheWrite: 0, output: 854, reasoning: 704, total: 27109 } },
    });
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });

  it('drops replayed history when resuming through session/load', async () => {
    const { driver, replayer, proc } = setup(loadAcpFixture(COPILOT, 'load-replay.jsonl'));
    const session = await driver.start(startOpts({ resumeNativeSessionId: '5af70548-c3ac-4e25-b105-bec13faa1f20' }));
    proc.emit('exit', 0, null);
    const drafts: ChatEventDraft[] = [];
    for await (const d of session.events) drafts.push(d);

    // History is swallowed; the session facts and the command list (which can arrive while
    // session/load still reads as replay) come through.
    // Copilot sends the same list during the replay and again right after it; it's reported once.
    expect(drafts.map((d) => d.type)).toEqual(['session_info', 'commands_available']);
    expect(drafts[0]).toMatchObject({ type: 'session_info', data: { nativeSessionId: '5af70548-c3ac-4e25-b105-bec13faa1f20', cliVersion: '1.0.98' } });
    const commands = drafts[1].type === 'commands_available' ? drafts[1].data.commands : [];
    expect(commands.length).toBeGreaterThan(20);
    expect(replayer.written[1]).toMatchObject({ method: 'session/load' });
    expect(replayer.errors).toEqual([]);
  });

  it('applies effort at start, reports level changes, and closes the session', async () => {
    let records = loadAcpFixture(COPILOT, 'method-coverage.jsonl');
    for (const skipped of ['session/set_model', 'session/resume', 'session/fork', 'session/list', 'authenticate', '$/cancel_request', 'session/load']) {
      records = withoutRequest(records, skipped);
    }
    const { driver, replayer } = setup(records);
    const session = await driver.start(startOpts({ effort: 'low' }));
    expect(replayer.written[2]).toMatchObject({ method: 'session/set_config_option', params: { configId: 'reasoning_effort', value: 'low' } });

    await session.setLevel('plan');
    await session.close();
    const drafts: ChatEventDraft[] = [];
    for await (const d of session.events) drafts.push(d);

    expect(drafts.filter((d) => d.type === 'mode_changed')).toEqual([
      { type: 'mode_changed', data: { level: 'plan', nativeMode: 'https://agentclientprotocol.com/protocol/session-modes#plan' } },
    ]);
    // The recording switched model through the legacy set_model (skipped here), so the
    // agent's next config update carries a model change Clubhouse didn't make. It must surface.
    expect(drafts.filter((d) => d.type === 'model_changed')).toEqual([
      { type: 'model_changed', data: { modelId: 'gpt-5-mini', effort: 'low' } },
    ]);
    await expect(session.setLevel('auto_edit')).rejects.toThrow(/no auto_edit level/);
    await expect(session.answerQuestion('q', { q1: 'a' })).rejects.toThrow();
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });

  it('probes with initialize only', async () => {
    const { driver, replayer } = setup(loadAcpFixture(COPILOT, 'handshake-list-close.jsonl').slice(0, 2));
    const probe = await driver.probe('copilot');
    expect(probe).toMatchObject({ handshakeOk: true, cliVersion: '1.0.92', capabilities: { resume: 'replay', interrupt: true } });
    expect(replayer.written.map((m) => m.method)).toEqual(['initialize']);
  });
});

describe('ACP → chat contract mapping', () => {
  const state = (over: Partial<AcpSessionState> = {}): AcpSessionState => ({
    sessionId: 's1', modes: null, configOptions: [], legacyModels: null, availableCommands: [], title: null, context: null, turnInFlight: false, ...over,
  });

  it('maps capabilities from the Copilot record', () => {
    expect(toChatCapabilities(copilotAcpCapabilities(init), state(), COPILOT_PERMISSION_LEVELS)).toMatchObject({
      resume: 'replay', usage: 'tokens', modelSwitch: 'none', subagents: 'none', questions: false, liveLevels: ['plan', 'ask', 'full_access'],
    });
  });

  it('turns unknown updates and stop reasons into protocol_unknown', () => {
    const mapper = new AcpChatEventMapper('copilot_acp', { now: () => 0 });
    expect(mapper.map({ type: 'unknown_update', sessionId: 's1', replay: false, kind: 'subagent_started', reason: 'x', raw: {} }, state()))
      .toEqual([{ type: 'protocol_unknown', data: { driver: 'copilot_acp', kind: 'field', name: 'session/update:subagent_started' } }]);
    mapper.map({ type: 'turn_started', sessionId: 's1' }, state());
    const ended = mapper.map({ type: 'turn_ended', sessionId: 's1', stopReason: 'unknown', rawStopReason: 'paused' }, state());
    expect(ended[0]).toEqual({ type: 'protocol_unknown', data: { driver: 'copilot_acp', kind: 'field', name: 'stopReason:paused' } });
    expect(ended[1]).toMatchObject({ type: 'turn_ended', turnId: expect.stringMatching(/^turn-[0-9a-f]{8}-1$/), data: { stopReason: 'end_turn' } });
  });

  it('reports only cancellations it caused, not answers the runtime gave', () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    const options = [{ optionId: 'no', name: 'Never', kind: 'reject_always' as const }];
    expect(mapper.map({ type: 'permission_request', sessionId: 's1', requestId: '1', toolCall: { toolCallId: 't' }, options }, state())[0])
      .toMatchObject({ type: 'permission_request', data: { options: [{ optionId: 'no', kind: 'reject_always', label: 'Never' }] } });
    expect(mapper.map({ type: 'permission_resolved', sessionId: 's1', requestId: '1', outcome: { outcome: 'selected', optionId: 'no' } }, state()))
      .toEqual([]);
    expect(mapper.map({ type: 'permission_resolved', sessionId: 's1', requestId: '2', outcome: { outcome: 'cancelled' } }, state()))
      .toEqual([{ type: 'permission_resolved', data: { requestId: '2', decision: 'cancelled', by: 'user' } }]);
  });

  it('starts a new message id after a tool call interrupts the text', () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    const chunk = (text: string) => ({ type: 'update' as const, sessionId: 's1', replay: false, update: { sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text } } });
    mapper.map({ type: 'turn_started', sessionId: 's1' }, state());
    const a = mapper.map(chunk('a'), state())[0];
    const b = mapper.map(chunk('b'), state())[0];
    mapper.map({ type: 'update', sessionId: 's1', replay: false, update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'x' } }, state());
    const c = mapper.map(chunk('c'), state())[0];
    const id = (d: ChatEventDraft) => (d.type === 'agent_message_chunk' ? d.data.messageId : '');
    expect(id(a)).toBe(id(b));
    expect(id(c)).not.toBe(id(a));
  });

  it('maps plans, notices and USD cost', () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    const u = (update: Record<string, unknown>) => mapper.map({ type: 'update', sessionId: 's1', replay: false, update: update as never }, state());
    expect(u({ sessionUpdate: 'plan', entries: [{ content: 'Write tests', priority: 'high', status: 'pending' }] }))
      .toEqual([{ type: 'plan', data: { entries: [{ content: 'Write tests', priority: 'high', status: 'pending' }] } }]);
    expect(u({ sessionUpdate: 'notice', severity: 'warning', title: 'Rate limited', description: 'Retrying' }))
      .toEqual([{ type: 'notice', data: { level: 'warn', code: 'agent_notice', message: 'Rate limited: Retrying' } }]);
    expect(u({ sessionUpdate: 'usage_update', used: 5, size: 10, cost: { amount: 0.25, currency: 'USD' } }))
      .toEqual([{ type: 'usage', data: { scope: 'session', context: { used: 5, size: 10 }, costUsd: 0.25 } }]);
  });

  it('reports a changed model list or effort list as session_info, once', () => {
    const select = (id: string, category: string, values: string[], current: string) =>
      ({ type: 'select' as const, id, name: id, category, currentValue: current, options: values.map((v) => ({ value: v, name: v.toUpperCase() })) });
    const before = state({ configOptions: [select('model', 'model', ['a', 'b'], 'a'), select('effort', 'thought_level', ['low', 'high'], 'low')] });
    const after = state({ configOptions: [select('model', 'model', ['a', 'b', 'c'], 'a'), select('effort', 'thought_level', ['low', 'high'], 'low')] });
    const mapper = new AcpChatEventMapper('copilot_acp');
    mapper.prime(before);
    const update = { type: 'update' as const, sessionId: 's1', replay: false, update: { sessionUpdate: 'config_option_update' as const, configOptions: after.configOptions } };
    expect(mapper.map(update, after)).toEqual([{
      type: 'session_info',
      data: { models: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] },
    }]);
    expect(mapper.map(update, after)).toEqual([]);
  });

  it('clears a list that went away with an explicit empty array', () => {
    const select = (id: string, category: string, values: string[]) =>
      ({ type: 'select' as const, id, name: id, category, currentValue: values[0] ?? '', options: values.map((v) => ({ value: v, name: v })) });
    const before = state({ configOptions: [select('model', 'model', ['a']), select('effort', 'thought_level', ['low', 'high'])] });
    // The new model has no effort setting, so the agent drops the option.
    const after = state({ configOptions: [select('model', 'model', ['a'])] });
    const mapper = new AcpChatEventMapper('copilot_acp');
    mapper.prime(before);
    const update = { type: 'update' as const, sessionId: 's1', replay: false, update: { sessionUpdate: 'config_option_update' as const, configOptions: after.configOptions } };
    expect(mapper.map(update, after)).toEqual([
      // The effort itself is gone too.
      { type: 'model_changed', data: { modelId: 'a' } },
      // Only the list that changed is sent.
      { type: 'session_info', data: { efforts: [] } },
    ]);
    expect(mapper.map(update, after)).toEqual([]);
  });

  it('reports an unchanged command list only once', () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    const cmds = { type: 'update' as const, sessionId: 's1', replay: false, update: { sessionUpdate: 'available_commands_update' as const, availableCommands: [{ name: 'compact', description: 'Compact' }] } };
    expect(mapper.map(cmds, state())).toHaveLength(1);
    expect(mapper.map(cmds, state())).toEqual([]);
  });

  it('gives each driver session its own turn and message ids', () => {
    const turnOf = (m: AcpChatEventMapper) => m.map({ type: 'turn_started', sessionId: 's1' }, state())[0].turnId;
    expect(turnOf(new AcpChatEventMapper('copilot_acp'))).not.toBe(turnOf(new AcpChatEventMapper('copilot_acp')));
  });

  it('classifies failed turns with contract error codes', () => {
    const failed = (errorKind: 'process_exited' | 'rpc' | 'other', rpcCode?: number) => {
      const m = new AcpChatEventMapper('copilot_acp');
      m.map({ type: 'turn_started', sessionId: 's1' }, state());
      const drafts = m.map({ type: 'turn_ended', sessionId: 's1', stopReason: 'error', error: 'x', errorKind, rpcCode }, state());
      return drafts.find((d) => d.type === 'error');
    };
    expect(failed('process_exited')).toMatchObject({ data: { code: 'process_exited', fatal: true } });
    expect(failed('rpc', -32000)).toMatchObject({ data: { code: 'auth_required', fatal: false } });
    expect(failed('rpc', -32603)).toMatchObject({ data: { code: 'protocol_error' } });
    expect(failed('other')).toMatchObject({ data: { code: 'unknown' } });
  });

  it('converts prompt content, sending local files as file URLs', () => {
    const file = path.join(path.parse(process.cwd()).root, 'tmp', 'notes.md');
    expect(toAcpPrompt([
      { type: 'text', text: 'see' },
      { type: 'file', path: file },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ])).toEqual([
      { type: 'text', text: 'see' },
      { type: 'resource_link', uri: pathToFileURL(file).href, name: 'notes.md' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });

  it('converts MCP servers and reports ones it cannot express', () => {
    expect(toAcpMcpServers({
      clubhouse: { command: 'node', args: ['bridge.js'], env: { TOKEN: 'x' } },
      remote: { type: 'sse', url: 'https://example.test/sse', headers: { A: 'b' } },
      odd: { transport: 'ws' },
    })).toEqual({
      servers: [
        { name: 'clubhouse', command: 'node', args: ['bridge.js'], env: [{ name: 'TOKEN', value: 'x' }] },
        { type: 'sse', name: 'remote', url: 'https://example.test/sse', headers: [{ name: 'A', value: 'b' }] },
      ],
      skipped: ['odd'],
    });
  });
});

// ── Inline scripts ───────────────────────────────────────────────────────────

const rec = (dir: 'in' | 'out', msg: Record<string, unknown>): AcpFixtureRecord => ({ dir, msg: { jsonrpc: '2.0', ...msg } });
const genericStart: AcpFixtureRecord[] = [
  rec('out', { id: 1, method: 'initialize' }),
  rec('in', { id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'example-agent', version: '0.4.0' } } }),
  rec('out', { id: 2, method: 'session/new' }),
  rec('in', { id: 2, result: { sessionId: 's1' } }),
];

describe('ACP chat driver failure paths', () => {
  it('reports the turn as failed before the stream ends when the agent dies mid-turn', async () => {
    const { driver, proc } = setup([...genericStart, rec('out', { id: 3, method: 'session/prompt' })]);
    const session = await driver.start(startOpts());
    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    await new Promise((r) => setTimeout(r, 0));
    proc.emit('exit', 1, null);

    const drafts: ChatEventDraft[] = [];
    for await (const d of session.events) drafts.push(d);
    const tail = drafts.slice(-2);
    expect(tail[0]).toMatchObject({ type: 'error', data: { code: 'process_exited', fatal: true } });
    expect(tail[1]).toMatchObject({ type: 'turn_ended', data: { stopReason: 'error' } });
  });

  it('starts a new native session, with a notice, when the old one no longer exists', async () => {
    const { driver, replayer } = setup([
      genericStart[0], genericStart[1],
      rec('out', { id: 2, method: 'session/load' }),
      rec('in', { id: 2, error: { code: -32002, message: 'Resource not found: Session gone not found' } }),
      rec('out', { id: 3, method: 'session/new' }),
      rec('in', { id: 3, result: { sessionId: 's-new' } }),
    ]);
    const session = await driver.start(startOpts({ resumeNativeSessionId: 'gone' }));
    expect(session.nativeSessionId).toBe('s-new');
    const first: ChatEventDraft[] = [];
    for await (const d of session.events) {
      first.push(d);
      if (d.type === 'session_info') break;
    }
    expect(first[0]).toMatchObject({ type: 'notice', data: { code: 'resume_unavailable' } });
    expect(first[1]).toMatchObject({ type: 'session_info', data: { nativeSessionId: 's-new' } });
    expect(replayer.errors).toEqual([]);
  });

  it('discards a partial replay when the load then fails, and starts clean', async () => {
    const replay = (update: Record<string, unknown>) => rec('in', { method: 'session/update', params: { sessionId: 'gone', update } });
    const { driver, replayer } = setup([
      genericStart[0], genericStart[1],
      rec('out', { id: 2, method: 'session/load' }),
      replay({ sessionUpdate: 'session_info_update', title: 'Old conversation' }),
      replay({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'old-command', description: 'From the old session' }] }),
      replay({ sessionUpdate: 'usage_update', used: 900, size: 1000 }),
      replay({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } }),
      rec('in', { id: 2, error: { code: -32002, message: 'Resource not found' } }),
      rec('out', { id: 3, method: 'session/new' }),
      rec('in', { id: 3, result: { sessionId: 's-new' } }),
    ]);
    const session = await driver.start(startOpts({ resumeNativeSessionId: 'gone' }));
    await session.close();
    const drafts: ChatEventDraft[] = [];
    for await (const d of session.events) drafts.push(d);

    expect(drafts.map((d) => d.type)).toEqual(['notice', 'session_info']);
    expect(drafts[1]).toEqual({ type: 'session_info', data: { nativeSessionId: 's-new', cliVersion: '0.4.0' } });
    expect(replayer.errors).toEqual([]);
  });

  it('does not swallow other resume failures', async () => {
    const { driver } = setup([
      genericStart[0], genericStart[1],
      rec('out', { id: 2, method: 'session/load' }),
      rec('in', { id: 2, error: { code: -32000, message: 'Authentication required' } }),
    ]);
    await expect(driver.start(startOpts({ resumeNativeSessionId: 's1' }))).rejects.toThrow(/Authentication required/);
  });

  it('runs other ACP agents as driver "acp" and flags methods outside the schema', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const replayer = new AcpFixtureReplayer(proc, [
      ...genericStart,
      rec('out', { id: 3, method: 'session/prompt' }),
      rec('in', { method: 'x/progress', params: {} }),
      rec('in', { id: 50, method: 'x/ask', params: {} }),
      rec('out', { id: 50 }),
      rec('in', { id: 3, result: { stopReason: 'end_turn' } }),
    ]);
    const driver = createGenericAcpChatDriver('example', ['--acp']);
    expect(driver.id).toBe('acp');
    const session = await driver.start(startOpts({ provider: 'example', binaryPath: 'example-agent' }));
    expect(mockSpawn.mock.calls[0].slice(0, 2)).toEqual(['example-agent', ['--acp']]);
    expect(session.capabilities).toMatchObject({ systemPrompt: false, liveLevels: [], resume: 'replay' });

    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    const drafts = await collect(session, (d) => d.type === 'turn_ended');
    expect(drafts.filter((d) => d.type === 'protocol_unknown').map((d) => d.data)).toEqual([
      { driver: 'acp', kind: 'notification', name: 'x/progress' },
      { driver: 'acp', kind: 'request', name: 'x/ask' },
    ]);
    expect(replayer.written.find((m) => m.id === 50)).toMatchObject({ error: { code: -32601 } });
    expect(replayer.errors).toEqual([]);
  });
});

describe('ACP chat driver resume stalls and cancellation (#2087)', () => {
  const loadOnly: AcpFixtureRecord[] = [genericStart[0], genericStart[1], rec('out', { id: 2, method: 'session/load' })];
  const freshStart: AcpFixtureRecord[] = [...genericStart.slice(0, 2), rec('out', { id: 2, method: 'session/new' }), rec('in', { id: 2, result: { sessionId: 's-fresh' } })];

  /** Two CLI processes in spawn order, each replaying its own records. */
  function setupTwo(first: AcpFixtureRecord[], second: AcpFixtureRecord[]) {
    const procs = [createMockProcess(), createMockProcess()];
    mockSpawn.mockReturnValueOnce(procs[0] as unknown as ReturnType<typeof spawn>).mockReturnValueOnce(procs[1] as unknown as ReturnType<typeof spawn>);
    const replayers = [new AcpFixtureReplayer(procs[0], first), new AcpFixtureReplayer(procs[1], second)];
    const driver = createCopilotAcpChatDriver();
    driver.sessionOverrides = { resumeStallTimeoutMs: 40 };
    return { procs, replayers, driver };
  }

  it('gives up on a session/load that never answers and continues in a fresh session in a new process', async () => {
    const { procs, replayers, driver } = setupTwo(loadOnly, freshStart);
    const startedAt = Date.now();
    const session = await driver.start(startOpts({ resumeNativeSessionId: '88618d97' }));

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(session.nativeSessionId).toBe('s-fresh');
    expect(procs[0].kill).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const first: ChatEventDraft[] = [];
    for await (const d of session.events) {
      first.push(d);
      if (d.type === 'session_info') break;
    }
    expect(first[0]).toMatchObject({ type: 'notice', data: { code: 'resume_stalled' } });
    expect(replayers[0].errors).toEqual([]);
    expect(replayers[1].errors).toEqual([]);
    expect(replayers[1].done).toBe(true);
  });

  it('keeps waiting on a slow load while it is still replaying history', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const replayer = new AcpFixtureReplayer(proc, loadOnly);
    const driver = createCopilotAcpChatDriver();
    driver.sessionOverrides = { resumeStallTimeoutMs: 200 };
    const started = driver.start(startOpts({ resumeNativeSessionId: 'long' }));

    const say = (msg: Record<string, unknown>) => proc.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    await vi.waitFor(() => expect(replayer.written[1]).toMatchObject({ method: 'session/load' }), { interval: 5 });
    // 5 updates 80ms apart: 400ms in total, twice the stall timeout, never 200ms quiet.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 80));
      say({ method: 'session/update', params: { sessionId: 'long', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `old ${i}` } } } });
    }
    say({ id: replayer.written[1].id, result: {} });

    const session = await started;
    expect(session.nativeSessionId).toBe('long');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(replayer.errors).toEqual([]);
  });

  it('kills the CLI and rejects when the start is aborted mid-load, without retrying', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const replayer = new AcpFixtureReplayer(proc, loadOnly);
    const controller = new AbortController();
    const started = createCopilotAcpChatDriver().start(startOpts({ resumeNativeSessionId: 's1', signal: controller.signal }));
    await vi.waitFor(() => expect(replayer.written[1]).toMatchObject({ method: 'session/load' }));

    controller.abort();
    await expect(started).rejects.toThrow();
    expect(proc.kill).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('does not spawn at all for an already aborted start', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createCopilotAcpChatDriver().start(startOpts({ signal: controller.signal }))).rejects.toThrow(/cancelled/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
