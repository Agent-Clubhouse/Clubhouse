/**
 * Drives both Claude transports against the same fake `claude`
 * (__fixtures__/fake-claude.mjs), so they are checked to agree on one set of
 * normalized events. The SDK transport runs the real Agent SDK, pointed at
 * the fake via pathToClaudeCodeExecutable. No model is ever contacted.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeChatEvent } from './events';
import { ClaudeSdkTransport } from './sdk-transport';
import { spawnClaude } from './spawn';
import { ClaudeStreamTransport } from './stream-transport';
import type { ClaudeTransport, ClaudeTransportOptions } from './transport';

vi.mock('../../util/shell', async (importActual) => {
  const actual = await importActual<typeof import('../../util/shell')>();
  // Skip sourcing the login shell in tests.
  return { ...actual, getShellEnvironment: () => ({ ...process.env }) as Record<string, string> };
});

const FAKE_CLAUDE = path.join(__dirname, '__fixtures__', 'fake-claude.mjs');

type Kind = 'sdk' | 'stream-json';

function makeTransport(kind: Kind, opts: ClaudeTransportOptions): ClaudeTransport {
  if (kind === 'sdk') return new ClaudeSdkTransport(opts);
  // The SDK runs a .mjs path with node itself; the stream transport spawns the
  // binary directly, so route the fake through node here (Windows can't exec .mjs).
  return new ClaudeStreamTransport(opts, (o) =>
    spawnClaude({ ...o, binary: process.execPath, args: [FAKE_CLAUDE, ...o.args] }),
  );
}

/** Collects events in the background and lets a test wait for one. */
class Collector {
  readonly events: ClaudeChatEvent[] = [];
  private waiters: Array<() => void> = [];
  readonly done: Promise<void>;

  constructor(transport: ClaudeTransport) {
    this.done = (async () => {
      for await (const ev of transport.events) {
        this.events.push(ev);
        for (const w of this.waiters.splice(0)) w();
      }
      for (const w of this.waiters.splice(0)) w();
    })();
  }

  async waitFor<K extends ClaudeChatEvent['kind']>(
    kind: K,
    pred: (ev: Extract<ClaudeChatEvent, { kind: K }>) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<Extract<ClaudeChatEvent, { kind: K }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find((e): e is Extract<ClaudeChatEvent, { kind: K }> => e.kind === kind && pred(e as Extract<ClaudeChatEvent, { kind: K }>));
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Timed out waiting for ${kind}; saw ${this.events.map((e) => e.kind).join(', ')}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }

  of<K extends ClaudeChatEvent['kind']>(kind: K): Array<Extract<ClaudeChatEvent, { kind: K }>> {
    return this.events.filter((e): e is Extract<ClaudeChatEvent, { kind: K }> => e.kind === kind);
  }
}

describe.each<Kind>(['sdk', 'stream-json'])('Claude %s transport (fake claude)', (kind) => {
  let tmp: string;
  let argvFile: string;
  let transport: ClaudeTransport | null = null;
  let collector: Collector;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-claude-transport-'));
    argvFile = path.join(tmp, 'argv.json');
  });

  afterEach(async () => {
    await transport?.close();
    transport = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function start(extra: Partial<ClaudeTransportOptions> = {}): Promise<ClaudeTransport> {
    transport = makeTransport(kind, {
      binary: FAKE_CLAUDE,
      cwd: tmp,
      permissionMode: 'default',
      env: { FAKE_CLAUDE_ARGV_FILE: argvFile },
      ...extra,
    });
    collector = new Collector(transport);
    await transport.start();
    return transport;
  }

  const argv = (): string[] => JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  const hasFlag = (flag: string, value?: string): boolean => {
    const a = argv();
    if (value === undefined) return a.includes(flag);
    return a.some((x, i) => (x === flag && a[i + 1] === value) || x === `${flag}=${value}`);
  };

  it('completes the initialize handshake without sending a prompt', async () => {
    await start();
    const init = await collector.waitFor('initialized');
    expect(init.commands).toEqual([{ name: 'review', description: 'Review a PR', argumentHint: '<pr>' }]);
    expect(init.models.map((m) => m.value)).toEqual(['default', 'fake', 'haiku']);
    expect(init.models.map((m) => m.efforts)).toEqual([['low', 'medium', 'high'], ['low', 'medium', 'high'], []]);
    expect(collector.of('session_started')).toHaveLength(0);
    expect(hasFlag('--input-format', 'stream-json')).toBe(true);
    expect(hasFlag('--output-format', 'stream-json')).toBe(true);
    expect(hasFlag('--permission-prompt-tool', 'stdio')).toBe(true);
    expect(hasFlag('--permission-mode', 'default')).toBe(true);
    expect(hasFlag('--include-partial-messages')).toBe(true);
  });

  it('streams a turn: session start, partial chunks, final message, usage', async () => {
    const t = await start();
    t.send({ text: 'hello' });
    const ended = await collector.waitFor('turn_ended');
    const started = await collector.waitFor('session_started');
    expect(started).toMatchObject({ sessionId: 'fake-session-1', cliVersion: '2.1.300-fake', permissionMode: 'default', turnId: 1 });
    expect(collector.of('message_chunk').map((c) => [c.messageId, c.text])).toEqual([['msg_hello', 'Hel'], ['msg_hello', 'lo']]);
    expect(collector.of('message')).toMatchObject([{ messageId: 'msg_hello', text: 'Hello' }]);
    expect(ended).toMatchObject({
      subtype: 'success',
      isError: false,
      result: 'Hello',
      totalCostUsd: 0.0012,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 },
      sessionId: 'fake-session-1',
    });
    expect(t.sessionId).toBe('fake-session-1');
    const seqs = collector.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('numbers turns and keeps turn_ended on its own turn', async () => {
    const t = await start();
    t.send({ text: 'first' });
    await collector.waitFor('turn_ended', (e) => e.result?.startsWith('echo:first') ?? false);
    t.send({ text: 'second' });
    const second = await collector.waitFor('turn_ended', (e) => e.result?.startsWith('echo:second') ?? false);
    const first = collector.of('turn_ended')[0];
    expect(first.turnId).toBe(1);
    expect(second.turnId).toBe(2);
  });

  it('sends images as content blocks the CLI receives', async () => {
    const t = await start();
    t.send({ text: 'look', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }, { mediaType: 'image/jpeg', data: '/9j/4AAQ' }] });
    const ended = await collector.waitFor('turn_ended');
    expect(ended.result).toBe('echo:look|priority:none|shouldQuery:unset|images:2:image/png,image/jpeg');
  });

  it('surfaces can_use_tool with suggestions and applies "always allow"', async () => {
    const t = await start();
    t.send({ text: 'tool' });
    const req = await collector.waitFor('permission_request');
    expect(req).toMatchObject({
      toolName: 'Bash',
      input: { command: 'ls' },
      toolCallId: 'toolu_1',
      title: 'Claude wants to run ls',
      displayName: 'Run command',
    });
    expect(req.suggestions).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' },
    ]);
    const call = await collector.waitFor('tool_call');
    expect(call).toMatchObject({ toolCallId: 'toolu_1', name: 'Bash', input: { command: 'ls' } });

    t.respondToPermission(req.requestId, { behavior: 'allow', updatedPermissions: req.suggestions });
    const ended = await collector.waitFor('turn_ended');
    expect(ended.result).toBe(`allowed:{"command":"ls"}:${JSON.stringify(req.suggestions)}`);
    const update = await collector.waitFor('tool_call_update');
    expect(update).toMatchObject({ toolCallId: 'toolu_1', name: 'Bash', status: 'completed', content: 'file.txt', result: { stdout: 'file.txt', stderr: '' } });
  });

  it('denies a tool with a message', async () => {
    const t = await start();
    t.send({ text: 'tool' });
    const req = await collector.waitFor('permission_request');
    t.respondToPermission(req.requestId, { behavior: 'deny', message: 'not today' });
    const ended = await collector.waitFor('turn_ended');
    expect(ended.result).toBe('denied:not today');
    expect(await collector.waitFor('tool_call_update')).toMatchObject({ status: 'failed', content: 'not today' });
  });

  it('interrupt cancels a pending permission and ends the turn', async () => {
    const t = await start();
    t.send({ text: 'tool' });
    const req = await collector.waitFor('permission_request');
    await t.interrupt();
    await collector.waitFor('permission_cancelled', (e) => e.requestId === req.requestId);
    const ended = await collector.waitFor('turn_ended');
    expect(ended).toMatchObject({ subtype: 'error_during_execution', isError: true, errors: ['interrupted'] });
  });

  it('switches permission mode and model through control requests', async () => {
    const t = await start();
    await t.setPermissionMode('plan');
    expect(await collector.waitFor('mode_changed')).toMatchObject({ permissionMode: 'plan' });
    await t.setModel('haiku');
    expect(await t.appliedSettings()).toEqual({ model: 'claude-haiku-fake', effort: null });
    await t.setModel();
    await t.setEffort('high');
    expect(await t.appliedSettings()).toEqual({ model: 'claude-fake-1', effort: 'high' });
    t.send({ text: 'hello' });
    expect(await collector.waitFor('session_started')).toMatchObject({ model: 'claude-fake-1', permissionMode: 'plan' });
  });

  it('passes steer/queue priority and shouldQuery through to the CLI', async () => {
    const t = await start();
    t.send({ text: 'steer', priority: 'now' });
    await collector.waitFor('turn_ended', (e) => e.result === 'echo:steer|priority:now|shouldQuery:unset');
    t.send({ text: 'queued', priority: 'later', shouldQuery: false });
    await collector.waitFor('turn_ended', (e) => e.result === 'echo:queued|priority:later|shouldQuery:false');
  });

  it('maps rate_limit_event', async () => {
    const t = await start();
    t.send({ text: 'limit' });
    expect(await collector.waitFor('rate_limit')).toMatchObject({
      status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1760000000, utilization: 0.91,
    });
  });

  it('keeps unknown wire messages as unmapped events', async () => {
    const t = await start();
    t.send({ text: 'novel' });
    expect(await collector.waitFor('unmapped')).toMatchObject({ type: 'system', subtype: 'brand_new_thing' });
  });

  it('logs an unmapped message once by name, and its key shape (never values) at debug (#2109)', async () => {
    const log = vi.fn();
    const t = await start({ log });
    t.send({ text: 'novel' });
    await collector.waitFor('turn_ended');
    t.send({ text: 'novel' });
    await vi.waitFor(() => expect(log.mock.calls.filter((c) => c[0] === 'debug')).toHaveLength(2));
    const info = log.mock.calls.filter((c) => c[0] === 'info' && String(c[1]).includes('Unmapped Claude wire message'));
    expect(info).toHaveLength(1);
    const [, message, meta] = log.mock.calls.find((c) => c[0] === 'debug')!;
    expect(message).toContain('Unmapped Claude wire message shape');
    expect(meta).toMatchObject({ name: 'system/brand_new_thing', shape: { type: 'string', subtype: 'string', detail: 'number' } });
    expect(JSON.stringify(meta)).not.toContain('42');
  });

  it('resumes a native session by id with model, effort and MCP servers', async () => {
    const mcpServers = { clubhouse: { type: 'stdio', command: 'node', args: ['bridge.js'] } };
    const t = await start({ resume: 'resumed-session-9', model: 'opus', effort: 'high', mcpServers });
    expect(hasFlag('--resume', 'resumed-session-9')).toBe(true);
    expect(hasFlag('--model', 'opus')).toBe(true);
    expect(hasFlag('--effort', 'high')).toBe(true);
    expect(hasFlag('--mcp-config', JSON.stringify({ mcpServers }))).toBe(true);
    t.send({ text: 'hello' });
    expect(await collector.waitFor('session_started')).toMatchObject({ sessionId: 'resumed-session-9' });
  });

  it('close() ends the session and finishes the event stream', async () => {
    const t = await start();
    t.send({ text: 'hello' });
    await collector.waitFor('turn_ended');
    await t.close();
    await collector.done;
    const last = collector.events[collector.events.length - 1];
    expect(last.kind).toBe('session_ended');
    expect(() => t.send({ text: 'again' })).toThrow(/not running/);
  });

  it('keeps the final output of a CLI that exits right after writing it', async () => {
    const t = await start();
    t.send({ text: 'quit' });
    await collector.done;
    expect(collector.of('message').map((m) => m.text.length)).toEqual([512 * 1024]);
    expect(collector.of('turn_ended').map((e) => e.result)).toEqual(['bye']);
    const ended = collector.of('session_ended');
    expect(ended).toHaveLength(1);
    expect(collector.events[collector.events.length - 1].kind).toBe('session_ended');
    expect(ended[0].exitCode).toBe(0);
  });

  describe('startup cancellation (#2273)', () => {
    const pidFile = () => path.join(tmp, 'pid');
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };

    it('spawns nothing when the signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      transport = makeTransport(kind, { binary: FAKE_CLAUDE, cwd: tmp, permissionMode: 'default', env: { FAKE_CLAUDE_PID_FILE: pidFile() }, signal: ac.signal });
      await expect(transport.start()).rejects.toThrow('Chat start cancelled');
      await new Promise((r) => setTimeout(r, 300));
      expect(fs.existsSync(pidFile())).toBe(false);
    });

    it('kills a CLI that is still initializing and rejects at once', async () => {
      const ac = new AbortController();
      transport = makeTransport(kind, {
        binary: FAKE_CLAUDE, cwd: tmp, permissionMode: 'default', signal: ac.signal,
        env: { FAKE_CLAUDE_PID_FILE: pidFile(), FAKE_CLAUDE_HANG_INIT: '1' },
      });
      collector = new Collector(transport);
      const started = transport.start();
      started.catch((): undefined => undefined);
      await vi.waitFor(() => expect(fs.existsSync(pidFile()) && fs.readFileSync(pidFile(), 'utf8')).toBeTruthy(), { timeout: 3_000 });
      const pid = Number(fs.readFileSync(pidFile(), 'utf8'));
      ac.abort();
      await expect(started).rejects.toThrow('Chat start cancelled');
      // The fake ignores stdin EOF in this mode, so only the kill ends it.
      await collector.done;
      expect(collector.of('session_ended')).toHaveLength(1);
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3_000 });
    });

    it('starts normally with a live signal, and a later abort leaves it running', async () => {
      const ac = new AbortController();
      const t = await start({ signal: ac.signal });
      ac.abort();
      t.send({ text: 'hello' });
      expect((await collector.waitFor('turn_ended')).result).toBeTruthy();
    });
  });

  it('reports a CLI crash as session_ended', async () => {
    const t = await start();
    t.send({ text: 'crash' });
    await collector.done;
    const ended = collector.of('session_ended');
    expect(ended).toHaveLength(1);
    expect(ended[0].exitCode).toBe(3);
    if (kind === 'sdk') expect(collector.of('error').some((e) => e.fatal)).toBe(true);
  });
});
