import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import * as fs from 'fs';
import { execSync } from 'child_process';
import { getGitInfo, commit, push, pull, getFileDiff, stage, unstage, stageAll, unstageAll, discardFile, createBranch, stash, stashPop } from './git-service';

const DIR = '/test/repo';

describe('getGitInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no .git returns hasGit:false and empty fields', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const info = getGitInfo(DIR);
    expect(info.hasGit).toBe(false);
    expect(info.branch).toBe('');
    expect(info.branches).toEqual([]);
    expect(info.status).toEqual([]);
    expect(info.log).toEqual([]);
    expect(info.ahead).toBe(0);
    expect(info.behind).toBe(0);
  });

  it('parses branch from rev-parse', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('rev-parse --abbrev-ref')) return 'feature/my-branch\n';
      if (c.includes('git branch --no-color')) return '  main\n* feature/my-branch\n';
      if (c.includes('git status --porcelain')) return '';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.branch).toBe('feature/my-branch');
  });

  it('parses git branch --no-color list, strips * prefix', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n  develop\n  feature/x\n';
      if (c.includes('git status --porcelain')) return '';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.branches).toEqual(['main', 'develop', 'feature/x']);
  });

  it('parses porcelain status — staged, unstaged, untracked', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git status --porcelain')) return 'M  staged.ts\n M unstaged.ts\n?? new.ts\n';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.status).toHaveLength(3);
    expect(info.status[0]).toEqual({ path: 'staged.ts', status: 'M', staged: true });
    expect(info.status[1]).toEqual({ path: 'unstaged.ts', status: 'M', staged: false });
    expect(info.status[2]).toEqual({ path: 'new.ts', status: '??', staged: false });
  });

  it('parses ||| delimited log into GitLogEntry', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git status --porcelain')) return '';
      if (c.includes('git log')) return 'abc123|||abc|||Fix bug|||Author|||2 hours ago\n';
      if (c.includes('git remote')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.log).toHaveLength(1);
    expect(info.log[0]).toEqual({
      hash: 'abc123',
      shortHash: 'abc',
      subject: 'Fix bug',
      author: 'Author',
      date: '2 hours ago',
    });
  });

  it('calculates ahead/behind from rev-list', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git status --porcelain')) return '';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return 'origin\n';
      if (c.includes('rev-list --left-right')) return '3\t5\n';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.behind).toBe(3);
    expect(info.ahead).toBe(5);
    expect(info.remote).toBe('origin');
  });

  it('no remote returns ahead:0, behind:0', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git status --porcelain')) return '';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '\n';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.ahead).toBe(0);
    expect(info.behind).toBe(0);
  });

  it('uses -uall flag to enumerate files inside untracked directories', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git status --porcelain')) {
        expect(c).toContain('-uall');
        return '?? src/new-folder/index.ts\n?? src/new-folder/utils.ts\n?? src/new-folder/types.ts\n';
      }
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.status).toHaveLength(3);
    expect(info.status[0]).toEqual({ path: 'src/new-folder/index.ts', status: '??', staged: false });
    expect(info.status[1]).toEqual({ path: 'src/new-folder/utils.ts', status: '??', staged: false });
    expect(info.status[2]).toEqual({ path: 'src/new-folder/types.ts', status: '??', staged: false });
  });

  it('parses nested directory paths for modified files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git status --porcelain'))
        return 'M  src/components/Header.tsx\n M src/utils/helpers/format.ts\nA  src/pages/new/Dashboard.tsx\n';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.status).toHaveLength(3);
    expect(info.status[0]).toEqual({ path: 'src/components/Header.tsx', status: 'M', staged: true });
    expect(info.status[1]).toEqual({ path: 'src/utils/helpers/format.ts', status: 'M', staged: false });
    expect(info.status[2]).toEqual({ path: 'src/pages/new/Dashboard.tsx', status: 'A', staged: true });
  });

  it('handles renamed files with arrow syntax', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git status --porcelain'))
        return 'R  old-name.ts -> new-name.ts\n';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.status).toHaveLength(1);
    expect(info.status[0].status).toBe('R');
    expect(info.status[0].staged).toBe(true);
    expect(info.status[0].path).toContain('new-name.ts');
  });

  it('handles mix of staged adds in new dirs and unstaged modifications', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git status --porcelain'))
        return 'A  lib/new-module/index.ts\nA  lib/new-module/helper.ts\n M src/app.ts\n?? docs/notes.md\n';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    const staged = info.status.filter((f) => f.staged);
    const unstaged = info.status.filter((f) => !f.staged);
    expect(staged).toHaveLength(2);
    expect(unstaged).toHaveLength(2);
    expect(staged[0].path).toBe('lib/new-module/index.ts');
    expect(staged[1].path).toBe('lib/new-module/helper.ts');
    expect(unstaged[0].path).toBe('src/app.ts');
    expect(unstaged[1].path).toBe('docs/notes.md');
  });

  it('empty status returns empty array, not parse artifacts', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git status --porcelain')) return '';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.status).toEqual([]);
  });
});

describe('commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('escapes double quotes in message', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockReturnValue('committed\n');
    commit(DIR, 'Fix "bug" here');
    const call = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(call).toContain('Fix \\"bug\\" here');
  });

  it('returns ok:true with output on success', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockReturnValue('[main abc123] Fix bug\n 1 file changed\n');
    const result = commit(DIR, 'Fix bug');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Fix bug');
  });
});

describe('push', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok:false when no remote', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git remote')) return '\n';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git status --porcelain')) return '';
      if (c.includes('git log')) return '';
      return '';
    });
    const result = push(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No remote');
  });
});

describe('pull', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok:false when no remote', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git remote')) return '\n';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git status --porcelain')) return '';
      if (c.includes('git log')) return '';
      return '';
    });
    const result = pull(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No remote');
  });
});

describe('getFileDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('staged=true reads from index (:file)', () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('HEAD:')) return 'original content\n';
      if (c.includes(':"')) return 'staged content\n';
      return '';
    });
    const diff = getFileDiff(DIR, 'file.ts', true);
    expect(diff.original).toBe('original content\n');
    expect(diff.modified).toBe('staged content\n');
  });

  it('staged=false reads from disk', () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('HEAD:')) return 'original content\n';
      return '';
    });
    vi.mocked(fs.readFileSync).mockReturnValue('disk content');
    const diff = getFileDiff(DIR, 'file.ts', false);
    expect(diff.original).toBe('original content\n');
    expect(diff.modified).toBe('disk content');
  });

  it('new file returns empty original', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    vi.mocked(fs.readFileSync).mockReturnValue('new file content');
    const diff = getFileDiff(DIR, 'newfile.ts', false);
    expect(diff.original).toBe('');
    expect(diff.modified).toBe('new file content');
  });
});

describe('stage/unstage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stage returns true on success', () => {
    vi.mocked(execSync).mockReturnValue('');
    expect(stage(DIR, 'file.ts')).toBe(true);
  });

  it('stage returns false on failure', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('fail'); });
    expect(stage(DIR, 'file.ts')).toBe(false);
  });

  it('unstage returns true on success', () => {
    vi.mocked(execSync).mockReturnValue('');
    expect(unstage(DIR, 'file.ts')).toBe(true);
  });

  it('unstage returns false on failure', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('fail'); });
    expect(unstage(DIR, 'file.ts')).toBe(false);
  });
});

describe('stageAll/unstageAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stageAll runs git add -A', () => {
    vi.mocked(execSync).mockReturnValue('');
    expect(stageAll(DIR)).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith('git add -A', expect.objectContaining({ cwd: DIR }));
  });

  it('stageAll returns false on failure', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('fail'); });
    expect(stageAll(DIR)).toBe(false);
  });

  it('unstageAll runs git reset HEAD', () => {
    vi.mocked(execSync).mockReturnValue('');
    expect(unstageAll(DIR)).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith('git reset HEAD', expect.objectContaining({ cwd: DIR }));
  });

  it('unstageAll returns false on failure', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('fail'); });
    expect(unstageAll(DIR)).toBe(false);
  });
});

describe('discardFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores tracked file with git restore', () => {
    vi.mocked(execSync).mockReturnValue('');
    const result = discardFile(DIR, 'src/app.ts', false);
    expect(result.ok).toBe(true);
    const call = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(call).toContain('git restore');
    expect(call).toContain('src/app.ts');
  });

  it('deletes untracked file from disk', () => {
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    const result = discardFile(DIR, 'new-file.ts', true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Deleted');
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith('/test/repo/new-file.ts');
  });

  it('returns error when untracked file delete fails', () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const result = discardFile(DIR, 'missing.ts', true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ENOENT');
  });

  it('returns error when git restore fails', () => {
    vi.mocked(execSync).mockImplementation(() => {
      const err = new Error('pathspec error') as any;
      err.stderr = Buffer.from('pathspec error');
      throw err;
    });
    const result = discardFile(DIR, 'bad-file.ts', false);
    expect(result.ok).toBe(false);
  });
});

describe('createBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates and checks out new branch', () => {
    vi.mocked(execSync).mockReturnValue('Switched to a new branch\n');
    const result = createBranch(DIR, 'feature/new-thing');
    expect(result.ok).toBe(true);
    const call = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(call).toContain('git checkout -b');
    expect(call).toContain('feature/new-thing');
  });

  it('returns error if branch already exists', () => {
    vi.mocked(execSync).mockImplementation(() => {
      const err = new Error('already exists') as any;
      err.stderr = Buffer.from('fatal: a branch named \'feature/new-thing\' already exists');
      throw err;
    });
    const result = createBranch(DIR, 'feature/new-thing');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('already exists');
  });
});

describe('stash/stashPop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stash returns ok on success', () => {
    vi.mocked(execSync).mockReturnValue('Saved working directory\n');
    const result = stash(DIR);
    expect(result.ok).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith('git stash', expect.objectContaining({ cwd: DIR }));
  });

  it('stash returns error on failure', () => {
    vi.mocked(execSync).mockImplementation(() => {
      const err = new Error('fail') as any;
      err.stderr = Buffer.from('No local changes to save');
      throw err;
    });
    const result = stash(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No local changes');
  });

  it('stashPop returns ok on success', () => {
    vi.mocked(execSync).mockReturnValue('On branch main\n');
    const result = stashPop(DIR);
    expect(result.ok).toBe(true);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith('git stash pop', expect.objectContaining({ cwd: DIR }));
  });

  it('stashPop returns error when no stash entries', () => {
    vi.mocked(execSync).mockImplementation(() => {
      const err = new Error('fail') as any;
      err.stderr = Buffer.from('No stash entries found');
      throw err;
    });
    const result = stashPop(DIR);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No stash entries');
  });
});

describe('getGitInfo — rename parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('splits rename into path and origPath', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git status --porcelain')) return 'R  src/old.ts -> src/new.ts\n';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      if (c.includes('git stash list')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.status[0].path).toBe('src/new.ts');
    expect(info.status[0].origPath).toBe('src/old.ts');
    expect(info.status[0].status).toBe('R');
    expect(info.status[0].staged).toBe(true);
  });

  it('splits copy into path and origPath', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git status --porcelain')) return 'C  base.ts -> copy.ts\n';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      if (c.includes('git stash list')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.status[0].path).toBe('copy.ts');
    expect(info.status[0].origPath).toBe('base.ts');
    expect(info.status[0].status).toBe('C');
  });
});

describe('getGitInfo — conflict detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets hasConflicts=true when UU status present', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git status --porcelain')) return 'UU src/conflict.ts\n M src/ok.ts\n';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      if (c.includes('git stash list')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.hasConflicts).toBe(true);
    expect(info.status[0].status).toBe('UU');
  });

  it('detects AA (both-added) as conflict', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git status --porcelain')) return 'AA both-added.ts\n';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      if (c.includes('git stash list')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.hasConflicts).toBe(true);
  });

  it('hasConflicts=false when no conflict codes', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git status --porcelain')) return 'M  file.ts\n?? new.ts\n';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      if (c.includes('git stash list')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.hasConflicts).toBe(false);
  });
});

describe('getGitInfo — stash count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts stash entries', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git stash list')) return 'stash@{0}: WIP on main\nstash@{1}: WIP on feature\n';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git status --porcelain')) return '';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.stashCount).toBe(2);
  });

  it('returns stashCount=0 when no stashes', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd);
      if (c.includes('git stash list')) return '';
      if (c.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (c.includes('git branch --no-color')) return '* main\n';
      if (c.includes('git status --porcelain')) return '';
      if (c.includes('git log')) return '';
      if (c.includes('git remote')) return '';
      return '';
    });
    const info = getGitInfo(DIR);
    expect(info.stashCount).toBe(0);
  });
});
