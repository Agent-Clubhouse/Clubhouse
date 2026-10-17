import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_CONTRACT_VERSION, isChatEvent, type ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverStartOptions } from '../../../shared/chat/runtime';
import {
  ClaudeChatDriver,
  claudeCapabilities,
  claudeModeFromLevel,
  claudePermissionOptions,
  claudeToolContent,
  claudeToolKind,
  claudeToolTitle,
  levelFromClaudeMode,
  type ClaudeChatDriverId,
  type ClaudeChatDriverSession,
  type ClaudeTransportFactory,
} from './driver';
import { ClaudeSdkTransport } from './sdk-transport';
import { spawnClaude } from './spawn';
import { ClaudeStreamTransport } from './stream-transport';

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
    expect(turnTypes).toEqual(['turn_started', 'agent_message_chunk', 'agent_message_chunk', 'agent_message', 'usage', 'turn_ended']);
    expect(drafts.of('agent_message')[0].data).toEqual({ messageId: 'msg_hello', text: 'Hello' });
    expect(drafts.of('usage')[0].data).toMatchObject({ scope: 'turn', costIsEstimate: true });
    expect(s.nativeSessionId).toBe('fake-session-1');
    // Model reported by system/init.
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
    await drafts.waitFor('turn_ended');
    await expect(s.respondPermission(req.data.requestId, 'allow')).rejects.toThrow(/No pending/);
  });

  it('denies, and reports an unknown option without consuming the request', async () => {
    const s = await start();
    await s.send([{ type: 'text', text: 'tool' }], 'prompt');
    const req = await drafts.waitFor('permission_request');
    await expect(s.respondPermission(req.data.requestId, 'bogus')).rejects.toThrow(/Unknown/);
    await s.respondPermission(req.data.requestId, 'deny');
    expect((await drafts.waitFor('tool_call_update')).data).toMatchObject({ status: 'failed', error: 'The user denied this request.' });
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
      { window: '5h', utilization: 0.91, resetsAt: 1760000000000 },
    ]);
    await drafts.waitFor('turn_ended');
    await s.send([{ type: 'text', text: 'novel' }], 'prompt');
    expect((await drafts.waitFor('protocol_unknown')).data).toEqual({ driver: id, kind: 'event', name: 'system/brand_new_thing' });
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

describe('Claude contract mapping helpers', () => {
  it('maps the permission ladder both ways', () => {
    for (const level of ['plan', 'ask', 'auto_edit', 'auto', 'full_access'] as const) {
      expect(levelFromClaudeMode(claudeModeFromLevel(level))).toBe(level);
    }
    expect(levelFromClaudeMode('dontAsk')).toBe('ask');
    expect(levelFromClaudeMode('manual')).toBe('ask');
    expect(claudeCapabilities('full_access').liveLevels).toContain('full_access');
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
