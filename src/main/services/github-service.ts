import { execSync } from 'child_process';

// ── Types ───────────────────────────────────────────────────────────────

export interface GitHubAuthor {
  login: string;
}

export interface GitHubLabel {
  name: string;
  color: string;
}

export interface GitHubComment {
  author: GitHubAuthor;
  body: string;
  createdAt: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: GitHubAuthor;
  labels: GitHubLabel[];
}

export interface GitHubIssueDetail extends GitHubIssue {
  body: string;
  comments: GitHubComment[];
  assignees: GitHubAuthor[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 15000 }).trim();
  } catch {
    return '';
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export function listIssues(
  dirPath: string,
  opts: { page?: number; perPage?: number; state?: string } = {}
): { issues: GitHubIssue[]; hasMore: boolean } {
  const page = opts.page ?? 1;
  const perPage = opts.perPage ?? 30;
  const state = opts.state ?? 'open';

  // gh CLI lacks offset support, so over-fetch and slice
  const fetchCount = page * perPage + 1;
  const fields = 'number,title,labels,createdAt,updatedAt,author,url,state';
  const raw = run(
    `gh issue list --json ${fields} --limit ${fetchCount} --state ${state}`,
    dirPath
  );
  if (!raw) return { issues: [], hasMore: false };

  try {
    const all: GitHubIssue[] = JSON.parse(raw);
    const start = (page - 1) * perPage;
    const sliced = all.slice(start, start + perPage);
    return { issues: sliced, hasMore: all.length > start + perPage };
  } catch {
    return { issues: [], hasMore: false };
  }
}

export function viewIssue(dirPath: string, issueNumber: number): GitHubIssueDetail | null {
  const fields = 'number,title,state,url,createdAt,updatedAt,author,labels,body,comments,assignees';
  const raw = run(
    `gh issue view ${issueNumber} --json ${fields}`,
    dirPath
  );
  if (!raw) return null;

  try {
    return JSON.parse(raw) as GitHubIssueDetail;
  } catch {
    return null;
  }
}

export function createIssue(
  dirPath: string,
  title: string,
  body: string
): { ok: boolean; url?: string; message?: string } {
  try {
    // Escape double quotes in title and body for shell safety
    const safeTitle = title.replace(/"/g, '\\"');
    const safeBody = body.replace(/"/g, '\\"');
    const output = execSync(
      `gh issue create --title "${safeTitle}" --body "${safeBody}"`,
      { cwd: dirPath, encoding: 'utf-8', timeout: 30000 }
    ).trim();
    // gh outputs the issue URL on success
    return { ok: true, url: output };
  } catch (err: any) {
    const msg = err?.stderr?.toString?.() || err?.message || 'Failed to create issue';
    return { ok: false, message: msg.trim() };
  }
}

export function getRepoUrl(dirPath: string): string {
  return run('gh repo view --json url --jq .url', dirPath);
}
