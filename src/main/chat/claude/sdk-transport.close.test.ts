/**
 * ClaudeSdkTransport.close(): when the CLI doesn't exit within the grace
 * period after stdin ends, close() must kill the CLI's process tree. The SDK's
 * own close kills just its direct child, and with a claude.cmd shim on Windows
 * that child is cmd.exe, which would leave the real CLI and its MCP servers running.
 */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/log-service', () => ({ appLog: vi.fn() }));
const h = vi.hoisted(() => ({ execFile: vi.fn(), child: null as unknown }));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: h.execFile };
});
vi.mock('./spawn', () => ({
  buildClaudeEnv: (e?: Record<string, string>) => ({ ...e }),
  spawnClaude: () => h.child,
}));

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkTransport } from './sdk-transport';
import type { ClaudeTransportOptions } from './transport';

const originalPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p });

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(child, {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn(), write: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return child;
}

/** A fake SDK query that spawns through the hook, like the real one, and whose stream ends on close(). */
function fakeSdk() {
  let finish!: () => void;
  const ended = new Promise<void>((r) => { finish = r; });
  const q = {
    [Symbol.asyncIterator]: () => ({ next: () => ended.then(() => ({ done: true as const, value: undefined })) }),
    initializationResult: vi.fn(async () => ({ commands: [], models: [], claude_code_version: '2.1.300-fake' })),
    // Like the SDK on win32: the stream ends, but only the direct child gets a (delayed) kill.
    close: vi.fn(() => finish()),
  };
  const loader = async () => ({
    query: ((a: { options: { spawnClaudeCodeProcess: (so: unknown) => unknown } }) => {
      a.options.spawnClaudeCodeProcess({ command: 'C:\\npm\\claude.cmd', args: [], env: {}, signal: new AbortController().signal });
      return q;
    }) as unknown as (a: unknown) => Query,
  });
  return { q, loader };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  h.execFile.mockReset();
  h.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => cb(null));
  h.child = fakeChild();
});
afterEach(() => {
  vi.useRealTimers();
  setPlatform(originalPlatform);
});

describe('ClaudeSdkTransport.close on Windows', () => {
  it('kills the CLI process tree (taskkill /T) when the CLI ignores stdin EOF', async () => {
    setPlatform('win32');
    const { q, loader } = fakeSdk();
    const opts: ClaudeTransportOptions = { binary: 'C:\\npm\\claude.cmd', cwd: 'C:\\repo', permissionMode: 'default' };
    const transport = new ClaudeSdkTransport(opts, loader);
    await transport.start();

    const closed = transport.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await closed;

    expect(q.close).toHaveBeenCalled(); // the grace period ran out
    expect(h.execFile).toHaveBeenCalledWith('taskkill', ['/PID', '4242', '/T', '/F'], expect.anything(), expect.any(Function));
  });
});
