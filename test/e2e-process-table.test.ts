import { EventEmitter } from 'node:events';
import type { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProcessTableReader, PROCESS_TABLE_DEADLINE_MS, type ProcessTableResult } from '../e2e/cleanup-process-table';
import { ELECTRON_DIST_DIR, recordElectronApp, sweepE2EProcesses } from '../e2e/e2e-cleanup';

class QueryChild extends EventEmitter {
  kill = vi.fn(() => true);
  stdin = { destroy: vi.fn() };
  stdout = { destroy: vi.fn() };
  stderr = { destroy: vi.fn() };
  unref = vi.fn();
}
type Reply = (error: Error | null, output: string) => void;
type Lifecycle = Readonly<{
  spawnObserved: boolean; spawnAtMs?: number;
  exitEventObserved: boolean; exitEventAtMs?: number;
  callbackObserved: boolean; callbackAtMs?: number;
  closeObserved: boolean; closeAtMs?: number;
  deadlineObserved: boolean; deadlineAtMs?: number;
  cleanupRequested: boolean;
}>;
type LifecycleObserver = (phase: 'deadline' | 'close-after-deadline', snapshot: Lifecycle) => void;
function fixture(platform: NodeJS.Platform = 'win32', observe?: LifecycleObserver) {
  const children: QueryChild[] = [], replies: Reply[] = [];
  const execute = vi.fn((_file: string, _args: string[], _options: unknown, callback: Reply) => {
    const child = new QueryChild(); children.push(child); replies.push(callback); return child;
  });
  const read = createProcessTableReader({ platform, execute: execute as unknown as typeof execFile, observe });
  return { read, execute, children, replies };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('query lifecycle diagnostics', () => {
  it('freezes deadline evidence separately from late callback, exit and close receipts', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(500);
    const observe = vi.fn<LifecycleObserver>();
    const { read, children, replies, execute } = fixture('win32', observe);
    const pending = read();
    clock.mockReturnValue(507); children[0].emit('spawn');
    clock.mockReturnValue(10_500); await vi.advanceTimersByTimeAsync(PROCESS_TABLE_DEADLINE_MS);
    const result = await pending;
    const deadline = {
      spawnObserved: true, spawnAtMs: 7, exitEventObserved: false, callbackObserved: false,
      closeObserved: false, deadlineObserved: true, deadlineAtMs: 10_000, cleanupRequested: true,
    };
    expect(result).toEqual({ ok: false, reason: 'timeout', elapsedMs: 10_000,
      cleanupRequested: true, exitObserved: false, lifecycle: deadline });
    expect(observe).toHaveBeenCalledExactlyOnceWith('deadline', deadline);
    expect(Object.isFrozen(observe.mock.calls[0][1])).toBe(true);
    expect(children[0].kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    for (const handle of [children[0].stdin, children[0].stdout, children[0].stderr]) expect(handle.destroy).toHaveBeenCalledOnce();
    expect(children[0].unref).toHaveBeenCalledOnce();

    clock.mockReturnValue(10_501);
    replies[0](null, '[{"ProcessId":123,"ParentProcessId":1,"CommandLine":"PRIVATE LATE TABLE"}]');
    expect(await read()).toMatchObject({ ok: false, reason: 'unreconciled', exitObserved: false });
    clock.mockReturnValue(10_504); children[0].emit('exit', 0, null);
    expect(await read()).toMatchObject({ ok: false, reason: 'unreconciled' });
    expect(execute).toHaveBeenCalledOnce(); expect(observe).toHaveBeenCalledOnce();
    clock.mockReturnValue(10_507); children[0].emit('close', 0, null);
    const closed = { ...deadline, callbackObserved: true, callbackAtMs: 10_001,
      exitEventObserved: true, exitEventAtMs: 10_004, closeObserved: true, closeAtMs: 10_007 };
    expect(observe).toHaveBeenNthCalledWith(2, 'close-after-deadline', closed);
    expect(Object.isFrozen(observe.mock.calls[1][1])).toBe(true);
    expect(observe.mock.calls[0][1]).toEqual(deadline);
    expect(result).toMatchObject({ reason: 'timeout', exitObserved: false, lifecycle: deadline });
    children[0].emit('close'); expect(observe).toHaveBeenCalledTimes(2);
    const next = read(); expect(execute).toHaveBeenCalledTimes(2);
    children[1].emit('close'); replies[1](null, '[]'); expect(await next).toMatchObject({ ok: true, processes: [] });
    expect(JSON.stringify(observe.mock.calls)).not.toContain('PRIVATE');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes exit without close and keeps the query reservation through its deadline', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const observe = vi.fn<LifecycleObserver>();
    const { read, children, replies, execute } = fixture('win32', observe); const pending = read();
    clock.mockReturnValue(3); children[0].emit('spawn');
    clock.mockReturnValue(8); children[0].emit('exit', 0, null);
    expect(await read()).toMatchObject({ ok: false, reason: 'unreconciled', exitObserved: false });
    clock.mockReturnValue(10_000); await vi.advanceTimersByTimeAsync(PROCESS_TABLE_DEADLINE_MS);
    expect(await pending).toMatchObject({ reason: 'timeout', exitObserved: false,
      lifecycle: { exitEventObserved: true, exitEventAtMs: 8, closeObserved: false, callbackObserved: false } });
    expect(await read()).toMatchObject({ reason: 'unreconciled' }); expect(execute).toHaveBeenCalledOnce();
    clock.mockReturnValue(10_003); children[0].emit('close', 0, null);
    expect(observe).toHaveBeenLastCalledWith('close-after-deadline', expect.objectContaining({ closeObserved: true, closeAtMs: 10_003 }));
    const next = read(); children[1].emit('close'); replies[1](null, '[]'); expect(execute).toHaveBeenCalledTimes(2);
    expect(await next).toMatchObject({ ok: true }); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'error'] as const)('does not turn a %s callback or exit event into close evidence', async (mode) => {
    const observe = vi.fn<LifecycleObserver>();
    const { read, children, replies, execute } = fixture('win32', observe); const pending = read();
    replies[0](mode === 'error' ? new Error('PRIVATE callback error') : null, '[]');
    expect(await pending).toMatchObject(mode === 'error'
      ? { ok: false, reason: 'error', exitObserved: false, lifecycle: { callbackObserved: true, closeObserved: false } }
      : { ok: true, processes: [] });
    children[0].emit('exit', 0, null);
    expect(await read()).toMatchObject({ reason: 'unreconciled', exitObserved: false }); expect(execute).toHaveBeenCalledOnce();
    children[0].emit('close'); expect(observe).not.toHaveBeenCalled();
    const next = read(); children[1].emit('close'); replies[1](null, '[]'); expect(await next).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['deadline', 'close-after-deadline'] as const)('isolates an observer throwing at %s from query cleanup and ownership', async (phase) => {
    const observe = vi.fn<LifecycleObserver>((event) => { if (event === phase) throw new Error('PRIVATE observer error'); });
    const { read, children, replies, execute } = fixture('win32', observe); const pending = read();
    await expect(vi.advanceTimersByTimeAsync(PROCESS_TABLE_DEADLINE_MS)).resolves.toBeDefined();
    const result = await pending; expect(result).toMatchObject({ reason: 'timeout', exitObserved: false });
    expect(children[0].kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    for (const handle of [children[0].stdin, children[0].stdout, children[0].stderr]) expect(handle.destroy).toHaveBeenCalledOnce();
    expect(children[0].unref).toHaveBeenCalledOnce();
    expect(await read()).toMatchObject({ reason: 'unreconciled' }); expect(execute).toHaveBeenCalledOnce();
    expect(() => children[0].emit('close')).not.toThrow(); expect(observe).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ reason: 'timeout', exitObserved: false, lifecycle: { closeObserved: false } });
    const next = read(); children[1].emit('close'); replies[1](null, '[]'); expect(await next).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates a throwing default close receipt sink without claiming the deadline observed close', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE sink error'); });
    const { read, children, replies } = fixture(); const pending = read();
    await vi.advanceTimersByTimeAsync(PROCESS_TABLE_DEADLINE_MS); const result = await pending;
    expect(warning).not.toHaveBeenCalled();
    expect(() => children[0].emit('close')).not.toThrow();
    expect(warning).toHaveBeenCalledExactlyOnceWith('[e2e cleanup] query closed after deadline', expect.objectContaining({ closeObserved: true }));
    expect(result).toMatchObject({ reason: 'timeout', exitObserved: false, lifecycle: { closeObserved: false } });
    const next = read(); children[1].emit('close'); replies[1](null, '[]'); expect(await next).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards frozen deadline metadata without target signals or changes to retained state and temp files', async () => {
    const oldCi = process.env.CI; delete process.env.CI;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-lifecycle-fixture-'));
    const paths = { stateDir: path.join(root, 'state'), tmpDir: path.join(root, 'tmp') };
    const retained = path.join(paths.tmpDir, 'clubhouse-e2e-retained'); fs.mkdirSync(retained, { recursive: true });
    fs.writeFileSync(path.join(retained, 'marker'), 'PRIVATE retained content');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { read, children } = fixture('win32', vi.fn<LifecycleObserver>());
    try {
      recordElectronApp(12345, retained, paths);
      const stateFile = path.join(paths.stateDir, 'electron-pids.jsonl'); const before = fs.readFileSync(stateFile);
      const pending = sweepE2EProcesses(paths, read);
      await vi.advanceTimersByTimeAsync(PROCESS_TABLE_DEADLINE_MS);
      expect(await pending).toEqual({ killed: 0, tempDirsRemoved: 0, processTable: 'timeout' });
      expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
      expect(fs.readFileSync(stateFile)).toEqual(before); expect(fs.readFileSync(path.join(retained, 'marker'), 'utf8')).toBe('PRIVATE retained content');
      expect(warning).toHaveBeenCalledExactlyOnceWith('[e2e cleanup] process table unavailable; sweep/state retained', {
        reason: 'timeout', elapsedMs: expect.any(Number), cleanupRequested: true, exitObserved: false,
        lifecycle: expect.objectContaining({ deadlineObserved: true, spawnObserved: false, closeObserved: false, callbackObserved: false }),
      });
      expect(Object.isFrozen(warning.mock.calls[0][1].lifecycle)).toBe(true);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE');
    } finally {
      children[0]?.emit('close'); fs.rmSync(root, { recursive: true, force: true });
      if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
    }
  });
});

it('bounds a never replying query, distinguishes requested/observed cleanup and fences replacements until actual close', async () => {
  const { read, children, replies, execute } = fixture();
  const pending = read(); let done = false; void pending.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(PROCESS_TABLE_DEADLINE_MS - 1); expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const result = await pending;
  expect(result).toMatchObject({ ok: false, reason: 'timeout', cleanupRequested: true, exitObserved: false });
  expect(children[0].kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(children[0].stdin.destroy).toHaveBeenCalledOnce(); expect(children[0].stdout.destroy).toHaveBeenCalledOnce(); expect(children[0].unref).toHaveBeenCalledOnce();
  expect(await read()).toMatchObject({ ok: false, reason: 'unreconciled', cleanupRequested: true, exitObserved: false });
  replies[0](null, JSON.stringify([{ ProcessId: 123, ParentProcessId: 1, CommandLine: 'synthetic late table' }]));
  expect(await read()).toMatchObject({ ok: false, reason: 'unreconciled' }); expect(execute).toHaveBeenCalledOnce();
  children[0].emit('close'); // Callback, signal dispatch and timeout alone did not release ownership.
  const next = read(); expect(execute).toHaveBeenCalledTimes(2);
  children[1].emit('close'); replies[1](null, '[]'); expect(await next).toMatchObject({ ok: true, processes: [] });
  expect(result).toMatchObject({ ok: false, reason: 'timeout', exitObserved: false });
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['false', 'throw'] as const)('retains ownership when query cleanup returns %s', async (mode) => {
  const { read, children, execute } = fixture(); const pending = read();
  children[0].kill.mockImplementation(() => { if (mode === 'throw') throw new Error('synthetic private message'); return false; });
  children[0].stdin.destroy.mockImplementation(() => { throw new Error('synthetic stream failure'); });
  await vi.advanceTimersByTimeAsync(PROCESS_TABLE_DEADLINE_MS);
  expect(await pending).toMatchObject({ ok: false, reason: 'timeout', cleanupRequested: false, exitObserved: false });
  expect(await read()).toMatchObject({ ok: false, reason: 'unreconciled', cleanupRequested: false }); expect(execute).toHaveBeenCalledOnce();
  for (const handle of [children[0].stdin, children[0].stdout, children[0].stderr]) expect(handle.destroy).toHaveBeenCalledOnce();
  expect(children[0].unref).toHaveBeenCalledOnce();
  children[0].emit('close'); expect(vi.getTimerCount()).toBe(0);
});
it('does not let errors from optional stream/unref cleanup escape the deadline callback', async () => {
  const { read, children } = fixture(); const pending = read();
  children[0].stdin.destroy.mockImplementation(() => { throw new Error('synthetic'); });
  children[0].stdout.destroy.mockImplementation(() => { throw new Error('synthetic'); });
  children[0].stderr.destroy.mockImplementation(() => { throw new Error('synthetic'); });
  children[0].unref.mockImplementation(() => { throw new Error('synthetic'); });
  await expect(vi.advanceTimersByTimeAsync(PROCESS_TABLE_DEADLINE_MS)).resolves.toBeDefined();
  expect(await pending).toMatchObject({ ok: false, reason: 'timeout' }); children[0].emit('close');
});
it('uses existing PowerShell fields without shell/input expansion and validates a complete snapshot', async () => {
  const { read, children, replies, execute } = fixture(); const pending = read();
  children[0].emit('close'); replies[0](null, '[{"ProcessId":123,"ParentProcessId":1,"CommandLine":"synthetic"}]');
  expect(await pending).toMatchObject({ ok: true, processes: [{ pid: 123, ppid: 1, command: 'synthetic' }] });
  expect(execute.mock.calls[0].slice(0, 3)).toEqual(['powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }]);
  expect(children[0].kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it.each(['not json', 'null', '[{"ProcessId":"123","ParentProcessId":1,"CommandLine":"synthetic"}]'])('refuses invalid process table rather than treating it as empty', async (output) => {
  const { read, replies, children } = fixture(); const pending = read();
  children[0].emit('close'); replies[0](null, output);
  expect(await pending).toMatchObject({ ok: false, reason: 'invalid' }); expect(vi.getTimerCount()).toBe(0);
});
it('does not promote query callback error to exit observation, and handles synchronous creation failure', async () => {
  const { read, replies, children, execute } = fixture(); const pending = read();
  replies[0](new Error('synthetic'), ''); expect(await pending).toMatchObject({ ok: false, reason: 'error', exitObserved: false });
  expect(await read()).toMatchObject({ ok: false, reason: 'unreconciled' }); children[0].emit('close');
  execute.mockImplementationOnce(() => { throw new Error('synthetic'); });
  expect(await read()).toMatchObject({ ok: false, reason: 'error' });
  const next = read(); children[1].emit('close'); replies[1](null, '[]'); expect(await next).toMatchObject({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
});
it('keeps POSIX process parsing and rejects malformed rows', async () => {
  const { read, replies, children } = fixture('linux'); const pending = read();
  children[0].emit('close'); replies[0](null, ' 123 1 /synthetic/program --fixture\n');
  expect(await pending).toMatchObject({ ok: true, processes: [{ pid: 123, ppid: 1, command: '/synthetic/program --fixture' }] });
});

it.each(['timeout', 'error', 'invalid', 'unreconciled'] as const)('unknown %s snapshot permits no kill/delete and preserves retry state', async (reason) => {
  vi.useRealTimers();
  const oldCi = process.env.CI; delete process.env.CI;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-snapshot-fixture-'));
  const paths = { stateDir: path.join(root, 'state'), tmpDir: path.join(root, 'tmp') };
  const retained = path.join(paths.tmpDir, 'clubhouse-e2e-synthetic'); fs.mkdirSync(retained, { recursive: true }); fs.writeFileSync(path.join(retained, 'marker'), 'synthetic');
  // A synthetic live PID: no actual process is inspected or signalled.
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    recordElectronApp(12345, retained, paths);
    const stateFile = path.join(paths.stateDir, 'electron-pids.jsonl'); const before = await fs.promises.readFile(stateFile);
    const query = vi.fn(async (): Promise<ProcessTableResult> => ({ ok: false, reason, elapsedMs: 10_000, cleanupRequested: true, exitObserved: false }));
    expect(await sweepE2EProcesses(paths, query)).toEqual({ killed: 0, tempDirsRemoved: 0, processTable: reason });
    expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
    expect(await fs.promises.readFile(stateFile)).toEqual(before); expect(await fs.promises.readFile(path.join(retained, 'marker'), 'utf8')).toBe('synthetic');
    expect(warning).toHaveBeenCalledWith('[e2e cleanup] process table unavailable; sweep/state retained', { reason, elapsedMs: 10_000, cleanupRequested: true, exitObserved: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
  }
});

it('records actual close during cleanup separately from request and ignores its late callback', async () => {
  const { read, children, replies } = fixture(); const pending = read();
  children[0].kill.mockImplementation(() => { children[0].emit('close'); replies[0](new Error('late close callback'), ''); return true; });
  await vi.advanceTimersByTimeAsync(PROCESS_TABLE_DEADLINE_MS);
  expect(await pending).toMatchObject({ ok: false, reason: 'timeout', cleanupRequested: true, exitObserved: true });
  expect(vi.getTimerCount()).toBe(0);
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

it.each(['append', 'remove', 'replace', 'empty', 'read-failure'] as const)('preserves state and all directories when launch snapshot changes during awaited query: %s', async (mutation) => {
  vi.useRealTimers(); const oldCi = process.env.CI; delete process.env.CI;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-append-fixture-'));
  const paths = { stateDir: path.join(root, 'state'), tmpDir: path.join(root, 'tmp') };
  const oldDir = path.join(paths.tmpDir, 'clubhouse-e2e-before');
  const newDir = path.join(paths.tmpDir, 'clubhouse-e2e-after');
  for (const dir of [oldDir, newDir]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'marker'), 'synthetic'); }
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    recordElectronApp(12345, oldDir, paths);
    const stateFile = path.join(paths.stateDir, 'electron-pids.jsonl');
    const delayed = deferred<ProcessTableResult>(); const query = vi.fn(() => delayed.promise);
    const pending = sweepE2EProcesses(paths, query); expect(query).toHaveBeenCalledOnce();
    if (mutation === 'append') recordElectronApp(23456, newDir, paths);
    if (mutation === 'remove') fs.unlinkSync(stateFile);
    if (mutation === 'replace') fs.writeFileSync(stateFile, JSON.stringify({ pid: 23456, userDataDir: newDir }) + '\n');
    if (mutation === 'empty') fs.writeFileSync(stateFile, '');
    if (mutation === 'read-failure') { fs.unlinkSync(stateFile); fs.mkdirSync(stateFile); }
    const bytes = mutation === 'remove' || mutation === 'read-failure' ? null : await fs.promises.readFile(stateFile);
    delayed.resolve({ ok: true, elapsedMs: 3, processes: [{ pid: 12345, ppid: 1, command: path.join(ELECTRON_DIST_DIR, 'synthetic') }] });
    expect(await pending).toEqual({ killed: 0, tempDirsRemoved: 0, processTable: 'complete', recordState: mutation === 'read-failure' ? 'unknown' : 'changed' });
    expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
    for (const dir of [oldDir, newDir]) expect(await fs.promises.readFile(path.join(dir, 'marker'), 'utf8')).toBe('synthetic');
    if (bytes !== null) expect(await fs.promises.readFile(stateFile)).toEqual(bytes);
    else if (mutation === 'read-failure') expect(fs.statSync(stateFile).isDirectory()).toBe(true);
    else expect(fs.existsSync(stateFile)).toBe(false);
    expect(fs.existsSync(paths.stateDir)).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
  }
});

it('treats initial launch-state read failure as unknown without enumerating or deleting directories', async () => {
  vi.useRealTimers(); const oldCi = process.env.CI; delete process.env.CI;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-read-fixture-'));
  const paths = { stateDir: path.join(root, 'state'), tmpDir: path.join(root, 'tmp') };
  fs.mkdirSync(path.join(paths.stateDir, 'electron-pids.jsonl'), { recursive: true });
  const retained = path.join(paths.tmpDir, 'clubhouse-e2e-retained'); fs.mkdirSync(retained, { recursive: true });
  const query = vi.fn(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await sweepE2EProcesses(paths, query)).toEqual({ killed: 0, tempDirsRemoved: 0, recordState: 'unknown' });
    expect(query).not.toHaveBeenCalled(); expect(fs.existsSync(retained)).toBe(true);
    expect(fs.statSync(path.join(paths.stateDir, 'electron-pids.jsonl')).isDirectory()).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
  }
});
