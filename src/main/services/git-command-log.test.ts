import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_ATTRIBUTION_WINDOW_MS, gitVerbsIn, noteAgentToolCall, recentGitCommands, resetGitCommandLog, shellCommandFrom,
} from './git-command-log';

afterEach(() => resetGitCommandLog());

describe('gitVerbsIn', () => {
  it('finds each git call in a chained command', () => {
    expect(gitVerbsIn('git add . && git commit -m "x" && git push origin main')).toEqual(['commit', 'push']);
  });

  it('skips global options, including ones that take a value', () => {
    expect(gitVerbsIn('git -C ../repo -c core.pager=cat --no-pager fetch --all')).toEqual(['fetch']);
    expect(gitVerbsIn('git --git-dir=.git switch -c feature/x')).toEqual(['switch']);
  });

  it('matches a full path to git', () => {
    expect(gitVerbsIn('/usr/bin/git checkout main')).toEqual(['checkout']);
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
  it('records only git commands that move refs, and forgets them after the window', () => {
    noteAgentToolCall('a1', { command: 'npm test' }, 1_000);
    noteAgentToolCall('a1', { command: 'git status' }, 1_000);
    noteAgentToolCall('a1', { command: 'git commit -m x', cwd: 'wt' }, 2_000);
    noteAgentToolCall('a2', { command: 'git push' }, 3_000);
    expect(recentGitCommands(3_000)).toEqual([
      { agentId: 'a1', verbs: ['commit'], cwd: 'wt', at: 2_000 },
      { agentId: 'a2', verbs: ['push'], at: 3_000 },
    ]);
    expect(recentGitCommands(2_000 + GIT_ATTRIBUTION_WINDOW_MS + 1).map((r) => r.agentId)).toEqual(['a2']);
  });
});
