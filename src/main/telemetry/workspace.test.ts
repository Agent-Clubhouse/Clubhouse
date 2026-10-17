import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyFsError, classifyGitFailure, classifySearchError, editorBucket, flowClassifyingThrows } from './workspace';
import { abortPending, setRuntime } from './facade';
import { sampleWorkspace } from './workspace-gauges';
import type { TelemetryRuntime } from './types';

afterEach(() => {
  setRuntime(null);
  abortPending();
});

describe('classifyGitFailure', () => {
  it.each([
    [{ killed: true, signal: 'SIGTERM' }, 'timeout'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 128, stderr: 'fatal: not a git repository (or any parent)' }, 'not_a_repo'],
    [{ code: 128, stderr: "fatal: could not read Username for 'https://github.com'" }, 'auth'],
    [{ code: 128, stderr: 'git@github.com: Permission denied (publickey).' }, 'auth'],
    [{ code: 1, stderr: 'fatal: No configured push destination.' }, 'no_remote'],
    [{ code: 1, stderr: 'CONFLICT (content): Merge conflict in a.ts' }, 'conflict'],
    [{ code: 1, stderr: 'error: pathspec did not match' }, 'nonzero_exit'],
    [undefined, 'nonzero_exit'],
  ])('%j → %s', (err, errorType) => {
    expect(classifyGitFailure(err).errorType).toBe(errorType);
  });

  it('keeps the exit code but not the text', () => {
    expect(classifyGitFailure({ code: 128, stderr: 'secret' })).toEqual({ errorType: 'nonzero_exit', exitCode: 128, timedOut: false });
  });
});

describe('classifyFsError', () => {
  it('maps errno codes, sandbox denials and anything else', () => {
    expect(classifyFsError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(classifyFsError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('EACCES');
    expect(classifyFsError(new Error('Access denied: path "/etc/passwd" is outside allowed project directories'))).toBe('path_denied');
    expect(classifyFsError(Object.assign(new Error('x'), { code: 'EWEIRD' }))).toBe('unknown');
  });
});

describe('editorBucket', () => {
  it.each([
    ['code', 'vscode'],
    ['/usr/local/bin/code-insiders', 'vscode'],
    ['C:\\Program Files\\Cursor\\Cursor.exe', 'cursor'],
    ['zed', 'zed'],
    ['/Applications/IntelliJ/bin/idea', 'jetbrains'],
    ['webstorm64.exe', 'jetbrains'],
    ['my-private-editor --flag', 'other'],
  ])('%s → %s', (command, bucket) => {
    expect(editorBucket(command)).toBe(bucket);
  });
});

describe('classifySearchError', () => {
  it('maps ripgrep failures', () => {
    expect(classifySearchError({ killed: true })).toBe('timeout');
    expect(classifySearchError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).toBe('max_buffer');
    expect(classifySearchError({ code: 2, message: 'Command failed: rg\nregex parse error:\n    (foo\n    ^' })).toBe('bad_regex');
    expect(classifySearchError({ code: 2, message: 'Command failed: rg' })).toBe('rg_failed');
  });
});

function fakeRuntime(): TelemetryRuntime & { flows: unknown[]; counts: Array<[string, number]> } {
  const flows: unknown[] = [];
  const counts: Array<[string, number]> = [];
  return {
    level: 'standard',
    flows,
    counts,
    flow: (name, _opts, fn, extras) => {
      const result = fn({ set: () => {} });
      return Promise.resolve(result).then((r) => {
        flows.push({ name, classification: extras?.classify ? extras.classify(r as never) : 'ok' });
        return r;
      }) as never;
    },
    step: (_n, fn) => fn({ set: () => {} }),
    count: (name, value) => counts.push([name, value]),
    event: vi.fn(),
    exception: vi.fn(),
    replaySpan: vi.fn(),
    replayTree: vi.fn(),
    preview: () => [],
    recentExports: () => [],
    forceFlush: async () => {},
    shutdown: async () => {},
  } as unknown as TelemetryRuntime & { flows: unknown[]; counts: Array<[string, number]> };
}

describe('flowClassifyingThrows', () => {
  it('records a specific error type and rethrows the original error', async () => {
    const rt = fakeRuntime();
    setRuntime(rt);
    const boom = Object.assign(new Error('Command failed: rg\nregex parse error'), { code: 2 });
    await expect(flowClassifyingThrows('clubhouse.search.query', {}, async () => {
      throw boom;
    }, classifySearchError)).rejects.toBe(boom);
    await Promise.resolve();
    expect(rt.flows).toEqual([{ name: 'clubhouse.search.query', classification: { error: 'bad_regex' } }]);
  });

  it('passes results through when nothing throws', async () => {
    setRuntime(fakeRuntime());
    await expect(flowClassifyingThrows('clubhouse.search.query', {}, async () => 42, classifySearchError)).resolves.toBe(42);
  });
});

describe('sampleWorkspace', () => {
  it('records both gauges and survives a failing source', async () => {
    const rt = fakeRuntime();
    setRuntime(rt);
    await sampleWorkspace({ projectCount: async () => 7, activeWatchCount: () => 3 });
    expect(rt.counts).toEqual([['clubhouse.file_watch.active', 3], ['clubhouse.projects.count', 7]]);
    await sampleWorkspace({ projectCount: async () => { throw new Error('unreadable'); }, activeWatchCount: () => 1 });
    expect(rt.counts.at(-1)).toEqual(['clubhouse.file_watch.active', 1]);
  });
});
