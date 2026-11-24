import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Deterministic controls for the stdio connector's own guard and stdin error
// handling, on every platform, with a stubbed child instead of a real one.
// They don't replace a real-process check of an agent that stops reading.

const spawned: FakeChild[] = [];
/** Runs on each new child before spawn() returns, so it sees the first write. */
let onSpawn: ((child: FakeChild) => void) | undefined;
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: vi.fn(() => {
    const child = new FakeChild();
    spawned.push(child);
    onSpawn?.(child);
    return child;
  }),
}));

import type { ChatDriverId } from '../../../shared/chat/capabilities';
import type { ChatEventDraft } from '../../../shared/chat/events';
import type { AcpTransportEnd, JsonRpcMessage } from './connection';
import { createAcpChatDriver } from './driver';
import { stdioConnector } from './stdio';

class FakeStream extends EventEmitter {
  setEncoding(): this { return this; }
}

class FakeStdin extends EventEmitter {
  writable = true;
  readonly writes: JsonRpcMessage[] = [];
  write(line: string): boolean {
    this.writes.push(JSON.parse(line) as JsonRpcMessage);
    this.emit('wrote', this.writes[this.writes.length - 1]);
    return true;
  }
  end(): void { this.writable = false; }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid: number | undefined = undefined;
  readonly kill = vi.fn((signal?: string) => {
    this.signalCode = signal ?? 'SIGTERM';
    queueMicrotask(() => this.emit('close', null, this.signalCode));
    return true;
  });
  /** The agent writes a JSON-RPC line on stdout. */
  say(message: object): void {
    this.stdout.emit('data', `${JSON.stringify(message)}\n`);
  }
  /** Writing to stdin fails afterwards, as when the agent stops reading (EPIPE). */
  breakStdin(): void {
    this.stdin.writable = false;
    this.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  }
}

const COMMAND = { binary: 'acp-agent', args: [] as string[] };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function connect() {
  const ends: AcpTransportEnd[] = [];
  const transport = stdioConnector({ command: COMMAND })({ onMessage: () => undefined, onEnd: (end) => { ends.push(end); } });
  return { transport, ends, child: spawned[spawned.length - 1] };
}

beforeEach(() => { spawned.length = 0; onSpawn = undefined; });

describe('stdio connector guard (deterministic)', () => {
  it('refuses a message while stdin is not writable, before the transport has ended, and writes nothing', () => {
    const { transport, ends, child } = connect();
    child.stdin.writable = false;
    expect(() => transport.send({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} })).toThrow(/not accepting input/);
    expect(child.stdin.writes).toEqual([]);
    expect(ends).toEqual([]);
  });

  it('refuses a message after the transport has ended, and writes nothing', () => {
    const { transport, ends, child } = connect();
    child.exitCode = 0;
    child.emit('close', 0, null);
    expect(ends).toHaveLength(1);
    expect(() => transport.send({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} })).toThrow(/not accepting input/);
    expect(child.stdin.writes).toEqual([]);
  });

  it('ends once on a stdin error, and ignores a later error or close', async () => {
    const { ends, child } = connect();
    child.breakStdin();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ code: null, signal: null, error: expect.objectContaining({ code: 'EPIPE' }) });
    expect(ends[0].spawn).toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await tick();
    child.emit('close', 1, null);
    expect(ends).toHaveLength(1);
  });

  it('ignores a stdin error after the agent has exited', () => {
    const { ends, child } = connect();
    child.exitCode = 0;
    child.emit('close', 0, null);
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ code: 0 });
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('stdio connector through the driver (deterministic)', () => {
  const driver = createAcpChatDriver({ id: 'acp_neutral_test' as ChatDriverId, provider: 'acp-test', args: () => [] });

  /** A started session whose fake agent answers initialize and session/new. */
  async function started() {
    // start() writes initialize before it returns, so the agent answers from spawn on.
    onSpawn = (child) => child.stdin.on('wrote', (msg: JsonRpcMessage) => {
      if (msg.method === 'initialize') child.say({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      if (msg.method === 'session/new') child.say({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
    });
    const session = await driver.start({ agentId: 'a', provider: 'acp-test', cwd: 'workspace', binaryPath: 'acp-agent', level: 'ask' });
    const child = spawned[spawned.length - 1];
    const drafts: ChatEventDraft[] = [];
    const ended = (async () => { for await (const d of session.events) drafts.push(d); })();
    return { child, session, drafts, ended, prompts: () => child.stdin.writes.filter((m) => m.method === 'session/prompt') };
  }

  it('refuses a send while stdin is not writable: no write, no turn, no transport end', async () => {
    const { child, session, drafts, prompts } = await started();
    child.stdin.writable = false;
    await expect(session.send([{ type: 'text', text: 'x' }], 'prompt')).rejects.toThrow(/not accepting input/);
    await tick();
    expect(prompts()).toEqual([]);
    expect(drafts.map((d) => d.type)).toEqual(['session_info']);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('after a written prompt, a stdin error ends the session: turn unknown, nothing resent, later send refused', async () => {
    const { child, session, drafts, ended, prompts } = await started();
    await session.send([{ type: 'text', text: 'x' }], 'prompt');
    expect(prompts()).toHaveLength(1);
    child.breakStdin();
    await ended;
    expect(drafts.map((d) => d.type)).toEqual(['session_info', 'turn_started', 'error']);
    expect(drafts[2].data).toMatchObject({ code: 'process_exited', fatal: true, message: expect.stringMatching(/EPIPE.*unknown/) });
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(session.send([{ type: 'text', text: 'again' }], 'prompt')).rejects.toThrow(/not open/);
    expect(prompts()).toHaveLength(1);
  });
});
