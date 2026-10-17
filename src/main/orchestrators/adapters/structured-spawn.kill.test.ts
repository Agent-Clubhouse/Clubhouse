import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

import { execFile, spawn } from 'child_process';
import { killStructuredChild, TASKKILL_TIMEOUT_MS } from './structured-spawn';
import { CodexAppServerClient } from './codex-app-server-client';

const mockExecFile = vi.mocked(execFile);
const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

/** `pid: null` stands for a child whose spawn failed (Node leaves pid undefined). */
function fakeChild(pid: number | null = 4242) {
  return Object.assign(new EventEmitter(), {
    pid: pid ?? undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: { end: vi.fn() },
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(() => true),
  });
}
type FakeChild = ReturnType<typeof fakeChild>;
const asChild = (c: FakeChild) => c as unknown as Parameters<typeof killStructuredChild>[0];

/** Make the next taskkill call finish with `err`. */
function taskkillFinishes(err: Error | null): void {
  mockExecFile.mockImplementationOnce(((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
    cb(err);
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

beforeEach(() => {
  mockExecFile.mockReset();
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe('killStructuredChild', () => {
  it('on POSIX ends stdin and sends SIGTERM to the child', async () => {
    setPlatform('darwin');
    const child = fakeChild();

    await killStructuredChild(asChild(child));

    expect(child.stdin.end).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('on Windows ends stdin, then kills the whole tree with taskkill /T /F', async () => {
    setPlatform('win32');
    const child = fakeChild(4242);
    taskkillFinishes(null);

    await killStructuredChild(asChild(child));

    expect(child.stdin.end).toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4242', '/T', '/F'],
      { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
      expect.any(Function),
    );
    expect(child.stdin.end.mock.invocationCallOrder[0]).toBeLessThan(mockExecFile.mock.invocationCallOrder[0]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('on Windows falls back to killing the child when taskkill fails', async () => {
    setPlatform('win32');
    const child = fakeChild();
    taskkillFinishes(new Error('taskkill timed out'));

    await killStructuredChild(asChild(child));

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('on Windows falls back when taskkill cannot be started at all', async () => {
    setPlatform('win32');
    const child = fakeChild();
    mockExecFile.mockImplementationOnce(() => { throw new Error('spawn taskkill ENOENT'); });

    await killStructuredChild(asChild(child));

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('on Windows skips the fallback when the child exited while taskkill ran', async () => {
    setPlatform('win32');
    const child = fakeChild();
    mockExecFile.mockImplementationOnce(((_f: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => {
      child.exitCode = 1;
      cb(new Error('process not found'));
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    await killStructuredChild(asChild(child));

    expect(child.kill).not.toHaveBeenCalled();
  });

  it('only ends stdin for a child that already exited', async () => {
    setPlatform('win32');
    const child = fakeChild();
    child.exitCode = 0;

    await killStructuredChild(asChild(child));

    expect(child.stdin.end).toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('kills directly on Windows when the child has no pid (spawn failed)', async () => {
    setPlatform('win32');
    const child = fakeChild(null);

    await killStructuredChild(asChild(child));

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('tolerates a stdin that throws on end', async () => {
    setPlatform('darwin');
    const child = fakeChild();
    child.stdin.end.mockImplementation(() => { throw new Error('write after end'); });

    await killStructuredChild(asChild(child));

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('NdjsonRpcBase.kill (via CodexAppServerClient)', () => {
  it('kills the tree on Windows instead of only the cmd.exe wrapper', () => {
    setPlatform('win32');
    const child = fakeChild(5150);
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    taskkillFinishes(null);
    const client = new CodexAppServerClient({ binary: 'codex.cmd', args: ['app-server'] });
    void client.start().catch(() => undefined);

    client.kill();

    expect(child.stdin.end).toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledWith('taskkill', ['/PID', '5150', '/T', '/F'], expect.anything(), expect.any(Function));
    expect(client.alive).toBe(false);
  });
});
