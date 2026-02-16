import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import { listIssues, viewIssue, createIssue, getRepoUrl } from './github-service';

const DIR = '/test/repo';

describe('listIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns issues from gh CLI JSON output', () => {
    const issues = [
      { number: 1, title: 'Bug', state: 'OPEN', url: 'https://github.com/repo/issues/1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', author: { login: 'alice' }, labels: [] },
      { number: 2, title: 'Feature', state: 'OPEN', url: 'https://github.com/repo/issues/2', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z', author: { login: 'bob' }, labels: [{ name: 'enhancement', color: '0075ca' }] },
    ];
    vi.mocked(execSync).mockReturnValue(JSON.stringify(issues) + '\n');

    const result = listIssues(DIR);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].number).toBe(1);
    expect(result.issues[1].labels).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });

  it('returns empty array when gh command fails', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('gh not found'); });

    const result = listIssues(DIR);
    expect(result.issues).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('returns empty array when gh returns empty string', () => {
    vi.mocked(execSync).mockReturnValue('');

    const result = listIssues(DIR);
    expect(result.issues).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('returns empty array when gh returns invalid JSON', () => {
    vi.mocked(execSync).mockReturnValue('not json\n');

    const result = listIssues(DIR);
    expect(result.issues).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('paginates using over-fetch and slice', () => {
    // 31 items — page 1 of 30 should return 30 items and hasMore=true
    const issues = Array.from({ length: 31 }, (_, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}`,
      state: 'OPEN',
      url: `https://github.com/repo/issues/${i + 1}`,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      author: { login: 'user' },
      labels: [],
    }));
    vi.mocked(execSync).mockReturnValue(JSON.stringify(issues) + '\n');

    const result = listIssues(DIR, { page: 1, perPage: 30 });
    expect(result.issues).toHaveLength(30);
    expect(result.hasMore).toBe(true);
    expect(result.issues[0].number).toBe(1);
    expect(result.issues[29].number).toBe(30);
  });

  it('returns hasMore=false when on last page', () => {
    const issues = Array.from({ length: 15 }, (_, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}`,
      state: 'OPEN',
      url: `https://github.com/repo/issues/${i + 1}`,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      author: { login: 'user' },
      labels: [],
    }));
    vi.mocked(execSync).mockReturnValue(JSON.stringify(issues) + '\n');

    const result = listIssues(DIR, { page: 1, perPage: 30 });
    expect(result.issues).toHaveLength(15);
    expect(result.hasMore).toBe(false);
  });

  it('passes state filter to gh CLI command', () => {
    vi.mocked(execSync).mockReturnValue('[]\n');

    listIssues(DIR, { state: 'closed' });
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain('--state closed');
  });

  it('defaults to state=open', () => {
    vi.mocked(execSync).mockReturnValue('[]\n');

    listIssues(DIR);
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain('--state open');
  });

  it('passes correct cwd to execSync', () => {
    vi.mocked(execSync).mockReturnValue('[]\n');

    listIssues(DIR);
    const opts = vi.mocked(execSync).mock.calls[0][1] as { cwd: string };
    expect(opts.cwd).toBe(DIR);
  });
});

describe('viewIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed issue detail', () => {
    const detail = {
      number: 42,
      title: 'Fix login bug',
      state: 'OPEN',
      url: 'https://github.com/repo/issues/42',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      author: { login: 'alice' },
      labels: [{ name: 'bug', color: 'd73a4a' }],
      body: 'Login is broken',
      comments: [{ author: { login: 'bob' }, body: 'I can reproduce this', createdAt: '2026-01-02T00:00:00Z' }],
      assignees: [{ login: 'alice' }],
    };
    vi.mocked(execSync).mockReturnValue(JSON.stringify(detail) + '\n');

    const result = viewIssue(DIR, 42);
    expect(result).not.toBeNull();
    expect(result!.number).toBe(42);
    expect(result!.body).toBe('Login is broken');
    expect(result!.comments).toHaveLength(1);
    expect(result!.assignees).toHaveLength(1);
  });

  it('returns null when gh command fails', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });

    const result = viewIssue(DIR, 999);
    expect(result).toBeNull();
  });

  it('returns null on empty output', () => {
    vi.mocked(execSync).mockReturnValue('');

    const result = viewIssue(DIR, 42);
    expect(result).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    vi.mocked(execSync).mockReturnValue('not json\n');

    const result = viewIssue(DIR, 42);
    expect(result).toBeNull();
  });

  it('passes issue number in command', () => {
    vi.mocked(execSync).mockReturnValue('');

    viewIssue(DIR, 42);
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain('gh issue view 42');
  });

  it('requests correct JSON fields', () => {
    vi.mocked(execSync).mockReturnValue('');

    viewIssue(DIR, 1);
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain('--json');
    expect(cmd).toContain('body');
    expect(cmd).toContain('comments');
    expect(cmd).toContain('assignees');
  });
});

describe('createIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok with URL on success', () => {
    vi.mocked(execSync).mockReturnValue('https://github.com/repo/issues/5\n');

    const result = createIssue(DIR, 'New bug', 'Description');
    expect(result.ok).toBe(true);
    expect(result.url).toBe('https://github.com/repo/issues/5');
  });

  it('returns ok:false with message on failure', () => {
    vi.mocked(execSync).mockImplementation(() => {
      const err = new Error('auth required') as any;
      err.stderr = Buffer.from('gh auth login required');
      throw err;
    });

    const result = createIssue(DIR, 'Title', 'Body');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('auth');
  });

  it('escapes double quotes in title', () => {
    vi.mocked(execSync).mockReturnValue('https://github.com/repo/issues/1\n');

    createIssue(DIR, 'Fix "bug" here', 'body');
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain('Fix \\"bug\\" here');
  });

  it('escapes double quotes in body', () => {
    vi.mocked(execSync).mockReturnValue('https://github.com/repo/issues/1\n');

    createIssue(DIR, 'Title', 'Has "quotes"');
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain('Has \\"quotes\\"');
  });

  it('uses correct cwd', () => {
    vi.mocked(execSync).mockReturnValue('url\n');

    createIssue(DIR, 'Title', 'Body');
    const opts = vi.mocked(execSync).mock.calls[0][1] as { cwd: string };
    expect(opts.cwd).toBe(DIR);
  });

  it('uses 30s timeout for create (longer than list)', () => {
    vi.mocked(execSync).mockReturnValue('url\n');

    createIssue(DIR, 'Title', 'Body');
    const opts = vi.mocked(execSync).mock.calls[0][1] as { timeout: number };
    expect(opts.timeout).toBe(30000);
  });
});

describe('getRepoUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the repo URL', () => {
    vi.mocked(execSync).mockReturnValue('https://github.com/org/repo\n');

    const url = getRepoUrl(DIR);
    expect(url).toBe('https://github.com/org/repo');
  });

  it('returns empty string on failure', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('no repo'); });

    const url = getRepoUrl(DIR);
    expect(url).toBe('');
  });

  it('runs gh repo view command', () => {
    vi.mocked(execSync).mockReturnValue('');

    getRepoUrl(DIR);
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain('gh repo view');
    expect(cmd).toContain('--json url');
    expect(cmd).toContain('--jq .url');
  });
});
