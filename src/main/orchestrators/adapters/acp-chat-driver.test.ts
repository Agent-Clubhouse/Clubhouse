import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { createCopilotAcpChatDriver, createGenericAcpChatDriver } from './acp-chat-driver';
import { AcpChatEventMapper, toAcpMcpServers, toAcpPrompt, toChatCapabilities } from './acp-chat-mapper';
import { copilotAcpCapabilities, COPILOT_ACP_PROFILE, COPILOT_PERMISSION_LEVELS } from './copilot-acp';
import { AcpFixtureReplayer, loadAcpFixture, promptAnsweredEarly, withoutRequest, type AcpFixtureRecord } from './__fixtures__/acp/acp-replay';
import { CHAT_EVENT_TYPES, COMPACTION_SETTLED, COMPACTION_STARTED, type ChatEventDraft } from '../../../shared/chat/events';
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

/** A COPILOT_HOME whose session-state holds the given session ids (#2155: resume checks the disk first). */
function copilotHomeWith(...sessionIds: string[]): Record<string, string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  for (const id of sessionIds) fs.mkdirSync(path.join(home, 'session-state', id), { recursive: true });
  return { COPILOT_HOME: home };
}

/** The level re-send a resumed Copilot session gets (allow_all, then mode), answered as recorded. */
function levelResend(records: AcpFixtureRecord[], firstId: number, mode = 'agent'): AcpFixtureRecord[] {
  const loadResult = records.find((r) => r.dir === 'in' && (r.msg.result as { configOptions?: unknown } | undefined)?.configOptions);
  const configOptions = (loadResult?.msg.result as { configOptions: unknown }).configOptions;
  return [
    { dir: 'out', msg: { jsonrpc: '2.0', id: firstId, method: 'session/set_config_option' } },
    { dir: 'in', msg: { jsonrpc: '2.0', id: firstId, result: { configOptions } } },
    { dir: 'out', msg: { jsonrpc: '2.0', id: firstId + 1, method: 'session/set_mode', params: { modeId: `https://agentclientprotocol.com/protocol/session-modes#${mode}` } } },
    { dir: 'in', msg: { jsonrpc: '2.0', id: firstId + 1, result: {} } },
  ];
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

    expect(mockSpawn.mock.calls[0][1]).toEqual(['--acp', '--stdio']);
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
    const load = loadAcpFixture(COPILOT, 'load-replay.jsonl');
    const { driver, replayer, proc } = setup([...load, ...levelResend(load, 3)]);
    const session = await driver.start(startOpts({
      resumeNativeSessionId: '5af70548-c3ac-4e25-b105-bec13faa1f20',
      env: copilotHomeWith('5af70548-c3ac-4e25-b105-bec13faa1f20'),
    }));
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
    expect(session.resumeFallback).toBeUndefined();
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

describe('Copilot model label before the first turn (#2293)', () => {
  const NATIVE_ID = '5af70548-c3ac-4e25-b105-bec13faa1f20';
  const recorded = loadAcpFixture(COPILOT, 'one-prompt.jsonl');
  // Copilot's answer to set_config_option(model=gpt-5-mini): the options once the model is resolved.
  const resolvedOptions = (recorded.find((r) => r.dir === 'in' && r.msg.id === 3)!.msg.result as { configOptions: unknown }).configOptions;

  /**
   * An unpinned session: session/new answers with Copilot's built-in default
   * (claude-sonnet-5.5). Copilot applies the user's configured model only when
   * the prompt starts and says so with config_option_update, as 1.0.82 did
   * with settings.json's model in a real wake.
   */
  function unpinned(resolveAtPrompt: boolean): AcpFixtureRecord[] {
    const records = withoutRequest(recorded, 'session/set_config_option');
    if (!resolveAtPrompt) return records;
    const prompt = records.findIndex((r) => r.dir === 'out' && r.msg.method === 'session/prompt');
    const update: AcpFixtureRecord = {
      dir: 'in',
      msg: { jsonrpc: '2.0', method: 'session/update', params: { sessionId: NATIVE_ID, update: { sessionUpdate: 'config_option_update', configOptions: resolvedOptions } } },
    };
    return [...records.slice(0, prompt + 1), update, ...records.slice(prompt + 1)];
  }

  it('a wake that falls back to session/new reports the model as unknown, then the one Copilot resolves at the prompt', async () => {
    const { driver, replayer } = setup(unpinned(true));
    // The old native session is gone, so the wake starts a new one.
    const session = await driver.start(startOpts({ resumeNativeSessionId: 'gone', env: copilotHomeWith() }));
    await session.send([{ type: 'text', text: PROMPT }], 'prompt');
    const drafts = await collect(session, (d) => d.type === 'turn_ended');

    const info = drafts.find((d) => d.type === 'session_info' && d.data.nativeSessionId);
    // Not the placeholder: null says "the provider's default, not known yet".
    expect(info).toMatchObject({ type: 'session_info', data: { nativeSessionId: NATIVE_ID, model: null } });
    // The placeholder model's effort list isn't offered either.
    expect(info?.type === 'session_info' && info.data.efforts).toBeUndefined();
    expect(info?.type === 'session_info' && info.data.models?.length).toBeGreaterThan(10);

    const changes = drafts.filter((d) => d.type === 'model_changed');
    expect(changes).toEqual([expect.objectContaining({ type: 'model_changed', data: { modelId: 'gpt-5-mini', effort: 'medium', effortIsDefault: true } })]);
    expect(drafts.findIndex((d) => d.type === 'model_changed')).toBeLessThan(drafts.findIndex((d) => d.type === 'turn_ended'));
    expect(drafts.find((d) => d.type === 'session_info' && d.data.efforts)).toMatchObject({ data: { efforts: ['low', 'medium', 'high'] } });
    expect(replayer.errors).toEqual([]);
  });

  it('confirms the reported model at the end of the first turn when Copilot sends no update', async () => {
    const { driver, replayer } = setup(unpinned(false));
    const session = await driver.start(startOpts());
    await session.send([{ type: 'text', text: PROMPT }], 'prompt');
    const drafts = await collect(session, (d) => d.type === 'turn_ended');

    expect(drafts[0]).toMatchObject({ type: 'session_info', data: { model: null } });
    const changes = drafts.filter((d) => d.type === 'model_changed');
    expect(changes).toEqual([expect.objectContaining({ data: { modelId: 'claude-sonnet-5.5', effort: 'medium', effortIsDefault: true } })]);
    expect(drafts.findIndex((d) => d.type === 'model_changed')).toBeLessThan(drafts.findIndex((d) => d.type === 'turn_ended'));
    expect(replayer.errors).toEqual([]);
  });

  it('a session/load reports the loaded session\'s model right away', async () => {
    const load = loadAcpFixture(COPILOT, 'load-replay.jsonl');
    const { driver, proc } = setup([...load, ...levelResend(load, 3)]);
    const session = await driver.start(startOpts({ resumeNativeSessionId: NATIVE_ID, env: copilotHomeWith(NATIVE_ID) }));
    proc.emit('exit', 0, null);
    const drafts: ChatEventDraft[] = [];
    for await (const d of session.events) drafts.push(d);
    expect(drafts[0]).toMatchObject({ type: 'session_info', data: { model: 'gpt-5-mini', efforts: ['low', 'medium', 'high'] } });
  });

  it('a model chosen before the first prompt resolves the label', async () => {
    const records = withoutRequest(recorded, 'session/set_config_option');
    // Put the recorded set_config_option back after the handshake, as a composer pick would send it.
    const setAt = recorded.findIndex((r) => r.dir === 'out' && r.msg.method === 'session/set_config_option');
    const picked = recorded.slice(setAt, recorded.findIndex((r, i) => i > setAt && r.dir === 'out'));
    const prompt = records.findIndex((r) => r.dir === 'out' && r.msg.method === 'session/prompt');
    const { driver, replayer } = setup([...records.slice(0, prompt), ...picked, ...records.slice(prompt)]);
    const session = await driver.start(startOpts());
    await session.setModel('gpt-5-mini');
    await session.send([{ type: 'text', text: PROMPT }], 'prompt');
    const drafts = await collect(session, (d) => d.type === 'turn_ended');

    expect(drafts[0]).toMatchObject({ type: 'session_info', data: { model: null } });
    expect(drafts.filter((d) => d.type === 'model_changed')).toEqual([
      expect.objectContaining({ data: { modelId: 'gpt-5-mini', effort: 'medium', effortIsDefault: true } }),
    ]);
    expect(replayer.errors).toEqual([]);
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

  it('maps image content in tool calls and in the agent message', () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    const u = (update: Record<string, unknown>) => mapper.map({ type: 'update', sessionId: 's1', replay: false, update: update as never }, state());
    mapper.map({ type: 'turn_started', sessionId: 's1' }, state());
    const image = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };
    expect(u({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'Screenshot', kind: 'read', content: [{ type: 'content', content: image }] })[0].data)
      .toMatchObject({ toolCallId: 't', content: [], media: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] });
    expect(u({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', content: [{ type: 'content', content: { type: 'image', mimeType: 'image/jpeg', data: '', uri: 'https://example.com/a.jpg' } }] })[0].data)
      .toMatchObject({ media: [{ type: 'image', mimeType: 'image/jpeg', uri: 'https://example.com/a.jpg' }] });
    const [msgImage] = u({ sessionUpdate: 'agent_message_chunk', content: image });
    expect(msgImage).toMatchObject({ type: 'tool_call', data: { kind: 'other', title: 'Image', status: 'completed', toolName: 'image', mediaOnly: true, media: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] } });
    // The image leaves the reply in one message: dropped with rich content off, text is as before.
    const text = (t: string) => u({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })[0];
    const before = text('a');
    u({ sessionUpdate: 'agent_message_chunk', content: image });
    const after = text('b');
    expect(after.type === 'agent_message_chunk' && before.type === 'agent_message_chunk' && after.data.messageId === before.data.messageId).toBe(true);
    // Thought images and replayed chunks aren't shown.
    expect(u({ sessionUpdate: 'agent_thought_chunk', content: image })).toEqual([]);
    expect(mapper.map({ type: 'update', sessionId: 's1', replay: true, update: { sessionUpdate: 'agent_message_chunk', content: image } as never }, state())).toEqual([]);
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

  it('drops a turn usage that repeats the previous turn exactly, as Copilot sends for /context (#2180)', () => {
    const mapper = new AcpChatEventMapper('copilot_acp', { now: () => 0 });
    const usage = { inputTokens: 15750, outputTokens: 5, totalTokens: 15755, cachedReadTokens: 7680, cachedWriteTokens: 0 };
    const turn = (u?: typeof usage) => {
      mapper.map({ type: 'turn_started', sessionId: 's1' }, state());
      return mapper.map({ type: 'turn_ended', sessionId: 's1', stopReason: 'end_turn', ...(u && { usage: u }) }, state());
    };
    const first = turn(usage);
    expect(first.map((d) => d.type)).toEqual(['usage', 'turn_ended']);
    expect(first[1]).toMatchObject({ data: { usage: { input: 15750, output: 5 } } });
    const repeat = turn({ ...usage });
    expect(repeat.map((d) => d.type)).toEqual(['turn_ended']);
    expect(repeat[0].type === 'turn_ended' && repeat[0].data.usage).toBeFalsy();
    // A turn with new usage reports it again.
    expect(turn({ ...usage, inputTokens: 16000, totalTokens: 16005 })[1]).toMatchObject({ data: { usage: { input: 16000 } } });
  });

  it('reports the starting effort as the default until one is chosen (#2181)', () => {
    const select = (current: string) => ({ type: 'select' as const, id: 'reasoning_effort', name: 'Effort', category: 'thought_level', currentValue: current, options: ['low', 'medium', 'high'].map((v) => ({ value: v, name: v })) });
    const model = { type: 'select' as const, id: 'model', name: 'Model', category: 'model', currentValue: 'gpt', options: [{ value: 'gpt', name: 'GPT' }] };
    const at = (effort: string) => state({ configOptions: [model, select(effort)] });
    const update = (s: AcpSessionState) => ({ type: 'update' as const, sessionId: 's1', replay: false, update: { sessionUpdate: 'config_option_update' as const, configOptions: s.configOptions } });

    const mapper = new AcpChatEventMapper('copilot_acp');
    mapper.prime(state({ configOptions: [model] }));
    expect(mapper.map(update(at('medium')), at('medium'))[0])
      .toEqual({ type: 'model_changed', data: { modelId: 'gpt', effort: 'medium', effortIsDefault: true } });
    // Choosing the level it's already on pins it, so the default mark goes.
    expect(mapper.pinEffort(at('medium'))).toEqual([{ type: 'model_changed', data: { modelId: 'gpt', effort: 'medium' } }]);
    expect(mapper.map(update(at('high')), at('high'))[0]).toEqual({ type: 'model_changed', data: { modelId: 'gpt', effort: 'high' } });

    // An effort requested at start isn't the default either.
    const pinned = new AcpChatEventMapper('copilot_acp', { effortPinned: true });
    pinned.prime(state({ configOptions: [model] }));
    expect(pinned.map(update(at('low')), at('low'))[0]).toEqual({ type: 'model_changed', data: { modelId: 'gpt', effort: 'low' } });
  });

  it('keeps a placeholder model unknown through updates before the first prompt (#2293)', () => {
    const effort = (current: string) => ({ type: 'select' as const, id: 'reasoning_effort', name: 'Effort', category: 'thought_level', currentValue: current, options: ['low', 'medium'].map((v) => ({ value: v, name: v })) });
    const model = (current: string) => ({ type: 'select' as const, id: 'model', name: 'Model', category: 'model', currentValue: current, options: ['sonnet', 'gpt'].map((v) => ({ value: v, name: v })) });
    const at = (m: string, e: string) => state({ configOptions: [model(m), effort(e)] });
    const update = (s: AcpSessionState) => ({ type: 'update' as const, sessionId: 's1', replay: false, update: { sessionUpdate: 'config_option_update' as const, configOptions: s.configOptions } });

    const mapper = new AcpChatEventMapper('copilot_acp', { modelUnresolved: true });
    expect(mapper.initialInfo(at('sonnet', 'medium'))).toEqual({ type: 'session_info', data: { nativeSessionId: 's1', model: null, models: [{ id: 'sonnet', label: 'sonnet' }, { id: 'gpt', label: 'gpt' }] } });
    mapper.prime(at('sonnet', 'medium'));
    // An effort chosen before the prompt: the agent's update still carries the placeholder.
    expect(mapper.pinEffort(at('sonnet', 'low'))).toEqual([]);
    expect(mapper.map(update(at('sonnet', 'low')), at('sonnet', 'low'))).toEqual([]);
    // Inside the first turn too: an update for something else (Copilot flips allow_all) still names the placeholder.
    mapper.map({ type: 'turn_started', sessionId: 's1', trigger: 'prompt' }, at('sonnet', 'low'));
    expect(mapper.map(update(at('sonnet', 'low')), at('sonnet', 'low'))).toEqual([]);
    // A failed turn doesn't confirm it.
    expect(mapper.map({ type: 'turn_ended', sessionId: 's1', stopReason: 'error', error: 'boom' }, at('sonnet', 'low')).map((d) => d.type)).toEqual(['error', 'turn_ended']);
    // The end of a turn that ran confirms it, even unchanged.
    mapper.map({ type: 'turn_started', sessionId: 's1', trigger: 'prompt' }, at('sonnet', 'low'));
    const ended = mapper.map({ type: 'turn_ended', sessionId: 's1', stopReason: 'end_turn' }, at('sonnet', 'low'));
    expect(ended.map((d) => d.type)).toEqual(['model_changed', 'session_info', 'turn_ended']);
    expect(ended[0]).toEqual({ type: 'model_changed', data: { modelId: 'sonnet', effort: 'low' } });
    expect(ended[1]).toEqual({ type: 'session_info', data: { efforts: ['low', 'medium'] } });

    // A model the agent switched to on its own (another model than the placeholder) is news at once.
    const switched = new AcpChatEventMapper('copilot_acp', { modelUnresolved: true });
    switched.prime(at('sonnet', 'medium'));
    expect(switched.map(update(at('gpt', 'medium')), at('gpt', 'medium'))[0]).toEqual({ type: 'model_changed', data: { modelId: 'gpt', effort: 'medium', effortIsDefault: true } });
  });

  it('reports an unchanged command list only once', () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    const cmds = { type: 'update' as const, sessionId: 's1', replay: false, update: { sessionUpdate: 'available_commands_update' as const, availableCommands: [{ name: 'compact', description: 'Compact' }] } };
    expect(mapper.map(cmds, state())).toHaveLength(1);
    expect(mapper.map(cmds, state())).toEqual([]);
  });

  it('maps compaction updates onto the shared compaction notice codes', () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    const compaction = (status: string, error?: string) => mapper.map(
      { type: 'update', sessionId: 's1', replay: false, update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status, ...(error && { error }) } },
      state(),
    ).map((d) => d.type === 'notice' && [d.data.level, d.data.code, d.data.message]);
    expect(compaction('in_progress')).toEqual([['info', COMPACTION_STARTED, 'Compacting context…']]);
    expect(compaction('completed')).toEqual([['info', 'compaction_completed', 'Context compacted']]);
    expect(compaction('failed', 'no room')).toEqual([['warn', 'compaction_failed', 'no room']]);
    expect(COMPACTION_SETTLED).toEqual(expect.arrayContaining(['compaction_completed', 'compaction_failed', 'compaction_cancelled']));
  });

  it('maps a compaction in an agent-initiated turn between that turn\'s start and end', () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    const compaction = (status: string) => ({ type: 'update' as const, sessionId: 's1', replay: false, update: { sessionUpdate: 'compaction_update' as const, compactionId: 'c1', status } });
    const drafts = [
      ...mapper.map({ type: 'turn_started', sessionId: 's1', trigger: 'agent' }, state()),
      ...mapper.map(compaction('in_progress'), state()),
      ...mapper.map(compaction('completed'), state()),
      ...mapper.map({ type: 'turn_ended', sessionId: 's1', stopReason: 'end_turn' }, state()),
    ];
    expect(drafts.map((d) => (d.type === 'notice' ? d.data.code : d.type === 'turn_started' ? `turn_started:${d.data.trigger}` : d.type)))
      .toEqual(['turn_started:system', COMPACTION_STARTED, 'compaction_completed', 'turn_ended']);
    // Notices are session-scoped (as for Codex); the chat shows the row between the turn's bounds.
    expect(drafts[0].turnId).toBeDefined();
    expect(drafts[3].turnId).toBe(drafts[0].turnId);
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
      unsupported: [],
    });
  });

  it('fills env_vars from the CLI env, over the RPC pipe only (#2222)', () => {
    const def = { command: 'node', args: ['bridge.js'], env: { CLUBHOUSE_AGENT_ID: 'a1' }, env_vars: ['CLUBHOUSE_HOOK_NONCE', 'ABSENT'] };
    expect(toAcpMcpServers({ clubhouse: def }, { CLUBHOUSE_HOOK_NONCE: 'n1' }).servers).toEqual([
      { name: 'clubhouse', command: 'node', args: ['bridge.js'], env: [{ name: 'CLUBHOUSE_AGENT_ID', value: 'a1' }, { name: 'CLUBHOUSE_HOOK_NONCE', value: 'n1' }] },
    ]);
    // No CLI env: nothing to forward.
    expect(toAcpMcpServers({ clubhouse: def }).servers[0]).toMatchObject({ env: [{ name: 'CLUBHOUSE_AGENT_ID', value: 'a1' }] });
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

describe('Clubhouse MCP over HTTP for ACP agents (#2240)', () => {
  const bridge = { command: 'node', args: ['bridge.js'], env: { CLUBHOUSE_MCP_FALLBACK_PORT: '4321' }, env_vars: ['CLUBHOUSE_HOOK_NONCE'] };
  const endpoints = { clubhouse: { url: 'http://127.0.0.1:4321/mcp/agent-1', headersFromEnv: { 'X-Clubhouse-Nonce': 'CLUBHOUSE_HOOK_NONCE' } } };
  const env = { CLUBHOUSE_HOOK_NONCE: 'n1' };

  it('sends the bridge as an http server with the nonce header when the agent takes http', () => {
    const out = toAcpMcpServers({ clubhouse: bridge, local: { command: 'tool' } }, env, {
      transports: { stdio: false, http: true, sse: true },
      httpEndpoints: endpoints,
    });
    expect(out.servers).toEqual([
      { type: 'http', name: 'clubhouse', url: 'http://127.0.0.1:4321/mcp/agent-1', headers: [{ name: 'X-Clubhouse-Nonce', value: 'n1' }] },
      { name: 'local', command: 'tool', args: [], env: [] },
    ]);
    // The agent refuses stdio: the leftover stdio server is named for a warning.
    expect(out.unsupported).toEqual(['local']);
  });

  it('keeps stdio when the agent does not advertise http', () => {
    const out = toAcpMcpServers({ clubhouse: bridge }, env, { transports: { stdio: true, http: false, sse: false }, httpEndpoints: endpoints });
    expect(out.servers).toEqual([
      { name: 'clubhouse', command: 'node', args: ['bridge.js'], env: [{ name: 'CLUBHOUSE_MCP_FALLBACK_PORT', value: '4321' }, { name: 'CLUBHOUSE_HOOK_NONCE', value: 'n1' }] },
    ]);
    expect(out.unsupported).toEqual([]);
  });

  it('Copilot (stdio: false) without the nonce: keeps the stdio bridge and names it unsupported', () => {
    const out = toAcpMcpServers({ clubhouse: bridge }, {}, { transports: { stdio: false, http: true, sse: true }, httpEndpoints: endpoints });
    expect(out.servers).toEqual([{ name: 'clubhouse', command: 'node', args: ['bridge.js'], env: [{ name: 'CLUBHOUSE_MCP_FALLBACK_PORT', value: '4321' }] }]);
    // No nonce means no header: never send an http entry the bridge would refuse.
    expect(out.servers.some((s) => 'type' in s)).toBe(false);
    expect(out.unsupported).toEqual(['clubhouse']);
  });

  it('keeps stdio when the header value is missing from the CLI env', () => {
    const out = toAcpMcpServers({ clubhouse: bridge }, {}, { transports: { stdio: true, http: true, sse: true }, httpEndpoints: endpoints });
    expect(out.servers[0]).toMatchObject({ name: 'clubhouse', command: 'node' });
  });

  it('Copilot: session/new carries the http entry as recorded, and stdio servers get a notice', async () => {
    const records = withoutRequest(loadAcpFixture(COPILOT, 'mcp-http-handshake.jsonl'), 'session/close');
    const { driver, replayer, proc } = setup(records);
    const session = await driver.start(startOpts({
      env: { CLUBHOUSE_HOOK_NONCE: 'nonce-1' },
      mcpServers: { clubhouse: bridge, local: { command: 'tool' } },
      mcpHttpEndpoints: endpoints,
    }));

    const recorded = records.find((r) => r.dir === 'out' && r.msg.method === 'session/new')!.msg.params as { mcpServers: unknown[] };
    const sent = replayer.written.find((m) => m.method === 'session/new')!.params as { mcpServers: unknown[] };
    // The shape the probe saw Copilot accept, with this test's nonce in the header.
    expect(sent.mcpServers[0]).toEqual(JSON.parse(JSON.stringify(recorded.mcpServers[0]).replace('[redacted]', 'nonce-1')));
    expect(sent.mcpServers[1]).toMatchObject({ name: 'local', command: 'tool' });

    proc.emit('exit', 0, null);
    const drafts: ChatEventDraft[] = [];
    for await (const d of session.events) drafts.push(d);
    expect(drafts.find((d) => d.type === 'notice')).toMatchObject({
      type: 'notice',
      data: { level: 'warn', code: 'mcp_servers_unsupported', message: "Copilot chat can't load stdio MCP servers, so these are off: local. Run them in Terminal mode, or set them up as HTTP servers." },
    });
    expect(replayer.errors).toEqual([]);
  });

  it('generic agent without http: the bridge stays stdio and no notice is raised', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const replayer = new AcpFixtureReplayer(proc, genericStart);
    const driver = createGenericAcpChatDriver('example');
    const session = await driver.start(startOpts({
      provider: 'example',
      env: { CLUBHOUSE_HOOK_NONCE: 'nonce-1' },
      mcpServers: { clubhouse: bridge },
      mcpHttpEndpoints: endpoints,
    }));
    const sent = replayer.written.find((m) => m.method === 'session/new')!.params as { mcpServers: Array<Record<string, unknown>> };
    expect(sent.mcpServers).toEqual([expect.objectContaining({ name: 'clubhouse', command: 'node' })]);
    proc.emit('exit', 0, null);
    const drafts: ChatEventDraft[] = [];
    for await (const d of session.events) drafts.push(d);
    expect(drafts.some((d) => d.type === 'notice' && d.data.code === 'mcp_servers_unsupported')).toBe(false);
  });
});

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
    expect(session.resumeFallback).toBe('not_found');
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
    driver.sessionOverrides = { resumeFirstReplyTimeoutMs: 40, resumeStallTimeoutMs: 40 };
    return { procs, replayers, driver };
  }

  it('gives up on a session/load that never answers and continues in a fresh session in a new process', async () => {
    const { procs, replayers, driver } = setupTwo(loadOnly, freshStart);
    const startedAt = Date.now();
    const session = await driver.start(startOpts({ resumeNativeSessionId: '88618d97' }));

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(session.nativeSessionId).toBe('s-fresh');
    expect(session.resumeFallback).toBe('stalled');
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
    driver.sessionOverrides = { resumeFirstReplyTimeoutMs: 200, resumeStallTimeoutMs: 200 };
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

  it('waits out a first reply slower than the stall window, then resumes on steady replay, and logs the timing (#2296)', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const replayer = new AcpFixtureReplayer(proc, loadOnly);
    const log = vi.fn();
    const driver = createCopilotAcpChatDriver(log);
    driver.sessionOverrides = { resumeFirstReplyTimeoutMs: 800, resumeStallTimeoutMs: 250 };
    const started = driver.start(startOpts({ resumeNativeSessionId: 'slow' }));

    const say = (msg: Record<string, unknown>) => proc.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    await vi.waitFor(() => expect(replayer.written[1]).toMatchObject({ method: 'session/load' }), { interval: 5 });
    // Nothing for 400ms, longer than the stall window, then replay 40ms apart.
    await new Promise((r) => setTimeout(r, 400));
    for (let i = 0; i < 4; i++) {
      say({ method: 'session/update', params: { sessionId: 'slow', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `old ${i}` } } } });
      await new Promise((r) => setTimeout(r, 40));
    }
    say({ id: replayer.written[1].id, result: {} });

    const session = await started;
    expect(session.nativeSessionId).toBe('slow');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const timing = log.mock.calls.find(([, msg]) => msg === 'ACP session/load timing')?.[2];
    expect(timing).toMatchObject({ sessionId: 'slow', outcome: 'ok', notifications: 4, windowsMs: { firstReply: 800, stall: 250 } });
    expect(timing.firstActivityMs).toBeGreaterThanOrEqual(350);
    expect(timing.totalMs).toBeGreaterThanOrEqual(timing.firstActivityMs);
    expect(timing.inboundChars).toBeGreaterThan(0);
    expect(timing.initializeToRequestMs).toBeGreaterThanOrEqual(0);
    // Counts and timings only: no replayed text.
    expect(JSON.stringify(timing)).not.toContain('old 0');
    // The same timings on the session, for chat start telemetry (#2304).
    expect(session.resumeTiming).toEqual({ loadMs: timing.totalMs, firstReplyMs: timing.firstActivityMs });
    expect(replayer.errors).toEqual([]);
  });

  it('logs a hang as no_reply with nothing received, once, before falling back', async () => {
    const log = vi.fn();
    const { replayers, driver } = setupTwo(loadOnly, freshStart);
    const logged = createCopilotAcpChatDriver(log);
    logged.sessionOverrides = driver.sessionOverrides;
    const session = await logged.start(startOpts({ resumeNativeSessionId: 'gone' }));

    expect(session.nativeSessionId).toBe('s-fresh');
    const timings = log.mock.calls.filter(([, msg]) => msg === 'ACP session/load timing').map((c) => c[2]);
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ sessionId: 'gone', outcome: 'no_reply', notifications: 0, firstActivityMs: null });
    // The fresh session carries the stalled load's timings (#2304).
    expect(session.resumeTiming).toEqual({ loadMs: timings[0].totalMs });
    expect(replayers[1].done).toBe(true);
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

describe('Copilot resume and level after a respawn (#2155)', () => {
  const copilotInit = loadAcpFixture(COPILOT, 'handshake-list-close.jsonl').slice(0, 2);

  it.each([
    ['a session that is not on disk', 'a27ef93a-0000-4000-8000-000000000000'],
    ['an id that is not a plain token', '../../etc'],
  ])('skips session/load for %s and starts fresh at once', async (_label, id) => {
    const { driver, replayer } = setup([
      ...copilotInit,
      { dir: 'out', msg: { jsonrpc: '2.0', id: 2, method: 'session/new' } },
      { dir: 'in', msg: { jsonrpc: '2.0', id: 2, result: { sessionId: 's-new' } } },
    ]);
    const startedAt = Date.now();
    const session = await driver.start(startOpts({ resumeNativeSessionId: id, env: copilotHomeWith() }));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(session.nativeSessionId).toBe('s-new');
    expect(replayer.written.some((m) => m.method === 'session/load')).toBe(false);
    // No load ran, so there are no load timings.
    expect(session.resumeTiming).toBeUndefined();
    expect(session.resumeFallback).toBe('not_found');
    const notice = (await session.events[Symbol.asyncIterator]().next()).value;
    expect(notice).toMatchObject({ type: 'notice', data: { code: 'resume_unavailable', message: expect.stringContaining('previous session was not found') } });
    expect(replayer.errors).toEqual([]);
  });

  it('re-sends Full access (allow_all on) after resuming, even though the session reports it', async () => {
    const load = loadAcpFixture(COPILOT, 'load-replay.jsonl');
    // Make the loaded session report allow_all "on", as one created in the terminal at Full access would.
    const reportsOn = load.map((r) => {
      const result = r.msg.result as { configOptions?: Array<{ id: string; currentValue: string }> } | undefined;
      if (r.dir !== 'in' || !result?.configOptions) return r;
      return { ...r, msg: { ...r.msg, result: { ...result, configOptions: result.configOptions.map((o) => (o.id === 'allow_all' ? { ...o, currentValue: 'on' } : o)) } } };
    });
    const { driver, replayer } = setup([...reportsOn, ...levelResend(reportsOn, 3)]);
    await driver.start(startOpts({
      level: 'full_access',
      resumeNativeSessionId: '5af70548-c3ac-4e25-b105-bec13faa1f20',
      env: copilotHomeWith('5af70548-c3ac-4e25-b105-bec13faa1f20'),
    }));
    expect(replayer.written.find((m) => m.method === 'session/set_config_option')).toMatchObject({ params: { configId: 'allow_all', value: 'on' } });
    expect(replayer.errors).toEqual([]);
  });
});

describe('ACP permission card content (#2159)', () => {
  const state = (): AcpSessionState => ({
    sessionId: 's1', modes: null, configOptions: [], legacyModels: null, availableCommands: [], title: null, context: null, turnInFlight: false,
  });
  const options = [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' as const }];

  it("takes the path and diff from the tool call when Copilot's request has neither", () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    mapper.map({ type: 'update', sessionId: 's1', replay: false, update: {
      sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Creating hello.txt', kind: 'edit', status: 'pending',
      locations: [{ path: '/workspace/project/hello.txt' }],
      content: [{ type: 'diff', path: '/workspace/project/hello.txt', oldText: '', newText: 'hi' }],
    } }, state());
    const [draft] = mapper.map({ type: 'permission_request', sessionId: 's1', requestId: '0', toolCall: { toolCallId: 'call_1', title: 'Create file', kind: 'edit' }, options }, state());
    expect(draft).toMatchObject({
      type: 'permission_request',
      data: { title: 'Create file', description: '/workspace/project/hello.txt', content: [{ type: 'diff', path: '/workspace/project/hello.txt', newText: 'hi' }] },
    });
  });

  it("falls back to the request's raw input (Copilot's fileName and unified diff)", () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    const diff = '--- a/dev/null\n+++ b/workspace/project/hello.txt\n@@ -1,0 +1,1 @@\n+hi\n';
    const [draft] = mapper.map({ type: 'permission_request', sessionId: 's1', requestId: '0', toolCall: {
      toolCallId: 'call_2', title: 'Create file', rawInput: { fileName: '/workspace/project/hello.txt', diff },
    }, options }, state());
    expect(draft).toMatchObject({ data: { description: '/workspace/project/hello.txt', content: [{ type: 'diff', path: '/workspace/project/hello.txt', unifiedDiff: diff }] } });
  });

  it('uses the request locations, with line numbers, when they are present', () => {
    const mapper = new AcpChatEventMapper('acp');
    const [draft] = mapper.map({ type: 'permission_request', sessionId: 's1', requestId: '0', toolCall: {
      toolCallId: 'c', title: 'Edit', locations: [{ path: 'a.ts', line: 3 }, { path: 'b.ts' }],
    }, options }, state());
    expect(draft).toMatchObject({ data: { description: 'a.ts:3, b.ts' } });
    expect((draft as { data: { content?: unknown } }).data.content).toBeUndefined();
  });
});

describe('Copilot plan card, tasks, titles and context (#2176, #2177, #2178)', () => {
  const state = (): AcpSessionState => ({
    sessionId: 's1', modes: null, configOptions: [], legacyModels: null, availableCommands: [], title: null, context: null, turnInFlight: false,
  });
  const upd = (update: Record<string, unknown>) => ({ type: 'update' as const, sessionId: 's1', replay: false, update: update as never });

  // Copilot 1.0.82's plan write, from a real chat transcript (seq 95 and 96), with
  // its home directory swapped for a temp one. The tool_call has only a string
  // rawInput; the path and diff arrive on the tool_call_update.
  const sid = 'd71aeae6-cc77-49f5-b5a3-12c313ea0959';
  const planText = "# Fictional Fix Changelog Plan\n\n## Problem and approach\n\nAdd a fictional, user-visible bug fix to the repository's established release-note flow. Because this project does not maintain a standalone changelog, the entry should be represented in the version-bump pull request under `# Bug Fixes`, using the concise, past-tense style consumed by the release pipeline.\n\n## Steps\n\n1. Define a short, user-facing description of the fictional fix in past tense, describing the corrected behavior without implementation details.\n2. Add the description as one bullet under `# Bug Fixes` in the next version-bump pull request body, preserving the required `Release: <title>` first line and omitting unrelated sections.\n3. Preview the rendered pull request body and confirm that the release parser will classify and display the entry in the What's New release notes.\n\n## Notes\n\n- Do not add or modify a repository-level `CHANGELOG` file; none exists and the documented release workflow uses pull request metadata.\n- Keep the entry fictional and clearly scoped if it is used for a test or demonstration, so it cannot be mistaken for a shipped fix.\n";
  const realPlanWrite = (planFile: string) => ({
    call: {
      sessionUpdate: 'tool_call', toolCallId: 'custom_call_Tfkd56Uq6eVMcvUuVIQksTN6', kind: 'edit', title: 'apply_patch', status: 'pending',
      rawInput: `*** Begin Patch\n*** Add File: ${planFile}\n${planText.replace(/\n$/, '').split('\n').map((l) => `+${l}`).join('\n')}\n*** End Patch\n`,
    },
    update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'custom_call_Tfkd56Uq6eVMcvUuVIQksTN6', status: 'completed',
      content: [{ type: 'diff', path: planFile, newText: planText }],
      rawOutput: { content: `Added 1 file(s): ${planFile}` },
    },
  });
  const copilotMapper = (home: string) => new AcpChatEventMapper('copilot_acp', { profile: COPILOT_ACP_PROFILE, env: { COPILOT_HOME: home } });
  const inSession = (): AcpSessionState => ({ ...state(), sessionId: sid });

  it("shows Copilot's real apply_patch plan write as the plan, never a workspace edit", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    const planFile = path.join(home, 'session-state', sid, 'plan.md');
    const { call, update } = realPlanWrite(planFile);
    const mapper = copilotMapper(home);
    mapper.map({ type: 'turn_started', sessionId: sid }, inSession());

    const started = mapper.map(upd(call), inSession());
    expect(started).toEqual([expect.objectContaining({ type: 'plan_document', data: { planId: planFile, markdown: planText, status: 'streaming', toolCallId: call.toolCallId } })]);
    // No file on disk: the update's diff is the plan.
    const done = mapper.map(upd(update), inSession());
    expect(done).toEqual([expect.objectContaining({ type: 'plan_document', data: { planId: planFile, markdown: planText, status: 'ready', toolCallId: call.toolCallId } })]);
  });

  it('reads the plan file from disk when the write completes', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    const planFile = path.join(home, 'session-state', sid, 'plan.md');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, `${planText}\n## Edited later\n`);
    const { call, update } = realPlanWrite(planFile);
    const mapper = copilotMapper(home);
    mapper.map(upd(call), inSession());
    expect(mapper.map(upd(update), inSession())).toEqual([expect.objectContaining({ type: 'plan_document', data: expect.objectContaining({ markdown: `${planText}\n## Edited later\n`, status: 'ready' }) })]);
  });

  it('spots the plan file on the tool_call_update when the tool_call did not name it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    const planFile = path.join(home, 'session-state', sid, 'plan.md');
    const { call, update } = realPlanWrite(planFile);
    const mapper = copilotMapper(home);
    const [card] = mapper.map(upd({ ...call, rawInput: undefined }), inSession());
    expect(card).toMatchObject({ type: 'tool_call', data: { title: 'apply_patch' } });
    const done = mapper.map(upd(update), inSession());
    expect(done).toEqual([
      expect.objectContaining({ type: 'plan_document', data: { planId: planFile, markdown: planText, status: 'ready', toolCallId: call.toolCallId } }),
      // The card already shown settles instead of hanging as pending.
      expect.objectContaining({ type: 'tool_call_update', data: { toolCallId: call.toolCallId, status: 'completed' } }),
    ]);
  });

  it("keeps a workspace plan.md and another session's plan as ordinary edits", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    for (const file of [path.join(home, 'project', 'plan.md'), path.join(home, 'session-state', '90936e2a-b030-43d9-9924-44a66e171a4a', 'plan.md')]) {
      const { call, update } = realPlanWrite(file);
      const mapper = copilotMapper(home);
      expect(mapper.map(upd(call), inSession()).map((d) => d.type)).toEqual(['tool_call']);
      expect(mapper.map(upd(update), inSession()).map((d) => d.type)).toEqual(['tool_call_update']);
    }
  });

  it('feeds the todos sql call into the task list when it completes', () => {
    const mapper = new AcpChatEventMapper('copilot_acp', { profile: COPILOT_ACP_PROFILE });
    mapper.map(upd({
      sessionUpdate: 'tool_call', toolCallId: 'call_sql', title: 'Store changelog plan todos', kind: 'other', status: 'pending',
      rawInput: { description: 'Store changelog plan todos', query: "INSERT INTO todos (id, title, status) VALUES ('a', 'Draft entry', 'pending'), ('b', 'Place entry', 'pending')" },
    }), state());
    const drafts = mapper.map(upd({ sessionUpdate: 'tool_call_update', toolCallId: 'call_sql', status: 'completed' }), state());
    expect(drafts[0]).toEqual({ type: 'plan', data: { entries: [{ id: 'a', content: 'Draft entry', status: 'pending' }, { id: 'b', content: 'Place entry', status: 'pending' }] } });
    expect(drafts[1]).toMatchObject({ type: 'tool_call_update', data: { toolCallId: 'call_sql', status: 'completed' } });
  });

  it('gives a punctuation-only title a readable fallback', () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    const title = (update: Record<string, unknown>) => {
      const [d] = mapper.map(upd({ sessionUpdate: 'tool_call', toolCallId: String(Math.random()), status: 'pending', ...update }), state());
      return d.type === 'tool_call' ? d.data.title : '';
    };
    expect(title({ title: '.', kind: 'execute' })).toBe('Run command');
    expect(title({ title: ' ', name: 'view', kind: 'read' })).toBe('view');
    expect(title({ title: '…' })).toBe('Tool');
    expect(title({ title: 'Viewing a.ts', kind: 'read' })).toBe('Viewing a.ts');
  });

  it('never lets a punctuation-only update title replace a readable one', () => {
    const mapper = new AcpChatEventMapper('copilot_acp');
    mapper.map(upd({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Viewing a.ts', kind: 'read', status: 'pending' }), state());
    mapper.map(upd({ sessionUpdate: 'tool_call', toolCallId: 'b', title: '.', kind: 'execute', status: 'pending' }), state());
    const title = (toolCallId: string, t: string) => {
      const [d] = mapper.map(upd({ sessionUpdate: 'tool_call_update', toolCallId, title: t, status: 'in_progress' }), state());
      return d.type === 'tool_call_update' ? d.data.title : undefined;
    };
    expect(title('a', '.')).toBe('Viewing a.ts');
    expect(title('b', '.')).toBe('Run command');
    expect(title('unseen', '.')).toBe('Tool');
    expect(title('a', 'Viewed a.ts')).toBe('Viewed a.ts');
  });

  it("marks Copilot's context size as the input window, and leaves other agents' alone", () => {
    const usage = { sessionUpdate: 'usage_update', used: 17_000, size: 272_000 };
    expect(new AcpChatEventMapper('copilot_acp', { profile: COPILOT_ACP_PROFILE }).map(upd(usage), state()))
      .toEqual([{ type: 'usage', data: { scope: 'session', context: { used: 17_000, size: 272_000, window: 'input' } } }]);
    expect(new AcpChatEventMapper('acp').map(upd(usage), state()))
      .toEqual([{ type: 'usage', data: { scope: 'session', context: { used: 17_000, size: 272_000 } } }]);
  });
});

describe('Copilot ACP chat driver: work Copilot starts after the prompt ended (#2191)', () => {
  // The recorded 1.0.98 background-agent session, with the prompt answered
  // right after "STARTED" as 1.0.82 did. The driver doesn't choose agent mode
  // (it is already the default), so the recording's set_mode is dropped.
  function earlyAnswer() {
    const records = promptAnsweredEarly(
      withoutRequest(loadAcpFixture(COPILOT, 'background-agent.jsonl'), 'session/set_mode'),
      (r) => r.dir === 'in' && (r.msg.params as { update?: { content?: { text?: string } } } | undefined)?.update?.content?.text === 'STARTED',
    );
    const { driver, replayer } = setup(records);
    driver.sessionOverrides = { agentTurnIdleMs: 30, agentTurnToolIdleMs: 2_000, agentTurnCancelSettleMs: 20 };
    return { driver, replayer };
  }
  const turnDrafts = (drafts: ChatEventDraft[]) => drafts.flatMap((d) => {
    if (d.type === 'turn_started') return [`started:${d.data.trigger}`];
    if (d.type === 'turn_ended') return [`ended:${d.data.stopReason}`];
    return [];
  });

  it('reports the work as its own running turn (trigger system), not as orphaned events after Done', async () => {
    const { driver, replayer } = earlyAnswer();
    const session = await driver.start(startOpts({ model: 'claude-haiku-4.5' }));
    await session.send([{ type: 'text', text: 'Start a background agent, then report when notified.' }], 'prompt');
    const first = await collect(session, (d) => d.type === 'turn_ended');
    expect(turnDrafts(first)).toEqual(['started:prompt', 'ended:end_turn']);

    replayer.openGate();
    const second = await collect(session, (d) => d.type === 'turn_ended');
    expect(turnDrafts(second)).toEqual(['started:system', 'ended:end_turn']);
    // Everything the agent did lands inside that turn, under its id.
    const turnId = second[0].turnId;
    expect(turnId).toBeDefined();
    expect(turnId).not.toBe(first[0].turnId);
    const work = second.filter((d) => d.type === 'tool_call' || d.type === 'agent_message_chunk' || d.type === 'permission_request');
    expect(work.length).toBeGreaterThan(5);
    expect(work.every((d) => d.turnId === turnId)).toBe(true);
    expect(second.filter((d) => d.type === 'tool_call').map((d) => (d.data as { title: string }).title))
      .toEqual(['Sleep for 30 seconds then list files', 'read_agent', expect.stringContaining('found.txt')]);
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });

  it('interrupt during that turn sends session/cancel and ends it as cancelled', async () => {
    // Stop while the agent waits on the first permission request of its own work.
    const records = promptAnsweredEarly(
      withoutRequest(loadAcpFixture(COPILOT, 'background-agent.jsonl'), 'session/set_mode'),
      (r) => r.dir === 'in' && (r.msg.params as { update?: { content?: { text?: string } } } | undefined)?.update?.content?.text === 'STARTED',
    );
    const ask = records.findIndex((r) => r.dir === 'in' && r.msg.method === 'session/request_permission');
    const { driver, replayer } = setup([
      ...records.slice(0, ask + 1),
      { dir: 'out', msg: { jsonrpc: '2.0', id: records[ask].msg.id, result: { outcome: { outcome: 'cancelled' } } } },
      { dir: 'out', msg: { jsonrpc: '2.0', method: 'session/cancel' } },
    ]);
    driver.sessionOverrides = { agentTurnIdleMs: 30, agentTurnToolIdleMs: 2_000, agentTurnCancelSettleMs: 20 };
    const session = await driver.start(startOpts({ model: 'claude-haiku-4.5' }));
    const drafts: ChatEventDraft[] = [];
    void (async () => {
      for await (const d of session.events) drafts.push(d);
    })();
    const waitFor = async (check: () => boolean) => {
      for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(check()).toBe(true);
    };
    await session.send([{ type: 'text', text: 'Start a background agent, then report when notified.' }], 'prompt');
    await waitFor(() => drafts.some((d) => d.type === 'turn_ended'));

    replayer.openGate();
    await waitFor(() => drafts.some((d) => d.type === 'permission_request'));
    expect(turnDrafts(drafts)).toEqual(['started:prompt', 'ended:end_turn', 'started:system']);
    await session.interrupt();
    expect(replayer.written.at(-1)).toMatchObject({ method: 'session/cancel' });
    await waitFor(() => turnDrafts(drafts).length === 4);
    expect(turnDrafts(drafts)).toEqual(['started:prompt', 'ended:end_turn', 'started:system', 'ended:cancelled']);
    expect(drafts.find((d) => d.type === 'permission_resolved')).toMatchObject({ data: { decision: 'cancelled' } });
    expect(replayer.errors).toEqual([]);
    expect(replayer.done).toBe(true);
  });
});
