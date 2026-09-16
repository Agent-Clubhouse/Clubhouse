import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(),
}));

vi.mock('./goobers-liveness', () => ({
  probeLiveness: vi.fn(),
}));

import { spawn } from 'child_process';
import { getShellEnvironment } from '../util/shell';
import { probeLiveness } from './goobers-liveness';
import { startDaemon, stopDaemon, _resetLifecycleStateForTests } from './goobers-daemon';
import type { GoobersDaemonStatus } from '../../shared/goobers-types';

function notRunning(): GoobersDaemonStatus {
  return { state: 'not-running', address: null, pid: null, version: null, startedAt: null, lastTickAgeMillis: null, draining: false };
}
function running(): GoobersDaemonStatus {
  return { state: 'running', address: '127.0.0.1:8080', pid: null, version: null, startedAt: null, lastTickAgeMillis: 0, draining: false };
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  unref: () => void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = vi.fn();
  return child;
}

beforeEach(() => {
  _resetLifecycleStateForTests();
  vi.mocked(spawn).mockReset();
  vi.mocked(getShellEnvironment).mockReset();
  vi.mocked(probeLiveness).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startDaemon', () => {
  it('spawns with execFile-style argv and getShellEnvironment() as env — never a shell string (§7.5 hard gate)', async () => {
    const child = makeFakeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(spawn).mockReturnValue(child as any);
    vi.mocked(getShellEnvironment).mockReturnValue({ PATH: '/usr/bin', FOO: 'bar' });
    vi.mocked(probeLiveness).mockResolvedValue({ daemon: running(), instance: null, health: null, degraded: false });

    const result = await startDaemon('/instance/root', '/usr/local/bin/goobers');

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(spawn).mock.calls[0];
    expect(call[0]).toBe('/usr/local/bin/goobers');
    expect(call[1]).toEqual(['up', '/instance/root']);
    expect(Array.isArray(call[1])).toBe(true);
    // never a shell string — argv entries carry no embedded whitespace
    expect((call[1] as string[]).every((a) => !a.includes(' '))).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options = call[2] as any;
    expect(options.env).toEqual({ PATH: '/usr/bin', FOO: 'bar' });
    expect(options.detached).toBe(true);
  });

  it('reports success once liveness confirms running (success-by-observation)', async () => {
    const child = makeFakeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(spawn).mockReturnValue(child as any);
    vi.mocked(getShellEnvironment).mockReturnValue({});
    let call = 0;
    vi.mocked(probeLiveness).mockImplementation(async () => {
      call += 1;
      return { daemon: call < 3 ? notRunning() : running(), instance: null, health: null, degraded: false };
    });

    const result = await startDaemon('/root', '/bin/goobers');
    expect(result.ok).toBe(true);
    expect(call).toBeGreaterThanOrEqual(3);
  });

  it('reports failure with captured stderr when the child exits before becoming ready', async () => {
    const child = makeFakeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(spawn).mockReturnValue(child as any);
    vi.mocked(getShellEnvironment).mockReturnValue({});
    vi.mocked(probeLiveness).mockResolvedValue({ daemon: notRunning(), instance: null, health: null, degraded: false });

    const promise = startDaemon('/root', '/bin/goobers');
    child.stderr.emit('data', Buffer.from('fatal: could not bind\n'));
    child.emit('exit', 1);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.outcome).toBeUndefined(); // a genuine failure, not §7.5's "unknown" (M17)
    expect(result.stderr).toContain('fatal: could not bind');
    expect(result.logPathHint).toContain('scheduler');
  });

  it('treats a lock-contention exit as success-adjacent and surfaces the holder kind', async () => {
    const child = makeFakeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(spawn).mockReturnValue(child as any);
    vi.mocked(getShellEnvironment).mockReturnValue({});
    vi.mocked(probeLiveness).mockResolvedValue({ daemon: notRunning(), instance: null, health: null, degraded: false });

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-daemon-lock-'));
    fs.mkdirSync(path.join(tmpRoot, 'scheduler'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'scheduler', 'up.lock'), JSON.stringify({ holderKind: 'manual' }));

    const promise = startDaemon(tmpRoot, '/bin/goobers');
    child.stderr.emit('data', Buffer.from('another `goobers up` already holds the lock on this instance root (…; holder pid 42)\n'));
    child.emit('exit', 1);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.holderKind).toBe('manual');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('defaults holder kind to daemon when up.lock is unreadable', async () => {
    const child = makeFakeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(spawn).mockReturnValue(child as any);
    vi.mocked(getShellEnvironment).mockReturnValue({});
    vi.mocked(probeLiveness).mockResolvedValue({ daemon: notRunning(), instance: null, health: null, degraded: false });

    const promise = startDaemon('/nonexistent/root', '/bin/goobers');
    child.stderr.emit('data', Buffer.from('another `goobers up` already holds the lock (holder pid 42)\n'));
    child.emit('exit', 1);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.holderKind).toBe('daemon');
  });

  it('times out after 60s with the child still alive ⇒ outcome "unknown", never a plain failure (§7.5, M17)', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(spawn).mockReturnValue(child as any);
    vi.mocked(getShellEnvironment).mockReturnValue({});
    vi.mocked(probeLiveness).mockResolvedValue({ daemon: notRunning(), instance: null, health: null, degraded: false });

    const promise = startDaemon('/root', '/bin/goobers');
    child.stderr.emit('data', Buffer.from('config error: bad api.listen\n'));

    await vi.advanceTimersByTimeAsync(61_000);
    const result = await promise;

    // The child never exited (still alive) — this must NOT be reported as a
    // plain start failure. A test that asserted `ok: false` with no further
    // distinction here is exactly the wrong-requirement-encoded-forever trap
    // called out in the M17 brief: it would pass on both the buggy and the
    // fixed implementation, so it isn't a substitute for asserting `outcome`.
    expect(result.outcome).toBe('unknown');
    expect(result.error).toMatch(/ready/i);
    expect(result.error).not.toMatch(/failed/i);
    expect(result.stderr).toContain('config error');
    expect(result.logPathHint).toContain('scheduler');
  });

  it('rejects a second start while one is already in flight (non-reentrant)', async () => {
    const child = makeFakeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(spawn).mockReturnValue(child as any);
    vi.mocked(getShellEnvironment).mockReturnValue({});
    vi.mocked(probeLiveness).mockResolvedValue({ daemon: notRunning(), instance: null, health: null, degraded: false });

    const first = startDaemon('/root', '/bin/goobers');
    const second = await startDaemon('/root', '/bin/goobers');
    expect(second).toEqual({ ok: false, error: 'lifecycle-busy' });

    child.emit('exit', 1);
    await first;
  });

  it('rejects a stop while a start is in flight', async () => {
    const child = makeFakeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(spawn).mockReturnValue(child as any);
    vi.mocked(getShellEnvironment).mockReturnValue({});
    vi.mocked(probeLiveness).mockResolvedValue({ daemon: notRunning(), instance: null, health: null, degraded: false });

    const startPromise = startDaemon('/root', '/bin/goobers');
    const stopResult = await stopDaemon('/root', '/bin/goobers');
    expect(stopResult).toEqual({ ok: false, error: 'lifecycle-busy' });

    child.emit('exit', 1);
    await startPromise;
  });

  it('caps the captured stderr buffer at 64KiB', async () => {
    const child = makeFakeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(spawn).mockReturnValue(child as any);
    vi.mocked(getShellEnvironment).mockReturnValue({});
    vi.mocked(probeLiveness).mockResolvedValue({ daemon: notRunning(), instance: null, health: null, degraded: false });

    const promise = startDaemon('/root', '/bin/goobers');
    const chunk = Buffer.alloc(40 * 1024, 'x');
    child.stderr.emit('data', chunk);
    child.stderr.emit('data', chunk);
    child.stderr.emit('data', chunk); // 120KiB total offered, well past the 64KiB cap
    child.emit('exit', 1);

    const result = await promise;
    expect(result.stderr!.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('stopDaemon', () => {
  it('exit 0 means the stop-request was accepted, not that the daemon has stopped', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return child as any;
    });
    vi.mocked(getShellEnvironment).mockReturnValue({});

    const result = await stopDaemon('/root', '/bin/goobers');
    expect(result).toEqual({ ok: true });
  });

  it('exit 1 means no daemon was holding the lock — already stopped', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 1));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return child as any;
    });
    vi.mocked(getShellEnvironment).mockReturnValue({});

    const result = await stopDaemon('/root', '/bin/goobers');
    expect(result).toEqual({ ok: true, alreadyStopped: true });
  });

  it('rejects a second stop while one is in flight', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      // never exits during this test
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return child as any;
    });
    vi.mocked(getShellEnvironment).mockReturnValue({});

    const firstPromise = stopDaemon('/root', '/bin/goobers');
    const second = await stopDaemon('/root', '/bin/goobers');
    expect(second).toEqual({ ok: false, error: 'lifecycle-busy' });

    child.emit('exit', 0);
    await firstPromise;
  });

  it('surfaces a non-zero, non-one exit code as a failure', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 2));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return child as any;
    });
    vi.mocked(getShellEnvironment).mockReturnValue({});

    const result = await stopDaemon('/root', '/bin/goobers');
    expect(result.ok).toBe(false);
  });
});
