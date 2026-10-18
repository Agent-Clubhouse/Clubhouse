import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_CONTRACT_VERSION, isChatEvent, type ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverStartOptions } from '../../../shared/chat/runtime';
import {
  ClaudeChatDriver,
  claudeCapabilities,
  claudeImageInput,
  claudeQuestionInput,
  claudeTurnErrorCode,
  claudeModeFromLevel,
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
    expect(ended).toMatchObject({ turnId: 'turn-1', data: { stopReason: 'end_turn', costUsd: 0.0012, usage: { input: 10, cachedInput: 100, output: 5, total: 115 } } });
    const turnTypes = drafts.all.filter((d) => d.turnId === 'turn-1').map((d) => d.type);
    expect(turnTypes).toEqual(['turn_started', 'agent_message_chunk', 'agent_message_chunk', 'agent_message', 'usage', 'usage', 'turn_ended']);
    expect(drafts.of('usage').map((d) => [d.data.scope, d.data.costUsd])).toEqual([['turn', 0.0012], ['session', 0.0012]]);
    expect(drafts.of('agent_message')[0].data).toEqual({ messageId: 'msg_hello', text: 'Hello' });
    expect(drafts.of('usage')[0].data).toMatchObject({ scope: 'turn', costIsEstimate: true });
    expect(s.nativeSessionId).toBe('fake-session-1');
    // system/init arrives with the first prompt: native id and model via session_info.
    expect(drafts.of('session_info').map((d) => d.data)).toEqual([{ nativeSessionId: 'fake-session-1', cliVersion: '2.1.300-fake', model: 'claude-fake-1' }]);
    expect(drafts.of('model_changed').map((d) => d.data.modelId)).toEqual(['claude-fake-1']);
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
    const update = await drafts.waitFor('tool_call_update');
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
    expect(drafts.of('model_changed').map((d) => d.data.modelId)).toEqual(['haiku']);
    await expect(s.setLevel('full_access')).rejects.toThrow(/restarting/);
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
    expect((await drafts.waitFor('usage', (d) => d.data.scope === 'session')).data.limits).toEqual([
      { window: '5h', utilization: 0.91, status: 'warning', resetsAt: 1760000000000 },
    ]);
    await drafts.waitFor('turn_ended');
    await s.send([{ type: 'text', text: 'novel' }], 'prompt');
    expect((await drafts.waitFor('protocol_unknown')).data).toEqual({ driver: id, kind: 'field', name: 'system/brand_new_thing' });
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
      kind: 'allow_always', scope: 'acceptEdits mode',
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
  async start(): Promise<void> { this.emit({ kind: 'initialized', commands: [], models: [], raw: { claude_code_version: '2.1.300' } }); }
  send(input: ClaudeUserInput): void { this.sent.push(input); }
  respondToPermission(requestId: string, decision: ClaudePermissionDecision): void { this.answers.push([requestId, decision]); }
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async close(): Promise<void> { this.emit({ kind: 'session_ended', exitCode: 0, signal: null }); this.queue.finish(); }
  end(exitCode: number | null): void { this.emit({ kind: 'session_ended', exitCode, signal: null }); this.queue.finish(); }
}

describe('ClaudeChatDriverSession mapping (scripted transport)', () => {
  async function scripted(extra: Partial<ChatDriverStartOptions> = {}) {
    const transport = new ScriptedTransport();
    const driver = new ClaudeChatDriver('claude_agent_sdk', { createTransport: () => transport });
    const session = await driver.start({ agentId: 'a', provider: 'claude-code', cwd: os.tmpdir(), binaryPath: 'claude', level: 'ask', ...extra });
    const drafts = new Drafts(session.events);
    await drafts.waitFor('session_started');
    return { transport, session, drafts };
  }
  const result = (over: Partial<Extract<ClaudeChatEventBody, { kind: 'turn_ended' }>> = {}): ClaudeChatEventBody =>
    ({ kind: 'turn_ended', subtype: 'success', isError: false, ...over });
  const settle = () => new Promise((r) => setImmediate(r));

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
