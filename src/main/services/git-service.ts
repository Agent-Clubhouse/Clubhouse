import { execFile as nodeExecFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitInfo, GitStatusFile, GitLogEntry, GitOpResult, GitWorktreeEntry, GitCommitDetail, GitCommitFileEntry } from '../../shared/types';
import { appLog } from './log-service';

// Conflict status codes from git porcelain format
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Reject branch names that could be misinterpreted as git flags or contain dangerous chars. */
function validateBranchName(name: string): void {
  if (name.startsWith('-')) {
    throw new Error(`Invalid branch name: must not start with '-'`);
  }
  if (name.includes('\0')) {
    throw new Error('Invalid branch name: must not contain null bytes');
  }
}

/** Reject file paths with traversal sequences or null bytes. */
function validateFilePath(filePath: string): void {
  if (path.isAbsolute(filePath)) {
    throw new Error('Invalid file path: must be relative');
  }
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..')) {
    throw new Error('Invalid file path: must not traverse above repository root');
  }
  if (filePath.includes('\0')) {
    throw new Error('Invalid file path: must not contain null bytes');
  }
}

function gitExec(args: string[], cwd: string, timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeExecFile('git', args, { cwd, encoding: 'utf-8', timeout }, (error, stdout, stderr) => {
      if (error) {
        (error as any).stderr = stderr;
        reject(error);
      } else {
        resolve(stdout as string);
      }
    });
  });
}

/** Extract a human-readable error message from a git command failure. */
function extractGitError(err: unknown): string {
  const e = err as any;
  return (e?.stderr?.toString?.() || e?.message || 'Unknown error').trim();
}

/** Format the command prefix used in log messages (e.g. "git rev-parse --abbrev-ref"). */
function formatCmd(args: string[]): string {
  return `git ${args.slice(0, 2).join(' ')}`;
}

async function runResult(args: string[], cwd: string, timeout = 30000): Promise<GitOpResult> {
  try {
    const output = await gitExec(args, cwd, timeout);
    return { ok: true, message: output.trim() };
  } catch (err: unknown) {
    const msg = extractGitError(err);
    appLog('core:git', 'warn', 'Git operation failed', {
      meta: { cmd: formatCmd(args), cwd, error: msg },
    });
    return { ok: false, message: msg };
  }
}

async function run(args: string[], cwd: string): Promise<string> {
  const result = await runResult(args, cwd);
  return result.ok ? result.message : '';
}

/**
 * Check whether a directory is inside a git work tree.
 * Uses `git rev-parse --is-inside-work-tree` which naturally walks up parent
 * directories, so a project that is a subfolder of a repo is correctly detected.
 */
export async function isInsideGitRepo(dirPath: string): Promise<boolean> {
  try {
    const out = await gitExec(['rev-parse', '--is-inside-work-tree'], dirPath);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

export async function getGitInfo(dirPath: string): Promise<GitInfo> {
  const hasGit = await isInsideGitRepo(dirPath);
  if (!hasGit) {
    return { branch: '', branches: [], status: [], log: [], hasGit: false, ahead: 0, behind: 0, remote: '', stashCount: 0, hasConflicts: false };
  }

  // Run independent git commands in parallel
  const [branchRaw, branchesRaw, statusRaw, logRaw, remoteRaw, stashRaw] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD'], dirPath),
    run(['branch', '--no-color'], dirPath),
    run(['status', '--porcelain', '-uall'], dirPath),
    run(['log', '--oneline', '--format=%H|||%h|||%s|||%an|||%ar', '-20'], dirPath),
    run(['remote'], dirPath),
    run(['stash', 'list'], dirPath),
  ]);

  const branch = branchRaw || 'HEAD';

  const branches = branchesRaw
    .split('\n')
    .map((b) => b.replace(/^\*?\s+/, '').trim())
    .filter(Boolean);

  let hasConflicts = false;
  const status: GitStatusFile[] = statusRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const staged = line[0] !== ' ' && line[0] !== '?';
      const statusCode = line.slice(0, 2).trim();
      let filePath = line.slice(3);
      let origPath: string | undefined;

      // Renames show as "R  old-name -> new-name"
      if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
        const arrowIdx = filePath.indexOf(' -> ');
        if (arrowIdx !== -1) {
          origPath = filePath.slice(0, arrowIdx);
          filePath = filePath.slice(arrowIdx + 4);
        }
      }

      if (CONFLICT_CODES.has(statusCode)) {
        hasConflicts = true;
      }

      return { path: filePath, status: statusCode, staged, ...(origPath ? { origPath } : {}) };
    });

  const log: GitLogEntry[] = logRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, subject, author, date] = line.split('|||');
      return { hash, shortHash, subject, author, date };
    });

  // Remote tracking info
  const remote = remoteRaw.split('\n')[0] || '';
  let ahead = 0;
  let behind = 0;
  if (remote) {
    const abRaw = await run(['rev-list', '--left-right', '--count', `${remote}/${branch}...HEAD`], dirPath);
    if (abRaw) {
      const parts = abRaw.split(/\s+/);
      behind = parseInt(parts[0], 10) || 0;
      ahead = parseInt(parts[1], 10) || 0;
    }
  }

  // Stash count
  const stashCount = stashRaw ? stashRaw.split('\n').filter(Boolean).length : 0;

  return { branch, branches, status, log, hasGit, ahead, behind, remote, stashCount, hasConflicts };
}

export async function checkout(dirPath: string, branchName: string): Promise<GitOpResult> {
  validateBranchName(branchName);
  return runResult(['checkout', branchName], dirPath);
}

export async function stage(dirPath: string, filePath: string): Promise<GitOpResult> {
  validateFilePath(filePath);
  return runResult(['add', '--', filePath], dirPath);
}

export async function unstage(dirPath: string, filePath: string): Promise<GitOpResult> {
  validateFilePath(filePath);
  return runResult(['reset', 'HEAD', '--', filePath], dirPath);
}

export async function commit(dirPath: string, message: string): Promise<GitOpResult> {
  return runResult(['commit', '-m', message], dirPath);
}

export async function push(dirPath: string): Promise<GitOpResult> {
  const info = await getGitInfo(dirPath);
  if (!info.remote) {
    return { ok: false, message: 'No remote configured' };
  }
  return runResult(['push', info.remote, info.branch], dirPath);
}

export async function getFileDiff(
  dirPath: string,
  filePath: string,
  staged: boolean
): Promise<{ original: string; modified: string }> {
  validateFilePath(filePath);

  // Get the HEAD version (empty for new/untracked files)
  let original = '';
  try {
    original = await gitExec(['show', `HEAD:${filePath}`], dirPath);
  } catch {
    // File doesn't exist in HEAD (new/untracked) — leave empty
  }

  let modified = '';
  if (staged) {
    // Staged version from the index
    try {
      modified = await gitExec(['show', `:${filePath}`], dirPath);
    } catch {
      modified = '';
    }
  } else {
    // Working tree version from disk
    try {
      modified = await fs.promises.readFile(path.join(dirPath, filePath), 'utf-8');
    } catch {
      modified = '';
    }
  }

  return { original, modified };
}

export async function pull(dirPath: string): Promise<GitOpResult> {
  const info = await getGitInfo(dirPath);
  if (!info.remote) {
    return { ok: false, message: 'No remote configured' };
  }
  return runResult(['pull', info.remote, info.branch], dirPath);
}

export async function stageAll(dirPath: string): Promise<GitOpResult> {
  return runResult(['add', '-A'], dirPath);
}

export async function unstageAll(dirPath: string): Promise<GitOpResult> {
  return runResult(['reset', 'HEAD'], dirPath);
}

export async function discardFile(dirPath: string, filePath: string, isUntracked: boolean): Promise<GitOpResult> {
  validateFilePath(filePath);
  if (isUntracked) {
    // Remove untracked file from disk
    try {
      await fs.promises.unlink(path.join(dirPath, filePath));
      return { ok: true, message: 'Deleted untracked file' };
    } catch (err: any) {
      return { ok: false, message: err?.message || 'Failed to delete file' };
    }
  }
  return runResult(['restore', '--', filePath], dirPath);
}

export async function createBranch(dirPath: string, branchName: string): Promise<GitOpResult> {
  validateBranchName(branchName);
  return runResult(['checkout', '-b', branchName], dirPath);
}

export async function stash(dirPath: string): Promise<GitOpResult> {
  return runResult(['stash'], dirPath);
}

export async function stashPop(dirPath: string): Promise<GitOpResult> {
  return runResult(['stash', 'pop'], dirPath);
}

/** Validate that a string looks like a hex commit hash (short or full). */
function validateCommitHash(hash: string): void {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
    throw new Error(`Invalid commit hash: must be 4-40 hex characters`);
  }
}

/**
 * Get paginated git log with optional offset.
 * Returns an array of GitLogEntry objects.
 */
export async function getLog(
  dirPath: string,
  limit: number = 50,
  offset: number = 0,
): Promise<GitLogEntry[]> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const safeOffset = Math.max(0, offset);
  const raw = await run(
    ['log', '--format=%H|||%h|||%s|||%an|||%ar', `-${safeLimit}`, `--skip=${safeOffset}`, '-M'],
    dirPath,
  );
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, subject, author, date] = line.split('|||');
      return { hash, shortHash, subject, author, date };
    });
}

/**
 * Show the files changed in a specific commit.
 * Returns a GitCommitDetail with the list of affected files.
 */
export async function showCommit(dirPath: string, hash: string): Promise<GitCommitDetail> {
  validateCommitHash(hash);
  const raw = await run(
    ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', hash],
    dirPath,
  );
  const files: GitCommitFileEntry[] = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0];
      if (status.startsWith('R') || status.startsWith('C')) {
        return { status, origPath: parts[1], path: parts[2] || parts[1] };
      }
      return { status, path: parts[1] || '' };
    });
  return { hash, files };
}

/**
 * Get the diff of a single file within a specific commit.
 * Returns the before/after content for use in a diff editor.
 */
export async function getCommitFileDiff(
  dirPath: string,
  hash: string,
  filePath: string,
): Promise<{ original: string; modified: string }> {
  validateCommitHash(hash);
  validateFilePath(filePath);

  let original = '';
  try {
    original = await gitExec(['show', `${hash}^:${filePath}`], dirPath);
  } catch {
    // File didn't exist before this commit
  }

  let modified = '';
  try {
    modified = await gitExec(['show', `${hash}:${filePath}`], dirPath);
  } catch {
    // File was deleted in this commit
  }

  return { original, modified };
}

/**
 * List git worktrees for a repository.
 * Returns the main worktree plus any linked worktrees.
 */
export async function listWorktrees(dirPath: string): Promise<GitWorktreeEntry[]> {
  const output = await gitExec(['worktree', 'list', '--porcelain'], dirPath);
  const entries: GitWorktreeEntry[] = [];
  let current: Partial<GitWorktreeEntry> = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length);
    } else if (line === 'bare') {
      current.isBare = true;
    } else if (line.startsWith('branch ')) {
      // branch refs/heads/main → main
      const ref = line.slice('branch '.length);
      current.branch = ref.replace('refs/heads/', '');
    } else if (line === '') {
      // Empty line terminates a worktree block
      if (current.path) {
        const wtPath = current.path;
        const segments = wtPath.replace(/\/+$/, '').split('/');
        entries.push({
          path: wtPath,
          label: segments[segments.length - 1] || wtPath,
          branch: current.branch || '',
          isBare: current.isBare || false,
        });
      }
      current = {};
    }
  }

  return entries;
}
