import { execFile, spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import { appLog } from './log-service';
import { openHandoffRepository } from './handoff-snapshot';

const exec = promisify(execFile);
let root: string;
let repository: Awaited<ReturnType<typeof openHandoffRepository>>;

describe('handoff blob subprocess completion', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-stream-')));
    const config = path.join(root, 'empty-config'); fs.writeFileSync(config, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', config); vi.stubEnv('GIT_CONFIG_SYSTEM', config); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
    const git = (...args: string[]) => exec('git', args, { cwd: root });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
    await git('-c', `core.hooksPath=${path.join(root, 'absent-hooks')}`, 'commit', '--allow-empty', '-qm', 'Fixture');
    repository = await openHandoffRepository(root);
    vi.mocked(appLog).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers(); vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function subprocess() {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      kill: vi.fn(() => { stdout.end(); queueMicrotask(() => child.emit('close', null)); return true; }),
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(spawn).mockImplementation(() => { started(); return child as unknown as ChildProcess; });
    return { child, ready };
  }

  it('reports a spawn error once when the child also emits close', async () => {
    const { child, ready } = subprocess();
    const result = repository.streamBlob('0'.repeat(40), 0, async () => {}, async () => {}).catch((error: unknown) => error);
    await ready;
    child.emit('error', Object.assign(new Error('private executable path'), { code: 'ENOENT' }));
    child.stdout.end(); child.emit('close', -2);
    expect(await result).toMatchObject({ code: 'git_failed', message: expect.stringContaining('stderr=not_found.') });
    expect(appLog).toHaveBeenCalledTimes(1);
    expect(appLog).toHaveBeenCalledWith('core:git', 'warn', 'Handoff Git operation failed', {
      meta: { command: 'cat-file', exit: 'unknown', stderrClass: 'not_found' },
    });
  });

  it('classifies the stream deadline as timeout when the killed child has no exit code', async () => {
    const { child, ready } = subprocess();
    vi.useFakeTimers();
    const result = repository.streamBlob('0'.repeat(40), 0, async () => {}, async () => {}).catch((error: unknown) => error);
    await ready;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: 'git_failed', message: expect.stringContaining('stderr=timeout.') });
    expect(child.kill).toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledTimes(1);
    expect(appLog).toHaveBeenCalledWith('core:git', 'warn', 'Handoff Git operation failed', {
      meta: { command: 'cat-file', exit: 'unknown', stderrClass: 'timeout' },
    });
  });

  it('accepts a complete successful blob when the timer fires between exit and close', async () => {
    const { child, ready } = subprocess();
    // SHA-1 of Git's empty blob; size/hash verification must still run.
    const result = repository.streamBlob('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 0, async () => {}, async () => {});
    vi.useFakeTimers();
    await ready;
    child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
    child.stdout.end(); child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(appLog).not.toHaveBeenCalled();
  });
});
