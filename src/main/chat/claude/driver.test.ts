import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_CONTRACT_VERSION, COMPACTION_STARTED, isChatEvent, type ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverStartOptions } from '../../../shared/chat/runtime';
import {
  ClaudeChatDriver,
  claudeCapabilities,
  claudeImageInput,
  claudeInputDiff,
  claudeQuestionInput,
  claudeTurnErrorCode,
  claudeContextWindow,
  claudeModeFromLevel,
  planLimitsFromWire,
  claudeModelRow,
  APPLIED_SETTINGS_TIMEOUT_MS,
  claudePermissionOptions,
  claudeToolContent,
  claudeToolKind,
  claudeToolTitle,
  levelFromClaudeMode,
  registerClaudeChatDrivers,
  type ClaudeChatDriverId,
  type ClaudeChatDriverSession,
  type ClaudeTransportFactory,
} from './driver';
import { AsyncQueue } from '../../orchestrators/adapters/async-queue';
import type { ClaudeChatEvent, ClaudeChatEventBody } from './events';
import { ClaudeSdkTransport } from './sdk-transport';
import { spawnClaude } from './spawn';
import { ClaudeStreamTransport } from './stream-transport';
import type { ClaudePermissionDecision, ClaudeTransport, ClaudeUserInput } from './transport';

vi.mock('../../util/shell', async (importActual) => {
  const actual = await importActual<typeof import('../../util/shell')>();
  return { ...actual, getShellEnvironment: () => ({ ...process.env }) as Record<string, string> };
});

const FAKE_CLAUDE = path.join(__dirname, '__fixtures__', 'fake-claude.mjs');

/** Real transports; the stream one runs the fake through node (Windows can't exec .mjs). */
const transportFactory: ClaudeTransportFactory = (id, opts) =>
  id === 'claude_agent_sdk'
    ? new ClaudeSdkTransport(opts)
    : new ClaudeStreamTransport(opts, (o) => (o.binary === FAKE_CLAUDE
      ? spawnClaude({ ...o, binary: process.execPath, args: [FAKE_CLAUDE, ...o.args] })
      : spawnClaude(o)));

type DraftOf<T extends ChatEventDraft['type']> = Extract<ChatEventDraft, { type: T }>;

class Drafts {
  readonly all: ChatEventDraft[] = [];
  readonly done: Promise<void>;
  private wake: Array<() => void> = [];

  constructor(events: AsyncIterable<ChatEventDraft>) {
    this.done = (async () => {
      for await (const d of events) {
        this.all.push(d);
        for (const w of this.wake.splice(0)) w();
      }
      for (const w of this.wake.splice(0)) w();
    })();
  }

  async waitFor<T extends ChatEventDraft['type']>(type: T, pred: (d: DraftOf<T>) => boolean = () => true): Promise<DraftOf<T>> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const hit = this.all.find((d): d is DraftOf<T> => d.type === type && pred(d as DraftOf<T>));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}; saw ${this.types().join(', ')}`);
      await new Promise<void>((r) => { const t = setTimeout(r, 200); this.wake.push(() => { clearTimeout(t); r(); }); });
    }
  }

  of<T extends ChatEventDraft['type']>(type: T): Array<DraftOf<T>> {
    return this.all.filter((d): d is DraftOf<T> => d.type === type);
  }

  types(): string[] {
    return this.all.map((d) => d.type);
  }
}

describe.each<ClaudeChatDriverId>(['claude_agent_sdk', 'claude_stream_json'])('ClaudeChatDriver %s (fake claude)', (id) => {
  let tmp: string;
  let session: ClaudeChatDriverSession | null = null;
  let drafts: Drafts;
  const driver = new ClaudeChatDriver(id, { createTransport: transportFactory });

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-claude-driver-')); });
  afterEach(async () => {
    await session?.close();
    session = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function start(extra: Partial<ChatDriverStartOptions> = {}): Promise<ClaudeChatDriverSession> {
    session = await driver.start({ agentId: 'a1', provider: 'claude-code', cwd: tmp, binaryPath: FAKE_CLAUDE, level: 'ask', ...extra });
    drafts = new Drafts(session.events);
    return session;
  }

  it('probes with the zero-token handshake', async () => {
    const probe = await driver.probe(FAKE_CLAUDE);
    expect(probe).toMatchObject({ handshakeOk: true, cliVersion: '2.1.300-fake' });
  });

  it('reports a failed probe without throwing', async () => {
    const probe = await driver.probe(path.join(tmp, 'no-such-claude'));
    expect(probe.handshakeOk).toBe(false);
    expect(probe.error).toBeTruthy();
  });

  it('starts with session_started and commands, before any prompt', async () => {
    await start({ resumeNativeSessionId: 'resumed-1' });
    const started = await drafts.waitFor('session_started');
    expect(started.data).toMatchObject({
      driver: id, provider: 'claude-code', cwd: tmp, resumed: true, nativeSessionId: 'resumed-1',
      cliVersion: '2.1.300-fake', level: 'ask', capabilities: claudeCapabilities('ask'),
    });
    expect((await drafts.waitFor('commands_available')).data.commands).toEqual([{ name: 'review', description: 'Review a PR', inputHint: '<pr>' }]);
    expect(drafts.of('turn_started')).toHaveLength(0);
  });

  it('maps a streamed turn with turn ids and usage', async () => {
    const s = await start();
    expect(await s.send([{ type: 'text', text: 'hello' }], 'steer')).toBe('prompt');
    const ended = await drafts.waitFor('turn_ended');
    expect(ended).toMatchObject({ turnId: 'turn-1', data: { stopReason: 'end_turn', costUsd: 0.0012, usage: { input: 110, cachedInput: 100, output: 5, total: 115 } } });
    const turnTypes = drafts.all.filter((d) => d.turnId === 'turn-1').map((d) => d.type);
    expect(turnTypes).toEqual(['turn_started', 'agent_message_chunk', 'agent_message_chunk', 'agent_message', 'usage', 'usage', 'turn_ended']);
    const turnUsage = drafts.of('usage').filter((d) => d.turnId === 'turn-1');
    expect(turnUsage.map((d) => [d.data.scope, d.data.costUsd])).toEqual([['turn', 0.0012], ['session', 0.0012]]);
    expect(drafts.of('agent_message')[0].data).toEqual({ messageId: 'msg_hello', text: 'Hello' });
    // Context is the last main-loop call's prompt (2,000 + 30,000 cache read + 8,000 cache write)
    // against the model's window from modelUsage.
    expect(turnUsage[0].data).toMatchObject({ scope: 'turn', costIsEstimate: true, context: { used: 40_000, size: 200_000 } });
    // TokenUsage.input is the total input, cache included, for turn and session totals alike (#2170).
    for (const u of turnUsage) {
      const t = u.data.tokens;
      if (t) expect(t.input).toBe((t.total ?? 0) - (t.output ?? 0));
    }
    expect(s.nativeSessionId).toBe('fake-session-1');
    // system/init arrives with the first prompt: native id and model via session_info.
    // ...and the MCP servers it loaded, in the shared status words (#2093).
    expect(drafts.of('session_info').filter((d) => d.data.nativeSessionId).map((d) => d.data)).toEqual([{
      nativeSessionId: 'fake-session-1', cliVersion: '2.1.300-fake', model: 'claude-fake-1',
      mcpServers: [{ name: 'clubhouse', status: 'connected' }, { name: 'github', status: 'needs_auth' }],
    }]);
    // The CLI's model id maps onto its menu row, so the chip names it.
    expect(drafts.of('model_changed').map((d) => d.data.modelId)).toEqual(['fake']);
    // Every draft becomes a valid envelope once stamped.
    drafts.all.forEach((d, i) => {
      expect(isChatEvent({ ...d, v: CHAT_CONTRACT_VERSION, agentId: 'a1', sessionId: 's', seq: i + 1, ts: 1 })).toBe(true);
    });
  });

  it('maps a permission with native options and "always allow"', async () => {
    const s = await start();
    await s.send([{ type: 'text', text: 'tool' }], 'prompt');
    const req = await drafts.waitFor('permission_request');
    expect(req.data).toMatchObject({ title: 'Claude wants to run ls', toolCallId: 'toolu_1', toolName: 'Bash', rawInput: { command: 'ls' } });
    expect(req.data.options.map((o) => [o.optionId, o.kind])).toEqual([['allow', 'allow_once'], ['allow_always', 'allow_always'], ['deny', 'reject_once']]);
    expect(req.data.options[1].scope).toBe('Bash(ls)');
    expect((await drafts.waitFor('tool_call')).data).toMatchObject({ kind: 'execute', title: 'ls', status: 'pending' });

    await s.respondPermission(req.data.requestId, 'allow_always');
    expect((await drafts.waitFor('permission_resolved')).data).toEqual({ requestId: req.data.requestId, optionId: 'allow_always', decision: 'allow', by: 'user' });
    // Approved: it runs now (#2183 review), then completes.
    expect((await drafts.waitFor('tool_call_update')).data).toEqual({ toolCallId: 'toolu_1', status: 'in_progress' });
    const update = await drafts.waitFor('tool_call_update', (d) => d.data.status === 'completed');
    expect(update.data).toMatchObject({ toolCallId: 'toolu_1', status: 'completed', content: [{ type: 'terminal', command: 'ls', output: 'file.txt' }] });
    await drafts.waitFor('agent_message', (d) => d.data.text === `allowed:{"command":"ls"}:${JSON.stringify([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }])}`);
    await drafts.waitFor('turn_ended');
    await expect(s.respondPermission(req.data.requestId, 'allow')).rejects.toThrow(/No pending/);
  });

  it('surfaces AskUserQuestion as a question and answers it', async () => {
    const s = await start();
    await s.send([{ type: 'text', text: 'ask' }], 'prompt');
    const q = await drafts.waitFor('question');
    expect(q.data).toMatchObject({
      toolCallId: 'toolu_ask',
      questions: [{
        id: 'Which DB?', prompt: 'Which DB?', header: 'DB', multiSelect: false, allowFreeText: true,
        options: [{ id: 'Postgres', label: 'Postgres', description: 'SQL' }, { id: 'SQLite', label: 'SQLite' }],
      }],
    });
    expect(drafts.of('permission_request')).toHaveLength(0);
    await s.answerQuestion(q.data.requestId, { 'Which DB?': 'SQLite' });
    await drafts.waitFor('agent_message', (d) => d.data.text === 'answers:{"Which DB?":"SQLite"}');
    expect((await drafts.waitFor('question_resolved')).data).toEqual({ requestId: q.data.requestId, answers: { 'Which DB?': 'SQLite' } });
  });

  it('tags subagent text and tools with the Task call id', async () => {
    const s = await start();
    await s.send([{ type: 'text', text: 'sub' }], 'prompt');
    await drafts.waitFor('turn_ended');
    expect(drafts.of('subagent').map((d) => [d.data.subagentId, d.data.status, d.data.name])).toEqual([
      ['toolu_task', 'running', 'Explore'], ['toolu_task', 'completed', 'Explore'],
    ]);
    expect(drafts.of('agent_message').find((d) => d.data.text === 'Looking around')?.data.subagentId).toBe('toolu_task');
    expect(drafts.of('tool_call').find((d) => d.data.toolCallId === 'toolu_sub_read')?.data.subagentId).toBe('toolu_task');
  });

  it('passes a denial message and an edited input through', async () => {
    const s = await start();
    await s.send([{ type: 'text', text: 'tool' }], 'prompt');
    const req = await drafts.waitFor('permission_request');
    await s.respondPermission(req.data.requestId, 'allow', { updatedInput: { command: 'ls -la' } });
    await drafts.waitFor('agent_message', (d) => d.data.text === 'allowed:{"command":"ls -la"}:null');
  });

  it('denies, and reports an unknown option without consuming the request', async () => {
    const s = await start();
    await s.send([{ type: 'text', text: 'tool' }], 'prompt');
    const req = await drafts.waitFor('permission_request');
    await expect(s.respondPermission(req.data.requestId, 'bogus')).rejects.toThrow(/Unknown/);
    await s.respondPermission(req.data.requestId, 'deny', { message: 'Use git status instead' });
    expect((await drafts.waitFor('tool_call_update')).data).toMatchObject({ status: 'failed', error: 'Use git status instead' });
  });

  it('interrupt cancels the pending permission and ends the turn as cancelled', async () => {
    const s = await start();
    await s.send([{ type: 'text', text: 'tool' }], 'prompt');
    const req = await drafts.waitFor('permission_request');
    await s.interrupt();
    expect((await drafts.waitFor('permission_resolved')).data).toMatchObject({ requestId: req.data.requestId, decision: 'cancelled', by: 'agent' });
    expect((await drafts.waitFor('turn_ended')).data.stopReason).toBe('cancelled');
    expect(drafts.of('error')).toHaveLength(0);
  });

  it('switches level and model live; full_access needs a full_access start', async () => {
    const s = await start();
    await s.setLevel('plan');
    await s.setModel('haiku');
    expect(drafts.of('mode_changed').map((d) => d.data)).toEqual([{ level: 'plan', nativeMode: 'plan' }]);
    expect(drafts.of('model_changed').at(-1)?.data).toEqual({ modelId: 'haiku' });
    await expect(s.setLevel('full_access')).rejects.toThrow(/restarting/);
  });

  it('offers the model menu with each model\'s effort levels, and reports the applied model and effort (#2091)', async () => {
    await start();
    const menu = await drafts.waitFor('session_info', (d) => !!d.data.models);
    expect(menu.data.models).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'fake', label: 'Fake 1' },
      { id: 'haiku', label: 'Haiku' },
    ]);
    // No effort chosen at launch: the level shown is Claude's default.
    expect((await drafts.waitFor('model_changed')).data).toEqual({ modelId: 'fake', effort: 'medium', effortIsDefault: true });
    expect((await drafts.waitFor('session_info', (d) => !!d.data.efforts)).data.efforts).toEqual(['low', 'medium', 'high']);
    expect(claudeCapabilities('ask').effortSwitch).toBe('live');
  });

  it('changes effort live, and drops it for a model without effort (#2091)', async () => {
    const s = await start();
    await drafts.waitFor('model_changed');
    await s.setModel('fake', 'high');
    expect(drafts.of('model_changed').at(-1)?.data).toEqual({ modelId: 'fake', effort: 'high' });
    await s.setModel('haiku');
    expect(drafts.of('model_changed').at(-1)?.data).toEqual({ modelId: 'haiku' });
    expect(drafts.of('session_info').filter((d) => d.data.efforts).at(-1)?.data.efforts).toEqual([]);
  });

  it('follows /model and /effort typed as messages (#2091)', async () => {
    const s = await start();
    await drafts.waitFor('model_changed');
    await s.send([{ type: 'text', text: '/effort low' }], 'prompt');
    await drafts.waitFor('model_changed', (d) => d.data.effort === 'low');
    await s.send([{ type: 'text', text: '/model haiku' }], 'prompt');
    expect((await drafts.waitFor('model_changed', (d) => d.data.modelId === 'haiku')).data).toEqual({ modelId: 'haiku' });
  });

  it('steers into the running turn instead of cutting it', async () => {
    const s = await start();
    await s.send([{ type: 'text', text: 'tool' }], 'prompt');
    const req = await drafts.waitFor('permission_request');
    expect(await s.send([{ type: 'text', text: 'also check git' }], 'steer')).toBe('steer');
    await s.respondPermission(req.data.requestId, 'allow');
    await drafts.waitFor('agent_message', (d) => d.data.text === 'allowed:{"command":"ls"}:null|steered:also check git');
    const ended = await drafts.waitFor('turn_ended');
    expect(ended.data.stopReason).toBe('end_turn');
    expect(drafts.of('turn_started')).toHaveLength(1);
    expect(drafts.of('error')).toHaveLength(0);
  });

  it('maps steer and queue to Claude priorities while a turn runs', async () => {
    const s = await start();
    await s.send([{ type: 'text', text: 'tool' }], 'prompt');
    await drafts.waitFor('permission_request');
    expect(await s.send([{ type: 'text', text: 'later one' }], 'queued')).toBe('queued');
    await s.interrupt();
    // The queued message runs as its own turn once the interrupted one ends.
    const second = await drafts.waitFor('turn_ended', (d) => d.turnId === 'turn-2');
    expect(second.data.stopReason).toBe('end_turn');
    expect(drafts.of('turn_started').map((d) => d.data.trigger)).toEqual(['prompt', 'queued']);
  });

  it('maps rate limits to session usage, and unknown messages to protocol_unknown', async () => {
    const s = await start();
    await s.send([{ type: 'text', text: 'limit' }], 'prompt');
    expect((await drafts.waitFor('usage', (d) => d.data.limits?.length === 1)).data.limits).toEqual([
      { window: '5h', utilization: 0.91, status: 'warning', resetsAt: 1760000000000 },
    ]);
    await drafts.waitFor('turn_ended');
    await s.send([{ type: 'text', text: 'novel' }], 'prompt');
    expect((await drafts.waitFor('protocol_unknown')).data).toEqual({ driver: id, kind: 'field', name: 'system/brand_new_thing' });
  });

  it('reads every plan window from get_usage at start: 5-hour, weekly and per-model', async () => {
    await start();
    const usage = await drafts.waitFor('usage', (d) => (d.data.limits?.length ?? 0) > 1);
    expect(usage.data).toEqual({
      scope: 'session',
      limits: [
        { window: '5h', utilization: 0.42, resetsAt: Date.parse('2026-10-18T15:00:00.000Z') },
        { window: 'week', utilization: 0.71, resetsAt: Date.parse('2026-10-21T09:00:00.000Z') },
        { window: 'week_sonnet', utilization: 0.12, resetsAt: Date.parse('2026-10-21T09:00:00.000Z') },
        { window: 'week:Fable', utilization: 0.05, resetsAt: Date.parse('2026-10-21T09:00:00.000Z') },
      ],
    });
  });

  it('ends with session_ended: stopped on close, error on crash', async () => {
    const s = await start();
    await s.close();
    await drafts.done;
    expect(drafts.all[drafts.all.length - 1]).toMatchObject({ type: 'session_ended', data: { reason: 'stopped' } });
    session = null;

    const crashing = await start();
    await crashing.send([{ type: 'text', text: 'crash' }], 'prompt');
    await drafts.done;
    expect(drafts.of('session_ended')[0].data.reason).toBe('error');
  });
});

describe('registerClaudeChatDrivers', () => {
  it('registers the SDK driver first, then stream-json, and unregisters both', () => {
    const registered: string[] = [];
    const unregister = registerClaudeChatDrivers((d) => {
      registered.push(`${d.provider}:${d.id}`);
      return () => registered.splice(registered.indexOf(`${d.provider}:${d.id}`), 1);
    });
    expect(registered).toEqual(['claude-code:claude_agent_sdk', 'claude-code:claude_stream_json']);
    unregister();
    expect(registered).toEqual([]);
  });
});

describe('Claude contract mapping helpers', () => {
  it('maps the permission ladder both ways', () => {
    for (const level of ['plan', 'ask', 'auto_edit', 'auto', 'full_access'] as const) {
      expect(levelFromClaudeMode(claudeModeFromLevel(level))).toBe(level);
    }
    expect(levelFromClaudeMode('dontAsk')).toBe('ask');
    expect(levelFromClaudeMode('manual')).toBe('ask');
    expect(claudeCapabilities('full_access').liveLevels).toContain('full_access');
    expect(claudeCapabilities('ask').permissionExtras).toEqual({ denyMessage: true, updatedInput: true });
    expect(claudeCapabilities('auto').liveLevels).not.toContain('full_access');
  });

  it('classifies and titles tools', () => {
    const cwd = path.join(os.tmpdir(), 'proj');
    expect(claudeToolKind('Edit')).toBe('edit');
    expect(claudeToolKind('mcp__clubhouse__send_message')).toBe('other');
    expect(claudeToolTitle('Edit', { file_path: path.join(cwd, 'src', 'a.ts') }, cwd)).toBe(`Edit ${path.join('src', 'a.ts')}`);
    expect(claudeToolTitle('Bash', { command: 'npm test', description: 'Run tests' }, cwd)).toBe('Run tests');
    expect(claudeToolTitle('Grep', { pattern: 'TODO' }, cwd)).toBe('Search for TODO');
  });

  it('builds diff content from Edit and Write results', () => {
    expect(claudeToolContent('Edit', {}, { filePath: 'a.ts', oldString: 'x', newString: 'y', structuredPatch: [] }, 'ok', '')).toEqual([
      { type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' },
    ]);
    expect(claudeToolContent('Write', {}, { type: 'create', filePath: 'b.ts', content: 'new', originalFile: null }, 'ok', '')).toEqual([
      { type: 'diff', path: 'b.ts', oldText: undefined, newText: 'new' },
    ]);
    expect(claudeToolContent('Read', {}, undefined, 'contents', '')).toEqual([{ type: 'text', text: 'contents' }]);
  });

  it('offers "always" only when Claude suggests a rule', () => {
    expect(claudePermissionOptions([]).map((o) => o.kind)).toEqual(['allow_once', 'reject_once']);
    expect(claudePermissionOptions([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])[1]).toMatchObject({
      kind: 'allow_always', scope: 'Auto-accept edits',
    });
  });
});

// ── Mapping against a scripted transport ────────────────────────────────────


/** An in-memory transport: the test emits normalized events, the driver's calls are recorded. */
class ScriptedTransport implements ClaudeTransport {
  readonly kind = 'sdk' as const;
  readonly sent: ClaudeUserInput[] = [];
  readonly answers: Array<[string, ClaudePermissionDecision]> = [];
  sessionId = '';
  private readonly queue = new AsyncQueue<ClaudeChatEvent>();
  private seq = 0;
  get events(): AsyncIterable<ClaudeChatEvent> { return this.queue; }
  emit(body: ClaudeChatEventBody): void {
    this.queue.push({ ...body, sessionId: this.sessionId, turnId: 0, seq: ++this.seq } as ClaudeChatEvent);
  }
  async start(): Promise<void> { this.emit({ kind: 'initialized', commands: [], models: this.models, raw: { claude_code_version: '2.1.300' } }); }
  send(input: ClaudeUserInput): void { this.sent.push(input); }
  respondToPermission(requestId: string, decision: ClaudePermissionDecision): void { this.answers.push([requestId, decision]); }
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  readonly calls: string[] = [];
  async setModel(model?: string): Promise<void> { this.calls.push(`model:${model ?? 'default'}`); }
  async setEffort(effort: string): Promise<void> {
    this.calls.push(`effort:${effort}`);
    if (this.effortError) throw this.effortError;
  }
  effortError: Error | undefined;
  applied: { model?: string; effort?: string | null } = {};
  models: Extract<ClaudeChatEventBody, { kind: 'initialized' }>['models'] = [];
  /** Replace to make the read hang or fail. */
  readApplied: () => Promise<{ model?: string; effort?: string | null }> = async () => this.applied;
  appliedSettings() { return this.readApplied(); }
  async close(): Promise<void> { this.emit({ kind: 'session_ended', exitCode: 0, signal: null }); this.queue.finish(); }
  end(exitCode: number | null): void { this.emit({ kind: 'session_ended', exitCode, signal: null }); this.queue.finish(); }
}

describe('ClaudeChatDriverSession mapping (scripted transport)', () => {
  async function scripted(extra: Partial<ChatDriverStartOptions> = {}, setup?: (t: ScriptedTransport) => void) {
    const transport = new ScriptedTransport();
    setup?.(transport);
    const driver = new ClaudeChatDriver('claude_agent_sdk', { createTransport: () => transport });
    const session = await driver.start({ agentId: 'a', provider: 'claude-code', cwd: os.tmpdir(), binaryPath: 'claude', level: 'ask', ...extra });
    const drafts = new Drafts(session.events);
    await drafts.waitFor('session_started');
    return { transport, session, drafts };
  }
  const result = (over: Partial<Extract<ClaudeChatEventBody, { kind: 'turn_ended' }>> = {}): ClaudeChatEventBody =>
    ({ kind: 'turn_ended', subtype: 'success', isError: false, ...over });
  const settle = () => new Promise((r) => setImmediate(r));

  const menuRows = [
    { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', efforts: ['low', 'high'] },
    { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-5-5', efforts: [] },
  ];

  it('reports context fill per turn from the last main-loop call, against the 1M window', async () => {
    const { transport, session, drafts } = await scripted({ model: 'claude-opus-5-5[1m]' });
    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    const usage = { inputTokens: 3, outputTokens: 400, cacheReadInputTokens: 150_000, cacheCreationInputTokens: 49_997 };
    transport.emit({ kind: 'assistant_usage', messageId: 'm1', model: 'claude-opus-5-5', usage: { ...usage, cacheReadInputTokens: 10 } });
    transport.emit({ kind: 'assistant_usage', messageId: 'm2', model: 'claude-opus-5-5', usage });
    transport.emit(result({ modelUsage: { 'claude-opus-5-5[1m]': { inputTokens: 6, outputTokens: 800, contextWindow: 1_000_000 } } }));
    const turn = await drafts.waitFor('usage', (d) => d.data.scope === 'turn');
    expect(turn.data.context).toEqual({ used: 200_000, size: 1_000_000 });
  });

  it('maps every rate-limit window, extra usage, and keeps the status on get_usage windows', async () => {
    let answer!: (v: unknown) => void;
    const { transport, drafts } = await scripted({}, (t) => {
      (t as ScriptedTransport & { planUsage: () => Promise<unknown> }).planUsage = () => new Promise((r) => { answer = r; });
    });
    transport.emit({ kind: 'rate_limit', status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.71, resetsAt: 1_760_000_000, overageStatus: 'allowed', overageResetsAt: 1_760_500_000 });
    expect((await drafts.waitFor('usage', (d) => !!d.data.limits)).data.limits).toEqual([
      { window: 'week', utilization: 0.71, status: 'warning', resetsAt: 1_760_000_000_000 },
      { window: 'overage', status: 'ok', resetsAt: 1_760_500_000_000 },
    ]);
    transport.emit({ kind: 'rate_limit', status: 'allowed', rateLimitType: 'seven_day_opus' });
    expect((await drafts.waitFor('usage', (d) => d.data.limits?.[0]?.window === 'week_opus')).data.limits).toEqual([{ window: 'week_opus', status: 'ok' }]);
    answer({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 30, resets_at: null }, seven_day: { utilization: 72, resets_at: null } } });
    expect((await drafts.waitFor('usage', (d) => d.data.limits?.length === 2 && d.data.limits[0].window === '5h')).data.limits).toEqual([
      { window: '5h', utilization: 0.3 },
      { window: 'week', utilization: 0.72, status: 'warning' },
    ]);
  });

  it('ignores overageStatus "rejected" when extra usage is turned off (not a reached limit)', async () => {
    const { transport, drafts } = await scripted({});
    transport.emit({ kind: 'rate_limit', status: 'allowed', rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled' });
    expect((await drafts.waitFor('usage', (d) => !!d.data.limits)).data.limits).toEqual([{ window: '5h', status: 'ok' }]);
  });

  it('starts even when get_settings never answers (#2091)', async () => {
    vi.useFakeTimers();
    try {
      const transport = new ScriptedTransport();
      transport.readApplied = () => new Promise(() => {});
      const driver = new ClaudeChatDriver('claude_agent_sdk', { createTransport: () => transport });
      let started = false;
      const pending = driver.start({ agentId: 'a', provider: 'claude-code', cwd: os.tmpdir(), binaryPath: 'claude', level: 'ask' }).then((s) => { started = true; return s; });
      await vi.advanceTimersByTimeAsync(APPLIED_SETTINGS_TIMEOUT_MS - 1);
      expect(started).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await (await pending).close();
      expect(started).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without get_settings, drops the effort for a model that has none, and the levels with it', async () => {
    const { session, drafts } = await scripted({ model: 'opus', effort: 'high' }, (t) => {
      t.models = menuRows;
      t.readApplied = async () => { throw new Error('unknown subtype get_settings'); };
    });
    await session.setModel('haiku');
    await settle();
    expect(drafts.of('model_changed').at(-1)?.data).toEqual({ modelId: 'haiku' });
    expect(drafts.of('session_info').filter((d) => d.data.efforts).at(-1)?.data.efforts).toEqual([]);
    await session.setModel('opus', 'low');
    await settle();
    expect(drafts.of('model_changed').at(-1)?.data).toEqual({ modelId: 'opus', effort: 'low' });
    await session.setModel('claude-unlisted');
    await settle();
    expect(drafts.of('session_info').filter((d) => d.data.efforts).at(-1)?.data.efforts).toEqual([]);
  });

  it('reports the model that did change when the effort change fails, then rethrows', async () => {
    const { session, transport, drafts } = await scripted({}, (t) => {
      t.models = menuRows;
      t.effortError = new Error('effort refused');
    });
    transport.applied = { model: 'claude-opus-5-5', effort: 'medium' };
    await expect(session.setModel('opus', 'high')).rejects.toThrow('effort refused');
    await settle();
    expect(transport.calls).toEqual(['model:opus', 'effort:high']);
    expect(drafts.of('model_changed').at(-1)?.data).toEqual({ modelId: 'opus', effort: 'medium', effortIsDefault: true });
  });

  it('returns the effort to the model default with null, then reports what applies (#2136)', async () => {
    const { session, transport, drafts } = await scripted({}, (t) => {
      t.models = menuRows;
      t.applied = { model: 'claude-opus-5-5', effort: 'low' };
    });
    await settle();
    expect(claudeCapabilities('ask').effortDefault).toBe(true);
    transport.applied = { model: 'claude-opus-5-5', effort: 'high' };
    await session.setModel('opus', null);
    await settle();
    expect(transport.calls).toEqual(['effort:null']);
    // The level Claude resolves to shows, marked as the default.
    expect(drafts.of('model_changed').at(-1)?.data).toEqual({ modelId: 'opus', effort: 'high', effortIsDefault: true });

    // Choosing that same level pins it: it's sent, and no longer the default.
    await session.setModel('opus', 'high');
    await settle();
    expect(transport.calls).toEqual(['effort:null', 'effort:high']);
    expect(drafts.of('model_changed').at(-1)?.data).toEqual({ modelId: 'opus', effort: 'high' });
  });

  it('an effort chosen at launch or with /effort is not the default', async () => {
    const launched = await scripted({ effort: 'low' }, (t) => {
      t.models = menuRows;
      t.applied = { model: 'claude-opus-5-5', effort: 'low' };
    });
    await settle();
    expect(launched.drafts.of('model_changed').at(-1)?.data).toEqual({ modelId: 'opus', effort: 'low' });

    const { session, transport, drafts } = await scripted({}, (t) => {
      t.models = menuRows;
      t.applied = { model: 'claude-opus-5-5', effort: 'medium' };
    });
    await settle();
    expect(drafts.of('model_changed').at(-1)?.data).toMatchObject({ effortIsDefault: true });
    transport.applied = { model: 'claude-opus-5-5', effort: 'high' };
    await session.send([{ type: 'text', text: '/effort high' }], 'prompt');
    transport.emit(result());
    await vi.waitFor(() => expect(drafts.of('model_changed').at(-1)?.data).toEqual({ modelId: 'opus', effort: 'high' }));
  });

  it('/effort pins only with a known level at the start; /effort auto goes back to the default', async () => {
    const { session, transport, drafts } = await scripted({}, (t) => {
      t.models = menuRows;
      t.applied = { model: 'claude-opus-5-5', effort: 'medium' };
    });
    await settle();
    const turn = async (text: string) => {
      await session.send([{ type: 'text', text }], 'prompt');
      transport.emit(result());
      await settle();
      await settle();
    };
    const last = () => drafts.of('model_changed').at(-1)?.data;
    for (const text of ['please read about /effort high first', '/effort', '/effort turbo']) {
      await turn(text);
      expect(last()).toEqual({ modelId: 'opus', effort: 'medium', effortIsDefault: true });
    }
    transport.applied = { model: 'claude-opus-5-5', effort: 'high' };
    await turn('  /effort HIGH');
    expect(last()).toEqual({ modelId: 'opus', effort: 'high' });
    transport.applied = { model: 'claude-opus-5-5', effort: 'medium' };
    await turn('/effort auto');
    expect(last()).toEqual({ modelId: 'opus', effort: 'medium', effortIsDefault: true });
  });

  it('refuses an effort level Claude does not have, without touching the session', async () => {
    const { session, transport } = await scripted();
    await expect(session.setModel('opus', 'ultra')).rejects.toThrow(/no effort level "ultra"/);
    expect(transport.calls).toEqual([]);
  });

  it('names a [1m] variant on one line as its own menu row, and keeps it across turns (#2112)', async () => {
    const { session, transport, drafts } = await scripted({}, (t) => {
      t.models = [
        { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5-5', efforts: ['low', 'high'] },
        { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', efforts: ['low', 'high'] },
      ];
      t.applied = { model: 'claude-opus-5-5[1m]', effort: 'high' };
    });
    await settle();
    expect(drafts.of('model_changed').map((d) => d.data)).toEqual([{ modelId: 'opus[1m]', effort: 'high', effortIsDefault: true }]);
    const menu = drafts.of('session_info').filter((d) => d.data.models).at(-1)?.data.models;
    expect(menu?.at(-1)).toEqual({ id: 'opus[1m]', label: 'Opus 5.5 · 1M' });
    expect(menu).toHaveLength(3);
    // The per-turn init reports the same id: no flip back to the raw model.
    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    transport.emit({ kind: 'session_started', model: 'claude-opus-5-5[1m]', cwd: '/', permissionMode: 'default', cliVersion: '2.1.300', tools: [], slashCommands: [] });
    await settle();
    expect(drafts.of('model_changed')).toHaveLength(1);
    expect(drafts.of('session_info').filter((d) => d.data.models)).toHaveLength(2);
  });

  it('marks Claude Code\'s own commands start-only, not skills (#2135)', async () => {
    const transport = new ScriptedTransport();
    transport.start = async () => transport.emit({
      kind: 'initialized',
      commands: [{ name: 'compact', description: 'Compact', builtin: true }, { name: 'code-review', argumentHint: '<pr>' }],
      models: [],
      raw: {},
    });
    const driver = new ClaudeChatDriver('claude_agent_sdk', { createTransport: () => transport });
    const session = await driver.start({ agentId: 'a', provider: 'claude-code', cwd: os.tmpdir(), binaryPath: 'claude', level: 'ask' });
    const drafts = new Drafts(session.events);
    expect((await drafts.waitFor('commands_available')).data.commands).toEqual([
      { name: 'compact', description: 'Compact', inputHint: undefined, startOnly: true },
      { name: 'code-review', description: undefined, inputHint: '<pr>' },
    ]);
    await session.close();
  });

  it('reports per-turn cost from the CLI running total, and the total as session usage', async () => {
    const { session, transport, drafts } = await scripted();
    for (const total of [0.01, 0.03, 0.005]) {
      await session.send([{ type: 'text', text: 'go' }], 'prompt');
      transport.emit(result({ totalCostUsd: total, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }));
    }
    await settle();
    const turnCosts = drafts.of('turn_ended').map((d) => d.data.costUsd);
    expect(turnCosts[0]).toBeCloseTo(0.01);
    expect(turnCosts[1]).toBeCloseTo(0.02);
    // A /clear reset the running total: the new total is this turn's cost.
    expect(turnCosts[2]).toBeCloseTo(0.005);
    expect(drafts.of('usage').filter((d) => d.data.scope === 'session').map((d) => d.data.costUsd)).toEqual([0.01, 0.03, 0.005]);
  });

  it('leaves the first turn cost of a resumed session unknown', async () => {
    const { session, transport, drafts } = await scripted({ resumeNativeSessionId: 'old' });
    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    transport.emit(result({ totalCostUsd: 1.5 }));
    await session.send([{ type: 'text', text: 'again' }], 'prompt');
    transport.emit(result({ totalCostUsd: 1.75 }));
    await settle();
    expect(drafts.of('turn_ended').map((d) => d.data.costUsd)).toEqual([undefined, 0.25]);
  });

  it('reports exactly one error per failed turn, with a contract code', async () => {
    const { session, transport, drafts } = await scripted();
    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    transport.emit({ kind: 'error', message: 'authentication_failed', fatal: false, apiError: 'authentication_failed' });
    transport.emit(result({ subtype: 'error_during_execution', isError: true, errors: ['Invalid API key'] }));
    await session.send([{ type: 'text', text: 'big' }], 'prompt');
    transport.emit(result({ subtype: 'error_during_execution', isError: true, terminalReason: 'prompt_too_long' }));
    await settle();
    expect(drafts.of('error').map((d) => [d.turnId, d.data.code, d.data.message])).toEqual([
      ['turn-1', 'auth_required', 'Invalid API key'],
      ['turn-2', 'context_overflow', 'Turn failed (error_during_execution)'],
    ]);
  });

  it('maps max_tokens and refusal stop reasons without an error', async () => {
    const { session, transport, drafts } = await scripted();
    await session.send([{ type: 'text', text: 'a' }], 'prompt');
    transport.emit(result({ stopReason: 'max_tokens' }));
    await session.send([{ type: 'text', text: 'b' }], 'prompt');
    transport.emit(result({ stopReason: 'refusal' }));
    await settle();
    expect(drafts.of('turn_ended').map((d) => d.data.stopReason)).toEqual(['max_tokens', 'refusal']);
    expect(drafts.of('error')).toHaveLength(0);
  });

  it('maps TodoWrite to plan (main thread only) and ExitPlanMode to plan_document', async () => {
    const { session, transport, drafts } = await scripted();
    await session.send([{ type: 'text', text: 'plan' }], 'prompt');
    const todos = { todos: [{ content: 'Read', status: 'completed' }, { content: 'Fix', status: 'in_progress' }, { content: 'Test', status: 'pending' }] };
    transport.emit({ kind: 'tool_call', toolCallId: 't1', name: 'TodoWrite', input: todos });
    transport.emit({ kind: 'tool_call', toolCallId: 't2', name: 'TodoWrite', input: { todos: [{ content: 'sub step', status: 'pending' }] }, parentToolCallId: 'task' });
    transport.emit({ kind: 'tool_call', toolCallId: 't3', name: 'ExitPlanMode', input: { plan: '# Plan\n1. Fix' } });
    await settle();
    expect(drafts.of('plan').map((d) => d.data.entries)).toEqual([[
      { content: 'Read', status: 'completed' }, { content: 'Fix', status: 'in_progress' }, { content: 'Test', status: 'pending' },
    ]]);
    expect(drafts.of('plan_document').map((d) => d.data)).toEqual([{ planId: 't3', markdown: '# Plan\n1. Fix', status: 'ready', toolCallId: 't3' }]);
  });

  it('marks a tool running on its first progress report, once, and never after it finished (#2109)', async () => {
    const { session, transport, drafts } = await scripted();
    await session.send([{ type: 'text', text: 'run' }], 'prompt');
    transport.emit({ kind: 'tool_call', toolCallId: 'b1', name: 'Bash', input: { command: 'npm test' } });
    transport.emit({ kind: 'tool_progress', toolCallId: 'b1', toolName: 'Bash', elapsedSeconds: 3, heartbeat: false });
    transport.emit({ kind: 'tool_progress', toolCallId: 'b1', toolName: 'Bash', elapsedSeconds: 6, heartbeat: false });
    transport.emit({ kind: 'tool_progress', toolCallId: 'b1', toolName: 'Bash', elapsedSeconds: 9, heartbeat: true });
    transport.emit({ kind: 'tool_call_update', toolCallId: 'b1', name: 'Bash', status: 'completed', content: 'ok' });
    transport.emit({ kind: 'tool_progress', toolCallId: 'b1', toolName: 'Bash', elapsedSeconds: 12, heartbeat: true });
    // Progress for a tool this session never saw adds nothing.
    transport.emit({ kind: 'tool_progress', toolCallId: 'ghost', toolName: 'Bash', elapsedSeconds: 1, heartbeat: false });
    await settle();
    expect(drafts.of('tool_call_update').map((d) => [d.data.toolCallId, d.data.status])).toEqual([['b1', 'in_progress'], ['b1', 'completed']]);
    expect(drafts.of('tool_call_update')[0].turnId).toBe('turn-1');
  });

  it('turns a subagent retry into a notice (#2109)', async () => {
    const { transport, drafts } = await scripted();
    transport.emit({
      kind: 'tool_progress', toolCallId: 'task', toolName: 'Task', elapsedSeconds: 0, heartbeat: false, subagentType: 'Explore',
      retry: { attempt: 2, maxRetries: 10, retryDelayMs: 4000, errorStatus: 529, errorCategory: 'overloaded' },
    });
    await settle();
    expect(drafts.of('notice').map((d) => d.data)).toContainEqual({
      level: 'info', code: 'subagent_retry', message: 'Explore is retrying its request after a 529 error (attempt 2 of 10).',
    });
  });

  it('maps VCS changes to workspace_changed and treats background tasks as known (#2109)', async () => {
    const { transport, drafts } = await scripted();
    transport.emit({ kind: 'vcs_changed', vcsKind: 'commit', branch: 'fix/x', cwd: '/repo' });
    transport.emit({ kind: 'background_tasks', tasks: [{ taskId: 't1', taskType: 'local_bash', description: 'dev server', ambient: false }] });
    await settle();
    expect(drafts.of('workspace_changed').map((d) => d.data)).toEqual([{ reason: 'vcs', vcsKind: 'commit', branch: 'fix/x' }]);
    expect(drafts.of('protocol_unknown')).toHaveLength(0);
    expect(drafts.of('turn_started')).toHaveLength(0);
  });

  it('maps system/status permission mode changes', async () => {
    const { transport, drafts } = await scripted();
    transport.emit({ kind: 'mode_changed', permissionMode: 'acceptEdits' });
    transport.emit({ kind: 'mode_changed', permissionMode: 'acceptEdits' });
    await settle();
    expect(drafts.of('mode_changed').map((d) => d.data)).toEqual([{ level: 'auto_edit', nativeMode: 'acceptEdits' }]);
    expect(drafts.of('mode_changed')[0].turnId).toBeUndefined();
  });

  it('shows a running compaction notice for /compact and settles it on compact_boundary', async () => {
    const { session, transport, drafts } = await scripted();
    await session.send([{ type: 'text', text: '/compact' }], 'prompt');
    transport.emit({ kind: 'compaction', phase: 'started' });
    // The CLI can repeat the status; one start notice goes out.
    transport.emit({ kind: 'compaction', phase: 'started' });
    transport.emit({ kind: 'compacted', trigger: 'manual', preTokens: 180_000 });
    transport.emit(result());
    await drafts.waitFor('turn_ended');
    expect(drafts.of('notice').map((d) => [d.turnId, d.data.code, d.data.message])).toEqual([
      ['turn-1', COMPACTION_STARTED, 'Compacting context…'],
      ['turn-1', 'compacted', 'Context compacted'],
    ]);
  });

  it('reports a failed compaction, then starts a new one on the next status', async () => {
    const { transport, drafts } = await scripted();
    transport.emit({ kind: 'compaction', phase: 'failed', error: 'ignored: nothing running' });
    transport.emit({ kind: 'compaction', phase: 'started' });
    transport.emit({ kind: 'compaction', phase: 'failed', error: 'summary too long' });
    transport.emit({ kind: 'compaction', phase: 'started' });
    transport.emit({ kind: 'conversation_reset', trigger: 'clear' });
    await drafts.waitFor('notice', (d) => d.data.code === 'conversation_reset');
    expect(drafts.of('notice').map((d) => [d.data.level, d.data.code, d.data.message])).toEqual([
      ['info', COMPACTION_STARTED, 'Compacting context…'],
      ['warn', 'compaction_failed', 'Context compaction failed: summary too long'],
      ['info', COMPACTION_STARTED, 'Compacting context…'],
      ['info', 'conversation_reset', 'Context cleared'],
    ]);
    expect(drafts.of('protocol_unknown')).toHaveLength(0);
  });

  it('does not open a turn for an idle crash or session-level events', async () => {
    const { transport, drafts } = await scripted();
    transport.emit({ kind: 'rate_limit', status: 'allowed' });
    transport.emit({ kind: 'subagent', phase: 'notification', taskId: 'x', raw: { status: 'completed' } });
    transport.emit({ kind: 'compacted', trigger: 'auto' });
    transport.emit({ kind: 'error', message: 'stream broke', fatal: true });
    transport.end(1);
    await drafts.done;
    expect(drafts.of('turn_started')).toHaveLength(0);
    expect(drafts.of('turn_ended')).toHaveLength(0);
    expect(drafts.of('error')[0].data).toMatchObject({ code: 'driver_stream_failed', fatal: true });
    expect(drafts.all.every((d) => d.turnId === undefined)).toBe(true);
    expect(drafts.of('session_ended')[0].data.reason).toBe('error');
  });

  it('ends a running turn when the CLI dies mid-turn', async () => {
    const { session, transport, drafts } = await scripted();
    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    transport.end(3);
    await drafts.done;
    expect(drafts.types().slice(-2)).toEqual(['turn_ended', 'session_ended']);
    expect(drafts.of('turn_ended')[0]).toMatchObject({ turnId: 'turn-1', data: { stopReason: 'error' } });
  });

  it('joins multiSelect answers for AskUserQuestion', async () => {
    const { session, transport, drafts } = await scripted();
    await session.send([{ type: 'text', text: 'ask' }], 'prompt');
    const input = { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }] };
    transport.emit({ kind: 'permission_request', requestId: 'q1', toolName: 'AskUserQuestion', input, suggestions: [] });
    const q = await drafts.waitFor('question');
    expect(q.data.questions[0].multiSelect).toBe(true);
    await session.answerQuestion('q1', { 'Which?': ['A', 'B'] });
    expect(transport.answers).toEqual([['q1', { behavior: 'allow', updatedInput: { ...input, answers: { 'Which?': 'A, B' } } }]]);
    expect(claudeQuestionInput({}, { x: 'one' })).toEqual({ answers: { x: 'one' } });
  });

  it('attaches images from local files and rejects remote ones', async () => {
    const { session, transport } = await scripted();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-img-')), 'shot.png');
    fs.writeFileSync(file, Buffer.from([1, 2, 3]));
    await session.send([{ type: 'text', text: 'see' }, { type: 'image', mimeType: 'image/png', path: file }], 'prompt');
    expect(transport.sent[0].images).toEqual([{ mediaType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }]);
    await expect(claudeImageInput({ type: 'image', mimeType: 'image/png', uri: 'https://example.com/a.png' })).rejects.toThrow(/only inline data or local files/);
    await expect(claudeImageInput({ type: 'image', mimeType: 'image/tiff', data: 'AA' })).rejects.toThrow(/image\/tiff/);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('attaches the input diff to a pending Edit call', async () => {
    const { session, transport, drafts } = await scripted();
    await session.send([{ type: 'text', text: 'edit' }], 'prompt');
    transport.emit({ kind: 'tool_call', toolCallId: 'toolu_edit', name: 'Edit', input: { file_path: '/work/PRINCIPLES.md', old_string: '2026-10-18', new_string: '2026-10-19' } });
    const call = await drafts.waitFor('tool_call');
    expect(call.data).toMatchObject({ status: 'pending', content: [{ type: 'diff', path: '/work/PRINCIPLES.md', oldText: '2026-10-18', newText: '2026-10-19' }] });
  });

  it('re-emits the plan document with the edited text when an edited plan is approved (#2167)', async () => {
    const { session, transport, drafts } = await scripted();
    await session.send([{ type: 'text', text: 'plan' }], 'prompt');
    transport.emit({ kind: 'tool_call', toolCallId: 'toolu_plan', name: 'ExitPlanMode', input: { plan: 'Ship on 2026-10-18' } });
    transport.emit({ kind: 'permission_request', requestId: 'p1', toolName: 'ExitPlanMode', toolCallId: 'toolu_plan', input: { plan: 'Ship on 2026-10-18' }, suggestions: [] });
    await drafts.waitFor('permission_request');
    await session.respondPermission('p1', 'allow', { updatedInput: { plan: 'Ship on 2026-10-19' } });
    await drafts.waitFor('permission_resolved');
    const plans = drafts.of('plan_document');
    expect(plans.map((p) => p.data.markdown)).toEqual(['Ship on 2026-10-18', 'Ship on 2026-10-19']);
    expect(plans[1].data).toMatchObject({ planId: 'toolu_plan', toolCallId: 'toolu_plan', status: 'ready' });
    // The updated plan comes before the resolution, so the card is current when it's marked approved.
    const types = drafts.types();
    expect(types.lastIndexOf('plan_document')).toBeLessThan(types.lastIndexOf('permission_resolved'));
  });

  it('leaves the plan alone when it is denied or approved unedited', async () => {
    const { session, transport, drafts } = await scripted();
    await session.send([{ type: 'text', text: 'plan' }], 'prompt');
    transport.emit({ kind: 'tool_call', toolCallId: 'toolu_plan', name: 'ExitPlanMode', input: { plan: 'P' } });
    transport.emit({ kind: 'permission_request', requestId: 'p1', toolName: 'ExitPlanMode', toolCallId: 'toolu_plan', input: { plan: 'P' }, suggestions: [] });
    await drafts.waitFor('permission_request');
    await session.respondPermission('p1', 'deny', { message: 'no' });
    await drafts.waitFor('permission_resolved');
    expect(drafts.of('plan_document')).toHaveLength(1);
  });

  it('marks an approved tool call in progress, and leaves a denied one alone', async () => {
    const { session, transport, drafts } = await scripted();
    await session.send([{ type: 'text', text: 'run' }], 'prompt');
    transport.emit({ kind: 'tool_call', toolCallId: 'toolu_ok', name: 'Bash', input: { command: 'ls' } });
    transport.emit({ kind: 'permission_request', requestId: 'p1', toolName: 'Bash', toolCallId: 'toolu_ok', input: { command: 'ls' }, suggestions: [] });
    await drafts.waitFor('permission_request');
    await session.respondPermission('p1', 'allow');
    transport.emit({ kind: 'tool_call', toolCallId: 'toolu_no', name: 'Bash', input: { command: 'rm -rf /' } });
    transport.emit({ kind: 'permission_request', requestId: 'p2', toolName: 'Bash', toolCallId: 'toolu_no', input: { command: 'rm -rf /' }, suggestions: [] });
    await drafts.waitFor('permission_request', (d) => d.data.requestId === 'p2');
    await session.respondPermission('p2', 'deny', { message: 'no' });
    const running = drafts.of('tool_call_update').filter((d) => d.data.status === 'in_progress').map((d) => d.data.toolCallId);
    expect(running).toEqual(['toolu_ok']);
    const types = drafts.types();
    expect(types.indexOf('tool_call_update')).toBeGreaterThan(types.indexOf('permission_resolved'));
  });
});

describe('Claude chat UI fixes (chat-itest-2026-10-18)', () => {
  it('previews Edit, MultiEdit and Write changes from the tool input (#2168)', () => {
    expect(claudeInputDiff('Edit', { file_path: '/p/PRINCIPLES.md', old_string: 'a', new_string: 'b' }))
      .toEqual([{ type: 'diff', path: '/p/PRINCIPLES.md', oldText: 'a', newText: 'b' }]);
    expect(claudeInputDiff('MultiEdit', { file_path: '/p/x.ts', edits: [{ old_string: '1', new_string: '2' }, { old_string: '3', new_string: '4' }] }))
      .toHaveLength(2);
    const write = claudeInputDiff('Write', { file_path: '/p/new.md', content: 'one\ntwo\n' });
    expect(write).toEqual([{ type: 'diff', path: '/p/new.md', newText: 'one\ntwo\n', unifiedDiff: '@@ -0,0 +1,2 @@\n+one\n+two' }]);
    expect(claudeInputDiff('Bash', { command: 'ls' })).toBeUndefined();
    expect(claudeInputDiff('Edit', { old_string: 'a', new_string: 'b' })).toBeUndefined();
  });

  it('names an always-allow mode switch by its level (#2169)', () => {
    const [, always] = claudePermissionOptions([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
    expect(always.scope).toBe('Auto-accept edits');
    expect(claudePermissionOptions([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }])[1].scope).toBe('Full access');
  });

});

describe('Claude usage helpers', () => {
  it('reads plan windows from get_usage, skipping empty ones and accounts without plan limits', () => {
    expect(planLimitsFromWire({ rate_limits_available: false, rate_limits: null })).toBeNull();
    expect(planLimitsFromWire({ rate_limits_available: true, rate_limits: { five_hour: null, seven_day: { utilization: null, resets_at: null } } })).toBeNull();
    expect(planLimitsFromWire({
      rate_limits_available: true,
      rate_limits: {
        seven_day_oauth_apps: { utilization: 3, resets_at: '2026-10-21T09:00:00Z' },
        extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 10, utilization: 20 },
      },
    })).toEqual([
      { window: 'week_oauth_apps', utilization: 0.03, resetsAt: Date.parse('2026-10-21T09:00:00Z') },
      { window: 'overage', utilization: 0.2 },
    ]);
    // get_usage reports percent: 1 is 1%, not 100%; 0.5 is 0.5%.
    expect(planLimitsFromWire({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 1, resets_at: null }, seven_day: { utilization: 0.5, resets_at: null } } })).toEqual([
      { window: '5h', utilization: 0.01 },
      { window: 'week', utilization: 0.005 },
    ]);
  });

  it('finds the context window of the model that served the call: modelUsage, then the [1m] suffix, then 200K', () => {
    const mu = { 'claude-opus-5-5[1m]': { contextWindow: 1_000_000 }, 'claude-haiku-5-5': { contextWindow: 200_000 } };
    expect(claudeContextWindow('claude-opus-5-5', mu, 'claude-opus-5-5[1m]')).toBe(1_000_000);
    // A different model served the call (a fallback): its own window.
    expect(claudeContextWindow('claude-haiku-5-5', mu, 'claude-opus-5-5[1m]')).toBe(200_000);
    expect(claudeContextWindow('claude-haiku-5-5', mu)).toBe(200_000);
    expect(claudeContextWindow('claude-opus-5-5', undefined, 'opus[1m]')).toBe(1_000_000);
    expect(claudeContextWindow('claude-sonnet-5-5', undefined)).toBe(200_000);
    expect(claudeContextWindow(undefined, undefined)).toBeUndefined();
  });
});

describe('claudeModelRow', () => {
  const rows = [
    { value: 'default', resolvedModel: 'claude-opus-5-5', efforts: ['high'] },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', efforts: ['high'] },
    { value: 'claude-opus-4-6', resolvedModel: 'claude-opus-4-6', efforts: [] },
  ];
  it('matches by id, then by the resolved model with any [suffix] dropped, never via default', () => {
    expect(claudeModelRow(rows, 'default')?.value).toBe('default');
    expect(claudeModelRow(rows, 'claude-opus-5-5[1m]')?.value).toBe('opus');
    expect(claudeModelRow(rows, 'claude-opus-4-6')?.value).toBe('claude-opus-4-6');
    expect(claudeModelRow(rows, 'claude-unknown')).toBeUndefined();
    expect(claudeModelRow(rows, undefined)).toBeUndefined();
  });
});

describe('claudeTurnErrorCode', () => {
  it('prefers the API error, then terminal reason, then stop reason', () => {
    expect(claudeTurnErrorCode('rate_limit', 'prompt_too_long')).toBe('rate_limited');
    expect(claudeTurnErrorCode('billing_error')).toBe('account_issue');
    expect(claudeTurnErrorCode('account_on_hold')).toBe('account_issue');
    expect(claudeTurnErrorCode('authentication_failed')).toBe('auth_required');
    expect(claudeTurnErrorCode('overloaded')).toBe('unknown');
    expect(claudeTurnErrorCode(undefined, 'blocking_limit')).toBe('rate_limited');
    expect(claudeTurnErrorCode(undefined, 'api_error', 'refusal')).toBe('refusal');
    expect(claudeTurnErrorCode(undefined, undefined, 'max_tokens')).toBe('max_tokens');
    expect(claudeTurnErrorCode(undefined)).toBe('unknown');
  });
});
