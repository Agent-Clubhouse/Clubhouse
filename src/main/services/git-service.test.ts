import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      unlink: vi.fn(),
      stat: vi.fn(),
    },
  };
});

import * as fs from 'fs';
import { execFile } from 'child_process';
import { getGitInfo, isInsideGitRepo, checkout, commit, push, pull, getFileDiff, stage, unstage, stageAll, unstageAll, discardFile, createBranch, stash, stashPop, listWorktrees, getLog, showCommit, getCommitFileDiff, getHeadSha, getDiffNumstat, parseNumstatZ, countUntrackedLines } from './git-service';

// No longer need to mock pathExists — git repo detection uses git rev-parse via execFile

const DIR = path.join(path.sep, 'test', 'repo');

/** Helper: mock execFile callback with a handler that maps args to stdout */
function mockGitExec(handler: (args: string[]) => string) {
  vi.mocked(execFile).mockImplementation(
    (_file: any, args: any, _opts: any, cb: any) => {
      try {
        const result = handler(args as string[]);
        cb(null, result, '');
      } catch (err: any) {
        cb(err, '', err.stderr || err.message || '');
      }
      return {} as any;
    }
  );
}

/** Helper: mock execFile to always fail with stderr */
function mockGitExecError(stderr: string) {
  vi.mocked(execFile).mockImplementation(
    (_file: any, _args: any, _opts: any, cb: any) => {
      const err = new Error('fail') as any;
      err.stderr = stderr;
      cb(err, '', stderr);
      return {} as any;
    }
  );
}

/** Standard mock for getGitInfo-style tests — routes by arg content */
function mockGitInfoExec(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    '--is-inside-work-tree': 'true\n',
    'rev-parse': 'main\n',
    'branch --no-color': '* main\n',
    'status --porcelain': '',
    'log': '',
    'remote': '',
    'stash': '',
  };
  const responses = { ...defaults, ...overrides };
  mockGitExec((args) => {
    const argsStr = args.join(' ');
    for (const [key, value] of Object.entries(responses)) {
      if (argsStr.includes(key)) return value;
    }
    return '';
  });
}

/** Mock execFile so that `git rev-parse --is-inside-work-tree` returns the given value */
function mockIsInsideGitRepo(inside: boolean) {
  mockGitExec((args) => {
    if (args.includes('--is-inside-work-tree')) {
      if (inside) return 'true\n';
      throw new Error('fatal: not a git repository');
    }
    return '';
  });
}

describe('isInsideGitRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when inside a git work tree', async () => {
    mockIsInsideGitRepo(true);
    expect(await isInsideGitRepo(DIR)).toBe(true);
  });

  it('returns false when not inside a git repo', async () => {
    mockIsInsideGitRepo(false);
    expect(await isInsideGitRepo(DIR)).toBe(false);
  });

  it('detects subfolder of a git repo (git rev-parse walks up)', async () => {
    // git rev-parse --is-inside-work-tree returns true even from subdirectories
    mockGitExec((args) => {
      if (args.includes('--is-inside-work-tree')) return 'true\n';
      return '';
    });
    expect(await isInsideGitRepo(path.join(DIR, 'subdir', 'nested'))).toBe(true);
  });
});

describe('getGitInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('not inside git repo returns hasGit:false and empty fields', async () => {
    mockIsInsideGitRepo(false);
    const info = await getGitInfo(DIR);
    expect(info.hasGit).toBe(false);
    expect(info.branch).toBe('');
    expect(info.branches).toEqual([]);
    expect(info.status).toEqual([]);
    expect(info.log).toEqual([]);
    expect(info.ahead).toBe(0);
    expect(info.behind).toBe(0);
  });

  it('parses branch from rev-parse', async () => {
    mockGitInfoExec({
      'rev-parse': 'feature/my-branch\n',
      'branch --no-color': '  main\n* feature/my-branch\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.branch).toBe('feature/my-branch');
  });

  it('parses git branch --no-color list, strips * prefix', async () => {
    mockGitInfoExec({
      'branch --no-color': '* main\n  develop\n  feature/x\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.branches).toEqual(['main', 'develop', 'feature/x']);
  });

  it('parses porcelain status — staged, unstaged, untracked', async () => {
    mockGitInfoExec({
      'status --porcelain': 'M  staged.ts\n M unstaged.ts\n?? new.ts\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.status).toHaveLength(3);
    expect(info.status[0]).toEqual({ path: 'staged.ts', status: 'M', staged: true });
    expect(info.status[1]).toEqual({ path: 'unstaged.ts', status: 'M', staged: false });
    expect(info.status[2]).toEqual({ path: 'new.ts', status: '??', staged: false });
  });

  it('parses ||| delimited log into GitLogEntry', async () => {
    mockGitInfoExec({
      'log': 'abc123|||abc|||Fix bug|||Author|||2 hours ago\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.log).toHaveLength(1);
    expect(info.log[0]).toEqual({
      hash: 'abc123',
      shortHash: 'abc',
      subject: 'Fix bug',
      author: 'Author',
      date: '2 hours ago',
    });
  });

  it('calculates ahead/behind from rev-list', async () => {
    mockGitInfoExec({
      'remote': 'origin\n',
      'rev-list': '3\t5\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.behind).toBe(3);
    expect(info.ahead).toBe(5);
    expect(info.remote).toBe('origin');
  });

  it('no remote returns ahead:0, behind:0', async () => {
    mockGitInfoExec({ 'remote': '\n' });
    const info = await getGitInfo(DIR);
    expect(info.ahead).toBe(0);
    expect(info.behind).toBe(0);
  });

  it('uses -uall flag to enumerate files inside untracked directories', async () => {
    mockGitExec((args) => {
      const argsStr = args.join(' ');
      if (argsStr.includes('--is-inside-work-tree')) return 'true\n';
      if (argsStr.includes('status')) {
        expect(args).toContain('-uall');
        return '?? src/new-folder/index.ts\n?? src/new-folder/utils.ts\n?? src/new-folder/types.ts\n';
      }
      if (argsStr.includes('rev-parse')) return 'main\n';
      if (argsStr.includes('branch --no-color')) return '* main\n';
      if (argsStr.includes('log')) return '';
      if (argsStr.includes('remote')) return '';
      if (argsStr.includes('stash')) return '';
      return '';
    });
    const info = await getGitInfo(DIR);
    expect(info.status).toHaveLength(3);
    expect(info.status[0]).toEqual({ path: 'src/new-folder/index.ts', status: '??', staged: false });
    expect(info.status[1]).toEqual({ path: 'src/new-folder/utils.ts', status: '??', staged: false });
    expect(info.status[2]).toEqual({ path: 'src/new-folder/types.ts', status: '??', staged: false });
  });

  it('parses nested directory paths for modified files', async () => {
    mockGitInfoExec({
      'status --porcelain': 'M  src/components/Header.tsx\n M src/utils/helpers/format.ts\nA  src/pages/new/Dashboard.tsx\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.status).toHaveLength(3);
    expect(info.status[0]).toEqual({ path: 'src/components/Header.tsx', status: 'M', staged: true });
    expect(info.status[1]).toEqual({ path: 'src/utils/helpers/format.ts', status: 'M', staged: false });
    expect(info.status[2]).toEqual({ path: 'src/pages/new/Dashboard.tsx', status: 'A', staged: true });
  });

  it('handles renamed files with arrow syntax', async () => {
    mockGitInfoExec({
      'status --porcelain': 'R  old-name.ts -> new-name.ts\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.status).toHaveLength(1);
    expect(info.status[0].status).toBe('R');
    expect(info.status[0].staged).toBe(true);
    expect(info.status[0].path).toContain('new-name.ts');
  });

  it('handles mix of staged adds in new dirs and unstaged modifications', async () => {
    mockGitInfoExec({
      'status --porcelain': 'A  lib/new-module/index.ts\nA  lib/new-module/helper.ts\n M src/app.ts\n?? docs/notes.md\n',
    });
    const info = await getGitInfo(DIR);
    const staged = info.status.filter((f) => f.staged);
    const unstaged = info.status.filter((f) => !f.staged);
    expect(staged).toHaveLength(2);
    expect(unstaged).toHaveLength(2);
    expect(staged[0].path).toBe('lib/new-module/index.ts');
    expect(staged[1].path).toBe('lib/new-module/helper.ts');
    expect(unstaged[0].path).toBe('src/app.ts');
    expect(unstaged[1].path).toBe('docs/notes.md');
  });

  it('empty status returns empty array, not parse artifacts', async () => {
    mockGitInfoExec();
    const info = await getGitInfo(DIR);
    expect(info.status).toEqual([]);
  });
});

describe('commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes message verbatim as arg (no shell escaping needed)', async () => {
    mockGitExec(() => 'committed\n');
    await commit(DIR, 'Fix "bug" here');
    const call = vi.mocked(execFile).mock.calls[0];
    const args = call[1] as string[];
    expect(args).toEqual(['commit', '-m', 'Fix "bug" here']);
  });

  it('returns ok:true with output on success', async () => {
    mockGitExec(() => '[main abc123] Fix bug\n 1 file changed\n');
    const result = await commit(DIR, 'Fix bug');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Fix bug');
  });
});

describe('push', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok:false when no remote', async () => {
    mockGitInfoExec({ 'remote': '\n' });
    const result = await push(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No remote');
  });
});

describe('pull', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok:false when no remote', async () => {
    mockGitInfoExec({ 'remote': '\n' });
    const result = await pull(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No remote');
  });
});

describe('getFileDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('staged=true reads from index (:file)', async () => {
    mockGitExec((args) => {
      if (args[1]?.startsWith('HEAD:')) return 'original content\n';
      if (args[1]?.startsWith(':')) return 'staged content\n';
      return '';
    });
    const diff = await getFileDiff(DIR, 'file.ts', true);
    expect(diff.original).toBe('original content\n');
    expect(diff.modified).toBe('staged content\n');
  });

  it('staged=false reads from disk', async () => {
    mockGitExec((args) => {
      if (args[1]?.startsWith('HEAD:')) return 'original content\n';
      return '';
    });
    vi.mocked(fs.promises.readFile).mockResolvedValue('disk content');
    const diff = await getFileDiff(DIR, 'file.ts', false);
    expect(diff.original).toBe('original content\n');
    expect(diff.modified).toBe('disk content');
  });

  it('new file returns empty original', async () => {
    mockGitExecError('not found');
    vi.mocked(fs.promises.readFile).mockResolvedValue('new file content');
    const diff = await getFileDiff(DIR, 'newfile.ts', false);
    expect(diff.original).toBe('');
    expect(diff.modified).toBe('new file content');
  });
});

describe('stage/unstage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stage returns ok:true on success', async () => {
    mockGitExec(() => '');
    const result = await stage(DIR, 'file.ts');
    expect(result.ok).toBe(true);
  });

  it('stage returns ok:false with message on failure', async () => {
    mockGitExecError('fatal: not a git repository');
    const result = await stage(DIR, 'file.ts');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not a git repository');
  });

  it('unstage returns ok:true on success', async () => {
    mockGitExec(() => '');
    const result = await unstage(DIR, 'file.ts');
    expect(result.ok).toBe(true);
  });

  it('unstage returns ok:false with message on failure', async () => {
    mockGitExecError('fatal: not a git repository');
    const result = await unstage(DIR, 'file.ts');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not a git repository');
  });
});

describe('stageAll/unstageAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stageAll runs git add -A', async () => {
    mockGitExec(() => '');
    const result = await stageAll(DIR);
    expect(result.ok).toBe(true);
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'git',
      ['add', '-A'],
      expect.objectContaining({ cwd: DIR }),
      expect.any(Function)
    );
  });

  it('stageAll returns ok:false with message on failure', async () => {
    mockGitExecError('fatal: not a git repository');
    const result = await stageAll(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not a git repository');
  });

  it('unstageAll runs git reset HEAD', async () => {
    mockGitExec(() => '');
    const result = await unstageAll(DIR);
    expect(result.ok).toBe(true);
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'git',
      ['reset', 'HEAD'],
      expect.objectContaining({ cwd: DIR }),
      expect.any(Function)
    );
  });

  it('unstageAll returns ok:false with message on failure', async () => {
    mockGitExecError('fatal: not a git repository');
    const result = await unstageAll(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not a git repository');
  });
});

describe('discardFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores tracked file with git restore', async () => {
    mockGitExec(() => '');
    const result = await discardFile(DIR, 'src/app.ts', false);
    expect(result.ok).toBe(true);
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'git',
      ['restore', '--', 'src/app.ts'],
      expect.objectContaining({ cwd: DIR }),
      expect.any(Function)
    );
  });

  it('deletes untracked file from disk', async () => {
    vi.mocked(fs.promises.unlink).mockResolvedValue(undefined);
    const result = await discardFile(DIR, 'new-file.ts', true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Deleted');
    expect(vi.mocked(fs.promises.unlink)).toHaveBeenCalledWith(path.join(DIR, 'new-file.ts'));
  });

  it('returns error when untracked file delete fails', async () => {
    vi.mocked(fs.promises.unlink).mockRejectedValue(new Error('ENOENT'));
    const result = await discardFile(DIR, 'missing.ts', true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ENOENT');
  });

  it('returns error when git restore fails', async () => {
    mockGitExecError('pathspec error');
    const result = await discardFile(DIR, 'bad-file.ts', false);
    expect(result.ok).toBe(false);
  });
});

describe('createBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates and checks out new branch', async () => {
    mockGitExec(() => 'Switched to a new branch\n');
    const result = await createBranch(DIR, 'feature/new-thing');
    expect(result.ok).toBe(true);
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'git',
      ['checkout', '-b', 'feature/new-thing'],
      expect.objectContaining({ cwd: DIR }),
      expect.any(Function)
    );
  });

  it('returns error if branch already exists', async () => {
    mockGitExecError("fatal: a branch named 'feature/new-thing' already exists");
    const result = await createBranch(DIR, 'feature/new-thing');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('already exists');
  });
});

describe('stash/stashPop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stash returns ok on success', async () => {
    mockGitExec(() => 'Saved working directory\n');
    const result = await stash(DIR);
    expect(result.ok).toBe(true);
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'git',
      ['stash'],
      expect.objectContaining({ cwd: DIR }),
      expect.any(Function)
    );
  });

  it('stash returns error on failure', async () => {
    mockGitExecError('No local changes to save');
    const result = await stash(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No local changes');
  });

  it('stashPop returns ok on success', async () => {
    mockGitExec(() => 'On branch main\n');
    const result = await stashPop(DIR);
    expect(result.ok).toBe(true);
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'git',
      ['stash', 'pop'],
      expect.objectContaining({ cwd: DIR }),
      expect.any(Function)
    );
  });

  it('stashPop returns error when no stash entries', async () => {
    mockGitExecError('No stash entries found');
    const result = await stashPop(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No stash entries');
  });
});

describe('getGitInfo — rename parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('splits rename into path and origPath', async () => {
    mockGitInfoExec({
      'status --porcelain': 'R  src/old.ts -> src/new.ts\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.status[0].path).toBe('src/new.ts');
    expect(info.status[0].origPath).toBe('src/old.ts');
    expect(info.status[0].status).toBe('R');
    expect(info.status[0].staged).toBe(true);
  });

  it('splits copy into path and origPath', async () => {
    mockGitInfoExec({
      'status --porcelain': 'C  base.ts -> copy.ts\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.status[0].path).toBe('copy.ts');
    expect(info.status[0].origPath).toBe('base.ts');
    expect(info.status[0].status).toBe('C');
  });
});

describe('getGitInfo — conflict detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets hasConflicts=true when UU status present', async () => {
    mockGitInfoExec({
      'status --porcelain': 'UU src/conflict.ts\n M src/ok.ts\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.hasConflicts).toBe(true);
    expect(info.status[0].status).toBe('UU');
  });

  it('detects AA (both-added) as conflict', async () => {
    mockGitInfoExec({
      'status --porcelain': 'AA both-added.ts\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.hasConflicts).toBe(true);
  });

  it('hasConflicts=false when no conflict codes', async () => {
    mockGitInfoExec({
      'status --porcelain': 'M  file.ts\n?? new.ts\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.hasConflicts).toBe(false);
  });
});

describe('getGitInfo — stash count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts stash entries', async () => {
    mockGitInfoExec({
      'stash': 'stash@{0}: WIP on main\nstash@{1}: WIP on feature\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.stashCount).toBe(2);
  });

  it('returns stashCount=0 when no stashes', async () => {
    mockGitInfoExec();
    const info = await getGitInfo(DIR);
    expect(info.stashCount).toBe(0);
  });
});

describe('checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok:true on successful checkout', async () => {
    mockGitExec(() => "Switched to branch 'main'\n");
    const result = await checkout(DIR, 'main');
    expect(result.ok).toBe(true);
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'git',
      ['checkout', 'main'],
      expect.objectContaining({ cwd: DIR }),
      expect.any(Function)
    );
  });

  it('returns ok:false with message when checkout fails (non-existent branch)', async () => {
    mockGitExecError('error: pathspec did not match any file(s) known to git');
    const result = await checkout(DIR, 'nonexistent-branch');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('pathspec');
  });

  it('returns ok:false with message when checkout fails due to uncommitted changes', async () => {
    mockGitExecError('error: Your local changes would be overwritten by checkout');
    const result = await checkout(DIR, 'feature/other');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('overwritten');
  });

  it('passes branch name as direct arg (no shell interpretation)', async () => {
    mockGitExec(() => '');
    await checkout(DIR, 'feature/my-branch');
    const call = vi.mocked(execFile).mock.calls[0];
    expect(call[0]).toBe('git');
    expect(call[1]).toEqual(['checkout', 'feature/my-branch']);
  });
});

describe('push — success case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pushes to remote branch and returns ok:true', async () => {
    let pushCalled = false;
    mockGitExec((args) => {
      const argsStr = args.join(' ');
      if (argsStr.includes('--is-inside-work-tree')) return 'true\n';
      if (argsStr.includes('push')) {
        pushCalled = true;
        return 'Everything up-to-date\n';
      }
      if (argsStr.includes('remote')) return 'origin\n';
      if (argsStr.includes('rev-parse')) return 'feature/x\n';
      if (argsStr.includes('branch --no-color')) return '* feature/x\n';
      if (argsStr.includes('status')) return '';
      if (argsStr.includes('log')) return '';
      if (argsStr.includes('rev-list')) return '0\t0\n';
      if (argsStr.includes('stash')) return '';
      return '';
    });
    const result = await push(DIR);
    expect(result.ok).toBe(true);
    expect(pushCalled).toBe(true);
  });

  it('returns error message when push command fails', async () => {
    mockGitExec((args) => {
      const argsStr = args.join(' ');
      if (argsStr.includes('--is-inside-work-tree')) return 'true\n';
      if (argsStr.includes('push')) {
        const err = new Error('rejected') as any;
        err.stderr = 'rejected: non-fast-forward';
        throw err;
      }
      if (argsStr.includes('remote')) return 'origin\n';
      if (argsStr.includes('rev-parse')) return 'main\n';
      if (argsStr.includes('branch --no-color')) return '* main\n';
      if (argsStr.includes('status')) return '';
      if (argsStr.includes('log')) return '';
      if (argsStr.includes('rev-list')) return '0\t1\n';
      if (argsStr.includes('stash')) return '';
      return '';
    });
    const result = await push(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('rejected');
  });
});

describe('pull — success case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pulls from remote branch and returns ok:true', async () => {
    let pullCalled = false;
    mockGitExec((args) => {
      const argsStr = args.join(' ');
      if (argsStr.includes('--is-inside-work-tree')) return 'true\n';
      if (argsStr.includes('pull')) {
        pullCalled = true;
        return 'Already up to date.\n';
      }
      if (argsStr.includes('remote')) return 'origin\n';
      if (argsStr.includes('rev-parse')) return 'main\n';
      if (argsStr.includes('branch --no-color')) return '* main\n';
      if (argsStr.includes('status')) return '';
      if (argsStr.includes('log')) return '';
      if (argsStr.includes('rev-list')) return '0\t0\n';
      if (argsStr.includes('stash')) return '';
      return '';
    });
    const result = await pull(DIR);
    expect(result.ok).toBe(true);
    expect(pullCalled).toBe(true);
  });

  it('returns error when pull has merge conflicts', async () => {
    mockGitExec((args) => {
      const argsStr = args.join(' ');
      if (argsStr.includes('--is-inside-work-tree')) return 'true\n';
      if (argsStr.includes('pull')) {
        const err = new Error('merge conflict') as any;
        err.stderr = 'CONFLICT (content): Merge conflict in file.ts';
        throw err;
      }
      if (argsStr.includes('remote')) return 'origin\n';
      if (argsStr.includes('rev-parse')) return 'main\n';
      if (argsStr.includes('branch --no-color')) return '* main\n';
      if (argsStr.includes('status')) return '';
      if (argsStr.includes('log')) return '';
      if (argsStr.includes('rev-list')) return '2\t0\n';
      if (argsStr.includes('stash')) return '';
      return '';
    });
    const result = await pull(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('CONFLICT');
  });
});

describe('commit — failure case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok:false with error message when commit fails', async () => {
    mockGitExecError('nothing to commit, working tree clean');
    const result = await commit(DIR, 'empty commit');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('nothing to commit');
  });
});

describe('getFileDiff — edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty modified when staged read fails', async () => {
    mockGitExec((args) => {
      if (args[1]?.startsWith('HEAD:')) return 'original\n';
      if (args[1]?.startsWith(':')) {
        const err = new Error('not in index') as any;
        err.stderr = 'not in index';
        throw err;
      }
      return '';
    });
    const diff = await getFileDiff(DIR, 'gone.ts', true);
    expect(diff.original).toBe('original\n');
    expect(diff.modified).toBe('');
  });

  it('returns empty modified when disk read fails for unstaged', async () => {
    mockGitExec((args) => {
      if (args[1]?.startsWith('HEAD:')) return 'original\n';
      return '';
    });
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));
    const diff = await getFileDiff(DIR, 'deleted.ts', false);
    expect(diff.original).toBe('original\n');
    expect(diff.modified).toBe('');
  });

  it('returns both empty for completely new untracked file that was deleted', async () => {
    mockGitExecError('not found');
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));
    const diff = await getFileDiff(DIR, 'phantom.ts', false);
    expect(diff.original).toBe('');
    expect(diff.modified).toBe('');
  });
});

describe('security — input validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('branch name validation', () => {
    it('rejects branch names starting with -', async () => {
      await expect(checkout(DIR, '--track')).rejects.toThrow("must not start with '-'");
      await expect(createBranch(DIR, '-evil')).rejects.toThrow("must not start with '-'");
    });

    it('rejects branch names with null bytes', async () => {
      await expect(checkout(DIR, 'main\0evil')).rejects.toThrow('null bytes');
      await expect(createBranch(DIR, 'branch\0name')).rejects.toThrow('null bytes');
    });

    it('allows valid branch names with slashes and dots', async () => {
      mockGitExec(() => 'Switched\n');
      const result = await checkout(DIR, 'feature/my-branch.v2');
      expect(result.ok).toBe(true);
    });
  });

  describe('file path validation', () => {
    it('rejects absolute paths', async () => {
      await expect(stage(DIR, '/etc/passwd')).rejects.toThrow('must be relative');
      await expect(unstage(DIR, '/etc/passwd')).rejects.toThrow('must be relative');
      await expect(getFileDiff(DIR, '/etc/passwd', false)).rejects.toThrow('must be relative');
      await expect(discardFile(DIR, '/etc/passwd', false)).rejects.toThrow('must be relative');
    });

    it('rejects paths with .. traversal', async () => {
      await expect(stage(DIR, '../../etc/passwd')).rejects.toThrow('traverse above');
      await expect(unstage(DIR, '../secret')).rejects.toThrow('traverse above');
      await expect(getFileDiff(DIR, '../../etc/shadow', true)).rejects.toThrow('traverse above');
      await expect(discardFile(DIR, '../../../tmp/evil', true)).rejects.toThrow('traverse above');
    });

    it('rejects paths with null bytes', async () => {
      await expect(stage(DIR, 'file\0.ts')).rejects.toThrow('null bytes');
      await expect(getFileDiff(DIR, 'src/\0evil', false)).rejects.toThrow('null bytes');
    });

    it('allows valid relative paths including nested dirs', async () => {
      mockGitExec(() => '');
      const result = await stage(DIR, 'src/components/Header.tsx');
      expect(result.ok).toBe(true);
    });

    it('allows paths with internal .. that resolve within repo', async () => {
      mockGitExec(() => '');
      const result = await stage(DIR, 'src/../lib/util.ts');
      expect(result.ok).toBe(true);
    });
  });

  describe('shell metacharacter safety', () => {
    it('commit message with backticks is passed as-is (no shell interpretation)', async () => {
      mockGitExec(() => 'committed\n');
      await commit(DIR, 'Fix `bug` in code');
      const call = vi.mocked(execFile).mock.calls[0];
      const args = call[1] as string[];
      expect(args).toEqual(['commit', '-m', 'Fix `bug` in code']);
    });

    it('commit message with $() is passed as-is', async () => {
      mockGitExec(() => 'committed\n');
      await commit(DIR, 'Update $(whoami) reference');
      const call = vi.mocked(execFile).mock.calls[0];
      const args = call[1] as string[];
      expect(args).toEqual(['commit', '-m', 'Update $(whoami) reference']);
    });

    it('branch name with shell metacharacters is passed as a single arg', async () => {
      mockGitExec(() => 'Switched\n');
      await checkout(DIR, 'feature/test;echo-pwned');
      const call = vi.mocked(execFile).mock.calls[0];
      expect(call[0]).toBe('git');
      expect(call[1]).toEqual(['checkout', 'feature/test;echo-pwned']);
    });
  });

  describe('execFile usage (no shell interpretation)', () => {
    it('uses execFile not execSync — args are always arrays', async () => {
      mockGitExec(() => '');
      await stage(DIR, 'file.ts');
      const call = vi.mocked(execFile).mock.calls[0];
      expect(call[0]).toBe('git');
      expect(Array.isArray(call[1])).toBe(true);
    });
  });
});

describe('getGitInfo — command failure resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns HEAD when rev-parse --abbrev-ref fails', async () => {
    mockGitExec((args) => {
      const argsStr = args.join(' ');
      if (argsStr.includes('--is-inside-work-tree')) return 'true\n';
      if (argsStr.includes('rev-parse')) throw new Error('fatal');
      if (argsStr.includes('branch --no-color')) return '* main\n';
      if (argsStr.includes('status')) return '';
      if (argsStr.includes('log')) return '';
      if (argsStr.includes('remote')) return '';
      if (argsStr.includes('stash')) return '';
      return '';
    });
    const info = await getGitInfo(DIR);
    expect(info.branch).toBe('HEAD');
  });

  it('returns empty branches when git branch fails', async () => {
    mockGitExec((args) => {
      const argsStr = args.join(' ');
      if (argsStr.includes('--is-inside-work-tree')) return 'true\n';
      if (argsStr.includes('rev-parse')) return 'main\n';
      if (argsStr.includes('branch --no-color')) throw new Error('fatal');
      if (argsStr.includes('status')) return '';
      if (argsStr.includes('log')) return '';
      if (argsStr.includes('remote')) return '';
      if (argsStr.includes('stash')) return '';
      return '';
    });
    const info = await getGitInfo(DIR);
    expect(info.branches).toEqual([]);
  });

  it('handles multiple log entries', async () => {
    mockGitInfoExec({
      'log': 'aaa|||aa|||First commit|||Alice|||1 hour ago\nbbb|||bb|||Second commit|||Bob|||2 hours ago\nccc|||cc|||Third commit|||Charlie|||3 hours ago\n',
    });
    const info = await getGitInfo(DIR);
    expect(info.log).toHaveLength(3);
    expect(info.log[0].author).toBe('Alice');
    expect(info.log[2].subject).toBe('Third commit');
  });

  it('detects all conflict codes: DD, AU, UD, UA, DU', async () => {
    const conflictCodes = ['DD', 'AU', 'UD', 'UA', 'DU'];
    for (const code of conflictCodes) {
      mockGitInfoExec({
        'status --porcelain': `${code} conflict-file.ts\n`,
      });
      const info = await getGitInfo(DIR);
      expect(info.hasConflicts).toBe(true);
    }
  });
});

// ── listWorktrees ────────────────────────────────────────────────────

describe('listWorktrees', () => {
  /** Helper that only handles the 4-arg overload used by gitExec. */
  function mockWorktreeExec(output: string) {
    vi.mocked(execFile).mockImplementation(
      ((...args: any[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === 'function') {
          cb(null, output, '');
        }
        return {} as any;
      }) as any,
    );
  }

  it('parses porcelain output with main and linked worktrees', async () => {
    const porcelainOutput = [
      'worktree /Users/test/project',
      'HEAD abc1234',
      'branch refs/heads/main',
      '',
      'worktree /Users/test/project/.clubhouse/agents/my-agent',
      'HEAD def5678',
      'branch refs/heads/my-agent/standby',
      '',
    ].join('\n');

    mockWorktreeExec(porcelainOutput);

    const entries = await listWorktrees(DIR);
    expect(entries).toHaveLength(2);

    expect(entries[0].path).toBe('/Users/test/project');
    expect(entries[0].label).toBe('project');
    expect(entries[0].branch).toBe('main');
    expect(entries[0].isBare).toBe(false);

    expect(entries[1].path).toBe('/Users/test/project/.clubhouse/agents/my-agent');
    expect(entries[1].label).toBe('my-agent');
    expect(entries[1].branch).toBe('my-agent/standby');
    expect(entries[1].isBare).toBe(false);
  });

  it('handles bare worktree', async () => {
    const porcelainOutput = [
      'worktree /Users/test/project',
      'HEAD abc1234',
      'branch refs/heads/main',
      'bare',
      '',
    ].join('\n');

    mockWorktreeExec(porcelainOutput);

    const entries = await listWorktrees(DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0].isBare).toBe(true);
  });

  it('handles detached HEAD (no branch line)', async () => {
    const porcelainOutput = [
      'worktree /Users/test/project',
      'HEAD abc1234',
      'detached',
      '',
    ].join('\n');

    mockWorktreeExec(porcelainOutput);

    const entries = await listWorktrees(DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0].branch).toBe('');
  });

  it('rejects on git error', async () => {
    vi.mocked(execFile).mockImplementation(
      ((...args: any[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === 'function') {
          const err = new Error('fail') as any;
          err.stderr = 'fatal: not a git repository';
          cb(err, '', err.stderr);
        }
        return {} as any;
      }) as any,
    );
    await expect(listWorktrees(DIR)).rejects.toThrow();
  });
});

// ── getLog ───────────────────────────────────────────────────────────

describe('getLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses log entries with pagination', async () => {
    mockGitExec((args) => {
      if (args.includes('log')) {
        return 'aaa111|||aaa|||First commit|||Alice|||1 hour ago\nbbb222|||bbb|||Second commit|||Bob|||2 hours ago\n';
      }
      return '';
    });
    const entries = await getLog(DIR, 10, 0);
    expect(entries).toHaveLength(2);
    expect(entries[0].hash).toBe('aaa111');
    expect(entries[0].subject).toBe('First commit');
    expect(entries[1].author).toBe('Bob');
  });

  it('returns empty array when no commits', async () => {
    mockGitExec(() => '');
    const entries = await getLog(DIR, 10, 0);
    expect(entries).toEqual([]);
  });

  it('passes skip and limit to git command', async () => {
    mockGitExec(() => '');
    await getLog(DIR, 25, 10);
    const call = vi.mocked(execFile).mock.calls[0];
    const args = call[1] as string[];
    expect(args).toContain('-25');
    expect(args).toContain('--skip=10');
    expect(args).toContain('-M');
  });
});

// ── showCommit ───────────────────────────────────────────────────────

describe('showCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses diff-tree output into files', async () => {
    mockGitExec(() => 'M\tsrc/app.ts\nA\tsrc/new.ts\nD\told.ts\n');
    const detail = await showCommit(DIR, 'abc123def');
    expect(detail.hash).toBe('abc123def');
    expect(detail.files).toHaveLength(3);
    expect(detail.files[0]).toEqual({ status: 'M', path: 'src/app.ts' });
    expect(detail.files[1]).toEqual({ status: 'A', path: 'src/new.ts' });
    expect(detail.files[2]).toEqual({ status: 'D', path: 'old.ts' });
  });

  it('parses renames with origPath', async () => {
    mockGitExec(() => 'R100\told-name.ts\tnew-name.ts\n');
    const detail = await showCommit(DIR, 'abc123de');
    expect(detail.files[0]).toEqual({ status: 'R100', origPath: 'old-name.ts', path: 'new-name.ts' });
  });

  it('rejects invalid commit hash', async () => {
    await expect(showCommit(DIR, 'not-a-hash!')).rejects.toThrow('Invalid commit hash');
  });

  it('rejects short hash under 4 chars', async () => {
    await expect(showCommit(DIR, 'abc')).rejects.toThrow('Invalid commit hash');
  });

  it('returns empty files when commit has no changes', async () => {
    mockGitExec(() => '');
    const detail = await showCommit(DIR, 'abc1234');
    expect(detail.files).toEqual([]);
  });
});

// ── getCommitFileDiff ────────────────────────────────────────────────

describe('getCommitFileDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns before and after content for a modified file', async () => {
    mockGitExec((args) => {
      const ref = args[1] as string;
      if (ref.includes('^:')) return 'old content\n';
      if (ref.includes(':')) return 'new content\n';
      return '';
    });
    const diff = await getCommitFileDiff(DIR, 'abc1234', 'src/app.ts');
    expect(diff.original).toBe('old content\n');
    expect(diff.modified).toBe('new content\n');
  });

  it('returns empty original for newly added file', async () => {
    mockGitExec((args) => {
      const ref = args[1] as string;
      if (ref.includes('^:')) throw new Error('not found');
      if (ref.includes(':')) return 'new file content\n';
      return '';
    });
    const diff = await getCommitFileDiff(DIR, 'abc1234', 'new.ts');
    expect(diff.original).toBe('');
    expect(diff.modified).toBe('new file content\n');
  });

  it('returns empty modified for deleted file', async () => {
    mockGitExec((args) => {
      const ref = args[1] as string;
      if (ref.includes('^:')) return 'deleted content\n';
      if (ref.includes(':')) throw new Error('not found');
      return '';
    });
    const diff = await getCommitFileDiff(DIR, 'abc1234', 'gone.ts');
    expect(diff.original).toBe('deleted content\n');
    expect(diff.modified).toBe('');
  });

  it('rejects invalid commit hash', async () => {
    await expect(getCommitFileDiff(DIR, 'bad!hash', 'file.ts')).rejects.toThrow('Invalid commit hash');
  });

  it('rejects absolute file path', async () => {
    await expect(getCommitFileDiff(DIR, 'abc1234', '/etc/passwd')).rejects.toThrow('must be relative');
  });

  it('rejects traversal path', async () => {
    await expect(getCommitFileDiff(DIR, 'abc1234', '../../etc/passwd')).rejects.toThrow('traverse above');
  });
});

describe('parseNumstatZ', () => {
  it('parses plain records', () => {
    expect(parseNumstatZ('3\t1\tsrc/a.ts\x0010\t0\tREADME.md\x00')).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1, binary: false },
      { path: 'README.md', added: 10, removed: 0, binary: false },
    ]);
  });

  it('reports binary files with zero counts', () => {
    expect(parseNumstatZ('-\t-\timg/logo.png\x00')).toEqual([
      { path: 'img/logo.png', added: 0, removed: 0, binary: true },
    ]);
  });

  it('uses the new path for rename records', () => {
    expect(parseNumstatZ('2\t2\t\x00old/name.ts\x00new/name.ts\x005\t0\tother.ts\x00')).toEqual([
      { path: 'new/name.ts', added: 2, removed: 2, binary: false },
      { path: 'other.ts', added: 5, removed: 0, binary: false },
    ]);
  });

  it('handles binary renames and paths with tabs or newlines', () => {
    expect(parseNumstatZ('-\t-\t\x00a.bin\x00b.bin\x001\t0\tweird\tname\nfile\x00')).toEqual([
      { path: 'b.bin', added: 0, removed: 0, binary: true },
      { path: 'weird\tname\nfile', added: 1, removed: 0, binary: false },
    ]);
  });

  it('returns [] for empty or unrecognised output', () => {
    expect(parseNumstatZ('')).toEqual([]);
    expect(parseNumstatZ('garbage\x00')).toEqual([]);
  });
});

describe('countUntrackedLines', () => {
  it('counts lines with and without a trailing newline', () => {
    expect(countUntrackedLines(Buffer.from('a\nb\n'))).toEqual({ added: 2, binary: false });
    expect(countUntrackedLines(Buffer.from('a\nb'))).toEqual({ added: 2, binary: false });
    expect(countUntrackedLines(Buffer.from(''))).toEqual({ added: 0, binary: false });
  });

  it('treats content with a NUL byte as binary', () => {
    expect(countUntrackedLines(Buffer.from([0x61, 0x00, 0x0a]))).toEqual({ added: 0, binary: true });
  });
});

describe('getHeadSha', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the trimmed sha', async () => {
    mockGitExec(() => 'abcdef1234567890abcdef1234567890abcdef12\n');
    expect(await getHeadSha(DIR)).toBe('abcdef1234567890abcdef1234567890abcdef12');
  });

  it('returns null when git fails (not a repo, no commits)', async () => {
    mockGitExecError('fatal: not a git repository');
    expect(await getHeadSha(DIR)).toBeNull();
  });
});

describe('getDiffNumstat', () => {
  const ROOT = path.join(path.sep, 'test', 'root');

  beforeEach(() => vi.clearAllMocks());

  function mockRepo(diff: string, untracked: string, calls: Array<{ args: string[]; cwd: string }> = []) {
    vi.mocked(execFile).mockImplementation(
      (_file: any, args: any, opts: any, cb: any) => {
        calls.push({ args, cwd: opts.cwd });
        const a = (args as string[]).join(' ');
        if (a.startsWith('rev-parse --show-toplevel')) cb(null, `${ROOT}\n`, '');
        else if (a.startsWith('diff --numstat')) cb(null, diff, '');
        else if (a.startsWith('ls-files')) cb(null, untracked, '');
        else cb(new Error('unexpected'), '', '');
        return {} as any;
      },
    );
  }

  it('diffs the working tree against the base from the repo root and adds untracked files', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    mockRepo('4\t2\tsrc/a.ts\x00', 'new.txt\x00big.bin\x00', calls);
    vi.mocked(fs.promises.stat).mockImplementation((async (p: string) => ({
      isFile: () => true,
      size: p.endsWith('big.bin') ? 2 * 1024 * 1024 : 10,
    })) as any);
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('one\ntwo\nthree\n') as any);

    const result = await getDiffNumstat(path.join(ROOT, 'sub'), 'abc1234');

    expect(result).toEqual([
      { path: 'src/a.ts', added: 4, removed: 2, binary: false },
      { path: 'new.txt', added: 3, removed: 0, binary: false },
      { path: 'big.bin', added: 0, removed: 0, binary: true },
    ]);
    expect(calls.find((c) => c.args[0] === 'diff')).toEqual({ args: ['diff', '--numstat', '-z', 'abc1234', '--'], cwd: ROOT });
    expect(calls.find((c) => c.args[0] === 'ls-files')).toEqual({ args: ['ls-files', '--others', '--exclude-standard', '-z'], cwd: ROOT });
    expect(fs.promises.readFile).toHaveBeenCalledWith(path.join(ROOT, 'new.txt'));
  });

  it('defaults the base to HEAD', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    mockRepo('', '', calls);
    expect(await getDiffNumstat(DIR)).toEqual([]);
    expect(calls.find((c) => c.args[0] === 'diff')!.args).toContain('HEAD');
  });

  it('marks untracked files containing NUL as binary', async () => {
    mockRepo('', 'blob\x00');
    vi.mocked(fs.promises.stat).mockResolvedValue({ isFile: () => true, size: 3 } as any);
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from([1, 0, 2]) as any);
    expect(await getDiffNumstat(DIR)).toEqual([{ path: 'blob', added: 0, removed: 0, binary: true }]);
  });

  it('returns [] outside a repository or on git failure', async () => {
    mockGitExecError('fatal: not a git repository');
    expect(await getDiffNumstat(DIR)).toEqual([]);
  });

  it('passes a large maxBuffer to diff and ls-files', async () => {
    const opts: any[] = [];
    vi.mocked(execFile).mockImplementation((_f: any, args: any, o: any, cb: any) => {
      opts.push({ a: (args as string[])[0], maxBuffer: o.maxBuffer });
      cb(null, (args as string[])[0] === 'rev-parse' ? `${ROOT}\n` : '', '');
      return {} as any;
    });
    await getDiffNumstat(DIR);
    expect(opts.find((o) => o.a === 'diff').maxBuffer).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(opts.find((o) => o.a === 'ls-files').maxBuffer).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  it('reuses untracked line counts while size and mtime are unchanged (2s poll)', async () => {
    mockRepo('', 'cached-once.txt\x00');
    vi.mocked(fs.promises.stat).mockResolvedValue({ isFile: () => true, size: 4, mtimeMs: 111 } as any);
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('a\nb\n') as any);
    await getDiffNumstat(DIR);
    const second = await getDiffNumstat(DIR);
    expect(second).toEqual([{ path: 'cached-once.txt', added: 2, removed: 0, binary: false }]);
    expect(fs.promises.readFile).toHaveBeenCalledTimes(1);
  });

  it('reads at most 200 untracked files per call; the rest list without counts', async () => {
    const names = Array.from({ length: 205 }, (_, i) => `budget-${i}.txt`);
    mockRepo('', names.join('\x00') + '\x00');
    vi.mocked(fs.promises.stat).mockResolvedValue({ isFile: () => true, size: 2, mtimeMs: 7 } as any);
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('x\n') as any);
    const result = await getDiffNumstat(DIR);
    expect(result).toHaveLength(205);
    expect(fs.promises.readFile).toHaveBeenCalledTimes(200);
    expect(result[204]).toEqual({ path: 'budget-204.txt', added: 0, removed: 0, binary: false });
  });

  it('rejects a base that looks like a flag without running git', async () => {
    mockGitExec(() => '');
    expect(await getDiffNumstat(DIR, '--output=/tmp/x')).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });
});
