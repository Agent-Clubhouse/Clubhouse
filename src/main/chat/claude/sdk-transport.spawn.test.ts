import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import { sdkSpawnHook } from './sdk-transport';

// The Agent SDK owns the spawned claude's stdin. These run a real node child
// standing in for claude, through the same hook the SDK calls.

const CHILD = ['-e', 'process.stdin.resume(); process.stderr.write("hello"); setInterval(() => {}, 1000);'];

let child: ChildProcess | undefined;

afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = undefined;
});

function start(log = vi.fn()) {
  const controller = new AbortController();
  child = sdkSpawnHook(
    { command: process.execPath, args: CHILD, env: { ...process.env }, signal: controller.signal },
    undefined,
    log,
  );
  const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
  return { child, controller, exited, log };
}

describe('sdkSpawnHook', () => {
  it('abort kills the process without ending the stdin the SDK owns', async () => {
    const { child, controller, exited } = start();

    controller.abort();

    expect(child.stdin?.writableEnded).toBe(false);
    await exited;
    expect(child.signalCode ?? child.exitCode).not.toBeNull();
  });

  it('logs a stdin error instead of throwing it', () => {
    const { child, log } = start();

    // Without a listener, an 'error' event on a stream throws synchronously,
    // which in main would be an uncaught exception.
    expect(() => child.stdin?.emit('error', new Error('write after end'))).not.toThrow();
    expect(log).toHaveBeenCalledWith('warn', 'claude stdin error', { error: 'write after end' });
  });

  it('a late SDK write after the process is gone does not crash', async () => {
    const { child, controller, exited } = start();
    controller.abort();
    await exited;

    await new Promise<void>((resolve) => {
      child.stdin?.write('{"type":"control_request"}\n', () => resolve());
    });
    // Give an EPIPE a turn to surface; the listener must absorb it.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('logs stderr', async () => {
    const { log } = start();

    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('warn', 'claude stderr', { data: 'hello' }));
  });
});
