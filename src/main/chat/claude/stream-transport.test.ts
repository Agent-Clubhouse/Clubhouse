/**
 * Process-lifecycle edge cases for the stream-json transport, driven by a
 * scripted child process so event order is deterministic.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeChatEvent } from './events';
import { ClaudeStreamTransport } from './stream-transport';
import { ClaudeTransportBase } from './transport';

vi.mock('../../util/shell', async (importActual) => {
  const actual = await importActual<typeof import('../../util/shell')>();
  return { ...actual, getShellEnvironment: () => ({ ...process.env }) as Record<string, string> };
});

class ScriptedChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly written: Array<Record<string, unknown>> = [];

  constructor() {
    super();
    let buf = '';
    this.stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        this.written.push(msg);
        this.emit('host-message', msg);
      }
    });
  }

  line(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + '\n');
  }

  kill(): boolean {
    return true;
  }
}

async function startWith(child: ScriptedChild): Promise<{ transport: ClaudeStreamTransport; events: ClaudeChatEvent[]; done: Promise<void> }> {
  child.on('host-message', (msg: { type: string; request_id: string; request: { subtype: string } }) => {
    if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
      child.line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [] } } });
    }
  });
  const transport = new ClaudeStreamTransport(
    { binary: 'claude', cwd: '.', permissionMode: 'default' },
    () => child as unknown as ChildProcess,
  );
  const events: ClaudeChatEvent[] = [];
  const done = (async () => { for await (const e of transport.events) events.push(e); })();
  await transport.start();
  return { transport, events, done };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('ClaudeStreamTransport process lifecycle', () => {
  it("keeps stdout that arrives after 'exit' and ends on 'close'", async () => {
    const child = new ScriptedChild();
    const { events, done } = await startWith(child);

    child.exitCode = 0;
    child.emit('exit', 0, null);
    await tick();
    child.line({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'last words' }] } });
    // The final line has no trailing newline.
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'bye' }));
    await tick();
    child.stdout.end();
    child.emit('close', 0, null);
    await done;

    expect(events.map((e) => e.kind)).toEqual(['initialized', 'message', 'turn_ended', 'session_ended']);
    expect(events[3]).toMatchObject({ kind: 'session_ended', exitCode: 0, signal: null });
  });

  it('does not answer a permission request the CLI cancelled', async () => {
    const child = new ScriptedChild();
    const { transport, events } = await startWith(child);

    child.line({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    await tick();
    child.line({ type: 'control_cancel_request', request_id: 'perm-1' });
    await tick();
    expect(events.map((e) => e.kind)).toEqual(['initialized', 'permission_request', 'permission_cancelled']);
    // A late answer from the user is ignored too.
    transport.respondToPermission('perm-1', { behavior: 'allow' });
    await tick();
    expect(child.written.filter((m) => m.type === 'control_response')).toEqual([]);
  });
});

/** Exposes the shared permission plumbing. */
class PermissionProbe extends ClaudeTransportBase {
  readonly kind = 'sdk' as const;
  async start(): Promise<void> {}
  send(): void {}
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async close(): Promise<void> {}
  ask(signal?: AbortSignal) {
    return this.awaitPermission({ kind: 'permission_request', requestId: 'r1', toolName: 'Bash', input: {}, suggestions: [] }, signal);
  }
  finish(): void {
    this.end(0, null);
  }
}

describe('ClaudeTransportBase permissions', () => {
  it('cancels a request whose signal was aborted before it arrived, without surfacing it', async () => {
    const t = new PermissionProbe({ binary: 'claude', cwd: '.', permissionMode: 'default' });
    const events: string[] = [];
    const done = (async () => { for await (const e of t.events) events.push(e.kind); })();
    const controller = new AbortController();
    controller.abort();
    await expect(t.ask(controller.signal)).resolves.toBeNull();
    t.finish();
    await done;
    expect(events).toEqual(['session_ended']);
  });

  it('resolves null when the request is aborted while pending', async () => {
    const t = new PermissionProbe({ binary: 'claude', cwd: '.', permissionMode: 'default' });
    const controller = new AbortController();
    const answer = t.ask(controller.signal);
    controller.abort();
    await expect(answer).resolves.toBeNull();
  });
});
