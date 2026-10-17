import { execFile as nodeExecFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitInfo, GitStatusFile, GitLogEntry, GitOpResult, GitWorktreeEntry, GitCommitDetail, GitCommitFileEntry } from '../../shared/types';
import { appLog } from './log-service';
import { replaySpan, tel } from '../telemetry/facade';
import { classifyGitFailure, type GitFailure } from '../telemetry/workspace';
import { ATTR, countBucket, type GitOp, type SpanName } from '../../shared/telemetry/attributes';

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

function gitExec(args: string[], cwd: string, timeout = 10000, op: GitOp = 'other'): Promise<string> {
  const startMs = Date.now();
  return new Promise((resolve, reject) => {
    nodeExecFile('git', args, { cwd, encoding: 'utf-8', timeout }, (error, stdout, stderr) => {
      tel.count('clubhouse.git.subprocess.duration', (Date.now() - startMs) / 1000, [ATTR.gitOp(op)]);
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

/** A git result plus, on failure, its local classification for telemetry. */
interface Attempt<T> {
  value: T;
  failure?: GitFailure;
}

async function runResultDetailed(args: string[], cwd: string, timeout = 30000, op: GitOp = 'other'): Promise<Attempt<GitOpResult>> {
  try {
    const output = await gitExec(args, cwd, timeout, op);
    return { value: { ok: true, message: output.trim() } };
  } catch (err: unknown) {
    const msg = extractGitError(err);
    appLog('core:git', 'warn', 'Git operation failed', {
      meta: { cmd: formatCmd(args), cwd, error: msg },
    });
    return { value: { ok: false, message: msg }, failure: classifyGitFailure(err) };
  }
}

async function run(args: string[], cwd: string, op: GitOp = 'other'): Promise<string> {
  const { value } = await runResultDetailed(args, cwd, undefined, op);
  return value.ok ? value.message : '';
}

/**
 * A user-initiated git operation as a `clubhouse.git.<op>` span (spec §4.8).
 * Failures returned as values are classified from the attempt; thrown errors
 * (validation, spawn failures) are classified, recorded and rethrown
 * unchanged, so callers see exactly what they saw before.
 */
async function gitOp<T>(op: GitOp, fn: () => Promise<Attempt<T>>): Promise<T> {
  let failure: GitFailure | undefined;
  let threw = false;
  let thrown: unknown;
  const value = await tel.flow(`clubhouse.git.${op}` as SpanName, { attrs: [ATTR.gitOp(op)] }, async (span) => {
    try {
      const attempt = await fn();
      failure = attempt.failure;
      return attempt.value;
    } catch (err) {
      threw = true;
      thrown = err;
      failure = err instanceof Error && /^Invalid (branch name|file path|commit hash)/.test(err.message)
        ? { errorType: 'validation', timedOut: false }
        : classifyGitFailure(err);
      return undefined as T;
    } finally {
      if (failure) {
        span.set(ATTR.gitTimedOut(failure.timedOut));
        if (failure.exitCode !== undefined) span.set(ATTR.exitCode(failure.exitCode));
      }
    }
  }, { classify: () => (failure ? { error: failure.errorType } : 'ok') });
  if (threw) throw thrown;
  return value;
}

function opRun(op: GitOp, args: string[], cwd: string): Promise<GitOpResult> {
  return gitOp(op, () => runResultDetailed(args, cwd, undefined, op));
}

const noRemote = (): Attempt<GitOpResult> => ({
  value: { ok: false, message: 'No remote configured' },
  failure: { errorType: 'no_remote', timedOut: false },
});

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

/**
 * Polled every few seconds per git widget. Never a span (spec §4.8): a
 * duration histogram bucketed by changed-file count, a poll counter, and a
 * Detailed-level exemplar span only when one poll takes over 2 s.
 */
export async function getGitInfo(dirPath: string): Promise<GitInfo> {
  const startMs = Date.now();
  const info = await readGitInfo(dirPath);
  const endMs = Date.now();
  const files = [ATTR.gitStatusFileCount(countBucket(info.status.length))];
  tel.count('clubhouse.git.status.polls');
  tel.count('clubhouse.git.status.duration', (endMs - startMs) / 1000, files);
  if (endMs - startMs > SLOW_STATUS_MS) {
    replaySpan({ name: 'clubhouse.git.status.slow', startMs, endMs, attrs: files, outcome: 'ok' });
  }
  return info;
}

const SLOW_STATUS_MS = 2000;

async function readGitInfo(dirPath: string): Promise<GitInfo> {
  const hasGit = await isInsideGitRepo(dirPath);
  if (!hasGit) {
    return { branch: '', branches: [], status: [], log: [], hasGit: false, ahead: 0, behind: 0, remote: '', stashCount: 0, hasConflicts: false };
  }

  // Run independent git commands in parallel
  const [branchRaw, branchesRaw, statusRaw, logRaw, remoteRaw, stashRaw] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD'], dirPath, 'status'),
    run(['branch', '--no-color'], dirPath, 'status'),
    run(['status', '--porcelain', '-uall'], dirPath, 'status'),
    run(['log', '--oneline', '--format=%H|||%h|||%s|||%an|||%ar', '-20'], dirPath, 'status'),
    run(['remote'], dirPath, 'status'),
    run(['stash', 'list'], dirPath, 'status'),
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
    const abRaw = await run(['rev-list', '--left-right', '--count', `${remote}/${branch}...HEAD`], dirPath, 'status');
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
  return gitOp('checkout', () => {
    validateBranchName(branchName);
    return runResultDetailed(['checkout', branchName], dirPath, undefined, 'checkout');
  });
}

export async function stage(dirPath: string, filePath: string): Promise<GitOpResult> {
  return gitOp('stage', () => {
    validateFilePath(filePath);
    return runResultDetailed(['add', '--', filePath], dirPath, undefined, 'stage');
  });
}

export async function unstage(dirPath: string, filePath: string): Promise<GitOpResult> {
  return gitOp('unstage', () => {
    validateFilePath(filePath);
    return runResultDetailed(['reset', 'HEAD', '--', filePath], dirPath, undefined, 'unstage');
  });
}

export async function commit(dirPath: string, message: string): Promise<GitOpResult> {
  return opRun('commit', ['commit', '-m', message], dirPath);
}

export async function push(dirPath: string): Promise<GitOpResult> {
  return gitOp('push', async () => {
    const info = await readGitInfo(dirPath);
    if (!info.remote) return noRemote();
    return runResultDetailed(['push', info.remote, info.branch], dirPath, undefined, 'push');
  });
}

export async function getFileDiff(
  dirPath: string,
  filePath: string,
  staged: boolean
): Promise<{ original: string; modified: string }> {
  return gitOp('diff', async () => ({ value: await readFileDiff(dirPath, filePath, staged) }));
}

async function readFileDiff(
  dirPath: string,
  filePath: string,
  staged: boolean
): Promise<{ original: string; modified: string }> {
  validateFilePath(filePath);

  // Get the HEAD version (empty for new/untracked files)
  let original = '';
  try {
    original = await gitExec(['show', `HEAD:${filePath}`], dirPath, undefined, 'diff');
  } catch {
    // File doesn't exist in HEAD (new/untracked) — leave empty
  }

  let modified = '';
  if (staged) {
    // Staged version from the index
    try {
      modified = await gitExec(['show', `:${filePath}`], dirPath, undefined, 'diff');
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
  return gitOp('pull', async () => {
    const info = await readGitInfo(dirPath);
    if (!info.remote) return noRemote();
    return runResultDetailed(['pull', info.remote, info.branch], dirPath, undefined, 'pull');
  });
}

export async function stageAll(dirPath: string): Promise<GitOpResult> {
  return opRun('stage_all', ['add', '-A'], dirPath);
}

export async function unstageAll(dirPath: string): Promise<GitOpResult> {
  return opRun('unstage_all', ['reset', 'HEAD'], dirPath);
}

export async function discardFile(dirPath: string, filePath: string, isUntracked: boolean): Promise<GitOpResult> {
  return gitOp('discard', async () => {
    validateFilePath(filePath);
    if (isUntracked) {
      // Remove untracked file from disk
      try {
        await fs.promises.unlink(path.join(dirPath, filePath));
        return { value: { ok: true, message: 'Deleted untracked file' } };
      } catch (err: any) {
        // A filesystem error, not a git exit; the span still records the failure.
        return { value: { ok: false, message: err?.message || 'Failed to delete file' }, failure: { errorType: 'nonzero_exit', timedOut: false } };
      }
    }
    return runResultDetailed(['restore', '--', filePath], dirPath, undefined, 'discard');
  });
}

export async function createBranch(dirPath: string, branchName: string): Promise<GitOpResult> {
  return gitOp('create_branch', () => {
    validateBranchName(branchName);
    return runResultDetailed(['checkout', '-b', branchName], dirPath, undefined, 'create_branch');
  });
}

export async function stash(dirPath: string): Promise<GitOpResult> {
  return opRun('stash', ['stash'], dirPath);
}

export async function stashPop(dirPath: string): Promise<GitOpResult> {
  return opRun('stash_pop', ['stash', 'pop'], dirPath);
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
  return gitOp('show_commit', async () => ({ value: await readCommit(dirPath, hash) }));
}

async function readCommit(dirPath: string, hash: string): Promise<GitCommitDetail> {
  validateCommitHash(hash);
  const raw = await run(
    ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', hash],
    dirPath,
    'show_commit',
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
  return gitOp('diff', async () => ({ value: await readCommitFileDiff(dirPath, hash, filePath) }));
}

async function readCommitFileDiff(
  dirPath: string,
  hash: string,
  filePath: string,
): Promise<{ original: string; modified: string }> {
  validateCommitHash(hash);
  validateFilePath(filePath);

  let original = '';
  try {
    original = await gitExec(['show', `${hash}^:${filePath}`], dirPath, undefined, 'diff');
  } catch {
    // File didn't exist before this commit
  }

  let modified = '';
  try {
    modified = await gitExec(['show', `${hash}:${filePath}`], dirPath, undefined, 'diff');
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
  return gitOp('worktree_list', async () => ({ value: await readWorktrees(dirPath) }));
}

async function readWorktrees(dirPath: string): Promise<GitWorktreeEntry[]> {
  const output = await gitExec(['worktree', 'list', '--porcelain'], dirPath, undefined, 'worktree_list');
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
