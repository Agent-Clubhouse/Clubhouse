import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_ATTRIBUTION_WINDOW_MS, MAX_COMMAND_LENGTH, gitCallsIn, gitVerbsIn, noteAgentToolCall, recentGitCommands,
  resetGitCommandLog, shellCommandFrom,
} from './git-command-log';

afterEach(() => resetGitCommandLog());

describe('gitVerbsIn', () => {
  it('finds each git call in a chained command', () => {
    expect(gitVerbsIn('git add . && git commit -m "x" && git push origin main')).toEqual(['commit', 'push']);
  });

  it('skips global options, including ones that take a value', () => {
    expect(gitVerbsIn('git -C ../repo -c core.pager=cat --no-pager fetch --all')).toEqual(['fetch']);
    expect(gitVerbsIn('git --git-dir=.git switch -c feature/x')).toEqual(['switch']);
    expect(gitVerbsIn('git --git-dir .git --work-tree . checkout main')).toEqual(['checkout']);
  });

  it('matches a full path to git', () => {
    expect(gitVerbsIn('/usr/bin/git checkout main')).toEqual(['checkout']);
    expect(gitVerbsIn('C:\\Program Files\\Git\\bin\\git.exe push')).toEqual(['push']);
  });

  it('ignores read-only commands and lookalikes', () => {
    expect(gitVerbsIn('git status && git log --oneline')).toEqual([]);
    expect(gitVerbsIn('legit commit')).toEqual([]);
    expect(gitVerbsIn('git-lfs push')).toEqual([]);
    expect(gitVerbsIn('echo commit')).toEqual([]);
  });

  it('knows the other ref-moving verbs', () => {
    expect(gitVerbsIn('git cherry-pick abc; git rebase main; git merge x; git pull; git reset --hard; git revert HEAD; git am p'))
      .toEqual(['cherry-pick', 'rebase', 'merge', 'pull', 'reset', 'revert', 'am']);
  });

  it('parses a long run of options without a subcommand in a few milliseconds', () => {
    const options = `git ${Array.from({ length: 200 }, () => '--x').join(' ')}`;
    const dashes = `git ${Array.from({ length: 200 }, () => '-c -c').join(' ')}`;
    const start = performance.now();
    expect(gitVerbsIn(options)).toEqual([]);
    expect(gitVerbsIn(dashes)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('reads no further than the length cap', () => {
    expect(gitVerbsIn(`${' '.repeat(MAX_COMMAND_LENGTH)} && git push`)).toEqual([]);
  });
});

describe('gitCallsIn', () => {
  it('keeps the -C folder of each call', () => {
    expect(gitCallsIn('git -C sub commit -m x && git push')).toEqual([{ verb: 'commit', dir: 'sub' }, { verb: 'push' }]);
    expect(gitCallsIn('git -C a -C b fetch')).toEqual([{ verb: 'fetch', dir: path.join('a', 'b') }]);
  });
});

describe('shellCommandFrom', () => {
  it('reads a command string, an argv array, and a cwd', () => {
    expect(shellCommandFrom({ command: 'git push' })).toEqual({ command: 'git push' });
    expect(shellCommandFrom({ command: ['bash', '-lc', 'git commit -m x'], cwd: 'here' })).toEqual({ command: 'bash -lc git commit -m x', cwd: 'here' });
    expect(shellCommandFrom({ cmd: 'git fetch' })).toEqual({ command: 'git fetch' });
  });

  it('returns null for anything that is not a shell command', () => {
    expect(shellCommandFrom(undefined)).toBeNull();
    expect(shellCommandFrom('git push')).toBeNull();
    expect(shellCommandFrom({ file_path: 'a.ts' })).toBeNull();
    expect(shellCommandFrom({ command: [1, 2] })).toBeNull();
  });
});

describe('the command log', () => {
  const base = path.resolve('repo');

  it('records each ref-moving git call, and forgets them after the window', () => {
    noteAgentToolCall('a1', { command: 'npm test' }, { at: 1_000 });
    noteAgentToolCall('a1', { command: 'git status' }, { at: 1_000 });
    noteAgentToolCall('a1', { command: 'git commit -m x && git push', cwd: base }, { at: 2_000 });
    noteAgentToolCall('a2', { command: 'git fetch' }, { at: 3_000 });
    expect(recentGitCommands(3_000).map((r) => [r.agentId, r.verb, r.cwd, r.at])).toEqual([
      ['a1', 'commit', base, 2_000],
      ['a1', 'push', base, 2_000],
      ['a2', 'fetch', undefined, 3_000],
    ]);
    expect(recentGitCommands(2_000 + GIT_ATTRIBUTION_WINDOW_MS + 1).map((r) => r.agentId)).toEqual(['a2']);
  });

  it('leaves out calls noted after the time asked about', () => {
    noteAgentToolCall('a1', { command: 'git commit' }, { at: 5_000 });
    expect(recentGitCommands(4_000)).toEqual([]);
  });

  it('uses the hook\'s cwd, joined with -C, and the input\'s own cwd over the hook\'s', () => {
    noteAgentToolCall('a1', { command: 'git -C sub commit' }, { cwd: base, at: 1 });
    noteAgentToolCall('a2', { command: 'git push', cwd: path.join(base, 'own') }, { cwd: base, at: 1 });
    expect(recentGitCommands(1).map((r) => r.cwd)).toEqual([path.join(base, 'sub'), path.join(base, 'own')]);
  });

  it('notes a call once though its pre and post hooks both carry it', () => {
    noteAgentToolCall('a1', { command: 'git commit' }, { callId: 't1', at: 1 });
    noteAgentToolCall('a1', { command: 'git commit' }, { callId: 't1', at: 2 });
    noteAgentToolCall('a1', { command: 'git commit' }, { callId: 't2', at: 3 });
    noteAgentToolCall('a2', { command: 'git push' }, { at: 4 });
    noteAgentToolCall('a2', { command: 'git push' }, { at: 5 });
    expect(recentGitCommands(5).map((r) => [r.agentId, r.at])).toEqual([['a1', 1], ['a1', 3], ['a2', 4]]);
  });
});
