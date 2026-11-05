import { describe, it, expect, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ args: string[]; options: Record<string, unknown> }> }));

vi.mock('child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    spawned.calls.push({ args, options });
    callback(null, '', '');
    return { stdin: { on: () => undefined, end: () => undefined } };
  },
}));

import { readGitStates } from './git-state';

// On Windows libuv looks for git.exe in the spawn's cwd before PATH, so a repo
// holding one would run it. Only this spawn shape prevents that, and no POSIX
// runner can show it by running anything.
describe('how git is spawned', () => {
  it('names the repo with -C and never makes it the cwd', async () => {
    await readGitStates('some-repo', ['a.md'], new AbortController().signal);

    expect(spawned.calls.length).toBeGreaterThan(0);
    for (const { args, options } of spawned.calls) {
      expect(options.cwd).toBeUndefined();
      expect(args.slice(0, 4)).toEqual(['-C', 'some-repo', '-c', 'core.fsmonitor=false']);
      expect((options.env as NodeJS.ProcessEnv).GIT_OPTIONAL_LOCKS).toBe('0');
      expect((options.env as NodeJS.ProcessEnv).GIT_NO_LAZY_FETCH).toBe('1');
    }
  });
});
