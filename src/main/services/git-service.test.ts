import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'fs';
import { execSync } from 'child_process';
import { getGitInfo, commit, push, pull, getFileDiff, stage, unstage } from './git-service';

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
