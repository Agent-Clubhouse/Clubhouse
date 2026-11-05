import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ args: string[]; options: Record<string, unknown> }> }));

vi.mock('child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    spawned.calls.push({ args, options });
    callback(null, args[0] === '--version' ? 'git version 2.50.1' : '', '');
    return { stdin: { on: () => undefined, end: () => undefined } };
  },
}));

import { newGitContext, readGitStates } from './git-state';

// On Windows libuv looks for git.exe in the spawn's cwd before PATH, so a repo
// holding one would run it. Only this spawn shape prevents that, and no POSIX
// runner can show it by running anything.
describe('how git is spawned', () => {
  it('names the repo with -C and never makes it the cwd', async () => {
    process.env.GIT_CONFIG_GLOBAL = 'inherited';
    process.env.GIT_DIR = 'inherited';
    await readGitStates('some-repo', ['a.md'], new AbortController().signal, newGitContext());
    delete process.env.GIT_CONFIG_GLOBAL;
    delete process.env.GIT_DIR;

    for (const { args, options } of spawned.calls) {
      if (args[0] !== '--version') expect((options.env as NodeJS.ProcessEnv).GIT_CEILING_DIRECTORIES).toBe(path.dirname('some-repo'));
    }
    const repoCalls = spawned.calls.filter(({ args }) => args[0] !== '--version');
    expect(repoCalls.length).toBeGreaterThan(0);
    for (const { options } of spawned.calls) {
      expect(options.cwd).toBeUndefined();
      const env = options.env as NodeJS.ProcessEnv;
      expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
      expect(env.GIT_NO_LAZY_FETCH).toBe('1');
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(env.GIT_CONFIG_GLOBAL).toBe(os.devNull);
      expect(env.GIT_DIR).toBeUndefined();
    }
    for (const { args } of repoCalls) {
      expect(args.slice(0, 11)).toEqual(['-C', 'some-repo', '--no-lazy-fetch', '-c', 'safe.bareRepository=explicit', '-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=', '-c', 'core.attributesFile=']);
    }
  });
});
