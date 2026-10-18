import { execFile as nodeExecFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitInfo, GitStatusFile, GitLogEntry, GitOpResult, GitWorktreeEntry, GitCommitDetail, GitCommitFileEntry, GitNumstatEntry } from '../../shared/types';
import type { ChangedFile } from '../../shared/chat-checkpoints';
import type { BranchChanges, BranchFilePatch, BranchFileStatus, PullRequestInfo } from '../../shared/git-branch';
import { getShellEnvironment } from '../util/shell';
import { appLog } from './log-service';
import { isTelemetryActive, replaySpan, tel } from '../telemetry/facade';
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

/** Remote names come from the repo's own config; one starting with '-' would be read as an option. */
function validateRemoteName(name: string): void {
  if (!name || name.startsWith('-') || name.includes('\0') || /\s/.test(name)) {
    throw new Error('Invalid remote name');
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

function gitExec(args: string[], cwd: string, timeout = 10000, op: GitOp = 'other', maxBuffer?: number): Promise<string> {
  const startMs = Date.now();
  return new Promise((resolve, reject) => {
    nodeExecFile('git', args, { cwd, encoding: 'utf-8', timeout, ...(maxBuffer ? { maxBuffer } : {}) }, (error, stdout, stderr) => {
      if (isTelemetryActive()) tel.count('clubhouse.git.subprocess.duration', (Date.now() - startMs) / 1000, [ATTR.gitOp(op)]);
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
  if (!isTelemetryActive()) return readGitInfo(dirPath);
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
    validateRemoteName(info.remote);
    validateBranchName(info.branch);
    return runResultDetailed(['push', '--', info.remote, info.branch], dirPath, undefined, 'push');
  });
}

/**
 * Push HEAD and set its upstream, so a new agent branch can be pushed and a
 * pull request opened (#2032). It pushes to the same remote the review's
 * pull request status reads (resolvePushRemote).
 */
export async function pushUpstream(dirPath: string): Promise<GitOpResult> {
  return gitOp('push', async () => {
    const branch = (await tryGitExec(['rev-parse', '--abbrev-ref', 'HEAD'], dirPath, 'push')) ?? '';
    if (!branch || branch === 'HEAD') {
      return { value: { ok: false, message: 'HEAD is detached. Check out a branch to push it.' }, failure: { errorType: 'validation', timedOut: false } };
    }
    validateBranchName(branch);
    const remote = await resolvePushRemote(dirPath, branch);
    if (!remote) return noRemote();
    return runResultDetailed(['push', '--set-upstream', '--', remote, 'HEAD'], dirPath, 60_000, 'push');
  });
}

/**
 * The remote a branch pushes to: its upstream's remote when set, else
 * origin, else the only remote. Null when there's none, or several and none
 * of them is origin.
 */
export async function resolvePushRemote(dirPath: string, branch?: string): Promise<string | null> {
  const remotes = ((await tryGitExec(['remote'], dirPath, 'pr_info')) ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  if (remotes.length === 0) return null;
  let pick: string | undefined;
  if (branch && !branch.startsWith('-')) {
    const upstream = await tryGitExec(['config', '--get', `branch.${branch}.remote`], dirPath, 'pr_info');
    if (upstream && remotes.includes(upstream)) pick = upstream;
  }
  pick ??= remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
  if (!pick) return null;
  validateRemoteName(pick);
  return pick;
}

/**
 * A file's `original` (at `base`, default HEAD) and `modified` (index when
 * `staged`, else the working tree) contents. A run monitor passes the sha the
 * run started from, so commits the run made show in the diff.
 */
export async function getFileDiff(
  dirPath: string,
  filePath: string,
  staged: boolean,
  base?: string,
): Promise<{ original: string; modified: string }> {
  return gitOp('diff', async () => ({ value: await readFileDiff(dirPath, filePath, staged, base) }));
}

async function readFileDiff(
  dirPath: string,
  filePath: string,
  staged: boolean,
  base?: string,
): Promise<{ original: string; modified: string }> {
  validateFilePath(filePath);
  const ref = base || 'HEAD';
  if (ref.startsWith('-') || ref.includes(':') || ref.includes('\0')) throw new Error(`Invalid base: ${ref}`);

  // The version at the base (empty for files added since)
  let original = '';
  try {
    original = await gitExec(['show', `${ref}:${filePath}`], dirPath, undefined, 'diff');
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
    validateRemoteName(info.remote);
    validateBranchName(info.branch);
    return runResultDetailed(['pull', '--', info.remote, info.branch], dirPath, undefined, 'pull');
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

// ── Run diff stats (headless run monitor, #2033) ───────────────────────────

/**
 * HEAD commit sha of the repository containing `dirPath`, or null when it is
 * not a repository or has no commits yet.
 */
export async function getHeadSha(dirPath: string): Promise<string | null> {
  try {
    const sha = (await gitExec(['rev-parse', '--verify', 'HEAD'], dirPath, undefined, 'head_sha')).trim();
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
  } catch {
    // telemetry-exempt: not a repo or no commits yet; null is the answer.
    return null;
  }
}

/**
 * Parse `git diff --numstat -z` output.
 *
 * Records are NUL-terminated. A plain record is `added\tremoved\tpath`; a
 * rename or copy is `added\tremoved\t` followed by the old and new paths as
 * two more NUL-terminated fields. Binary files report `-\t-`.
 */
export function parseNumstatZ(output: string): GitNumstatEntry[] {
  const fields = output.split('\0');
  const entries: GitNumstatEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const field = fields[i++];
    if (!field) continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(field);
    if (!match) continue;
    const [, addedRaw, removedRaw, inlinePath] = match;
    let filePath = inlinePath;
    if (!filePath) {
      // Rename or copy: the old path, then the new path.
      i++;
      filePath = fields[i++] ?? '';
    }
    if (!filePath) continue;
    const binary = addedRaw === '-' || removedRaw === '-';
    entries.push({
      path: filePath,
      added: binary ? 0 : parseInt(addedRaw, 10),
      removed: binary ? 0 : parseInt(removedRaw, 10),
      binary,
    });
  }
  return entries;
}

/** Untracked files larger than this are reported as binary without reading them. */
const UNTRACKED_MAX_BYTES = 1024 * 1024;
/** Upper bound on untracked files listed per call, so a stray build dir can't stall it. */
const UNTRACKED_MAX_FILES = 1000;
/** Upper bound on untracked files actually read per call (the monitor polls every 2s); the rest list without counts. */
const UNTRACKED_MAX_READS = 200;
/** numstat and ls-files output in a big repo can pass execFile's 1 MB default. */
const NUMSTAT_MAX_BUFFER = 16 * 1024 * 1024;
/** Line counts of untracked files by path, reused while size and mtime are unchanged. */
const untrackedCache = new Map<string, { size: number; mtimeMs: number; added: number; binary: boolean }>();
const UNTRACKED_CACHE_MAX = 4000;

/**
 * Line count of an untracked file's contents, where every line is an
 * addition. Content containing a NUL byte is treated as binary.
 */
export function countUntrackedLines(content: Uint8Array): { added: number; binary: boolean } {
  if (content.includes(0)) return { added: 0, binary: true };
  if (content.length === 0) return { added: 0, binary: false };
  let lines = 0;
  for (const byte of content) if (byte === 0x0a) lines++;
  if (content[content.length - 1] !== 0x0a) lines++;
  return { added: lines, binary: false };
}

/**
 * Line counts for one untracked file. Never follows a link out of the
 * worktree: a symlink counts as 0 lines without being read, and a path whose
 * real location is outside `rootReal` (through a linked directory) is skipped.
 */
async function untrackedEntry(root: string, rootReal: string, relPath: string, budget: { reads: number }): Promise<GitNumstatEntry> {
  const none = { path: relPath, added: 0, removed: 0, binary: false };
  try {
    const full = path.join(root, relPath);
    const stat = await fs.promises.lstat(full);
    if (stat.isSymbolicLink()) return none;
    const real = await fs.promises.realpath(full);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return none;
    if (!stat.isFile() || stat.size > UNTRACKED_MAX_BYTES) {
      return { path: relPath, added: 0, removed: 0, binary: stat.isFile() };
    }
    const cached = untrackedCache.get(full);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return { path: relPath, added: cached.added, removed: 0, binary: cached.binary };
    }
    if (budget.reads <= 0) return { path: relPath, added: 0, removed: 0, binary: false };
    budget.reads--;
    const { added, binary } = countUntrackedLines(await fs.promises.readFile(full));
    if (untrackedCache.size >= UNTRACKED_CACHE_MAX) untrackedCache.delete(untrackedCache.keys().next().value as string);
    untrackedCache.set(full, { size: stat.size, mtimeMs: stat.mtimeMs, added, binary });
    return { path: relPath, added, removed: 0, binary };
  } catch {
    // telemetry-exempt: the file vanished or is unreadable; list it without counts.
    return { path: relPath, added: 0, removed: 0, binary: false };
  }
}

/**
 * Per-file line counts for everything that differs from `base` (default
 * HEAD): `git diff --numstat` of the working tree against `base`, so commits
 * made since `base` and uncommitted edits both count, plus untracked files
 * with every line an addition. Paths are relative to the repository root.
 * Returns [] when `dirPath` is not a repository or git fails.
 */
export async function getDiffNumstat(dirPath: string, base?: string): Promise<GitNumstatEntry[]> {
  const ref = base || 'HEAD';
  if (ref.startsWith('-') || ref.includes('\0')) return [];
  try {
    // Run from the top level so ls-files lists the whole repo and both
    // commands report root-relative paths.
    const root = (await gitExec(['rev-parse', '--show-toplevel'], dirPath, undefined, 'diff_numstat')).trim();
    if (!root) return [];
    const [diffRaw, untrackedRaw] = await Promise.all([
      gitExec(['diff', '--numstat', '-z', ref, '--'], root, undefined, 'diff_numstat', NUMSTAT_MAX_BUFFER),
      gitExec(['ls-files', '--others', '--exclude-standard', '-z'], root, undefined, 'diff_numstat', NUMSTAT_MAX_BUFFER),
    ]);
    const entries = parseNumstatZ(diffRaw);
    const seen = new Set(entries.map((e) => e.path));
    const untracked = untrackedRaw.split('\0').filter((p) => p && !seen.has(p)).slice(0, UNTRACKED_MAX_FILES);
    const budget = { reads: UNTRACKED_MAX_READS };
    const rootReal = untracked.length ? await fs.promises.realpath(root) : root;
    // Sequential so the read budget is honoured; cached files cost one stat each.
    for (const p of untracked) entries.push(await untrackedEntry(root, rootReal, p, budget));
    return entries;
  } catch {
    // telemetry-exempt: polled diff stats; not a repo or a bad base means no stats.
    return [];
  }
}

// ── An agent's branch against main (Agent details, #2032) ──────────────────

/** A base the caller may pass: a ref name, never an option or a path spec. */
function validateBaseRef(ref: string): void {
  if (!ref || ref.startsWith('-') || ref.includes('\0') || ref.includes(':') || ref.includes('..')) {
    throw new Error(`Invalid base: ${ref}`);
  }
}

async function tryGitExec(args: string[], cwd: string, op: GitOp): Promise<string | null> {
  try {
    return (await gitExec(args, cwd, undefined, op)).trim();
  } catch {
    // telemetry-exempt: a probe (a ref, a merge base); failing just means it isn't there.
    return null;
  }
}

/**
 * The commit an agent's branch left the project's main line at, and that
 * line's short name. Agent worktrees branch from the root's HEAD, so a local
 * main is often behind origin's; the merge base is taken against both and
 * the newer one wins, so origin's later commits never count as the agent's
 * work. origin's default branch (origin/HEAD) names the line when known.
 */
export async function resolveMergeBase(root: string, base?: string): Promise<{ name: string; sha: string } | null> {
  const op: GitOp = 'branch_changes';
  let names: string[];
  if (base) {
    validateBaseRef(base);
    names = [base.replace(/^origin\//, '')];
  } else {
    const originHead = await tryGitExec(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root, op);
    names = originHead ? [originHead.replace(/^origin\//, '')] : ['main', 'master'];
  }
  for (const name of names) {
    const refs = [`refs/remotes/origin/${name}`, `refs/heads/${name}`];
    const bases = (await Promise.all(refs.map((r) => tryGitExec(['merge-base', 'HEAD', r], root, op)))).filter((s): s is string => !!s);
    if (bases.length === 0) continue;
    let sha = bases[0];
    if (bases.length === 2 && bases[0] !== bases[1]) {
      // The descendant of the two is the newer point on the main line.
      const firstIsOlder = (await tryGitExec(['merge-base', '--is-ancestor', bases[0], bases[1]], root, op)) !== null;
      sha = firstIsOlder ? bases[1] : bases[0];
    }
    return { name, sha };
  }
  return null;
}

/** Statuses from `git diff --name-status -z` (no rename detection, like the numstat it pairs with). */
function parseNameStatusZ(raw: string): Map<string, BranchFileStatus> {
  const map = new Map<string, BranchFileStatus>();
  const parts = raw.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i];
    if (!code) { i--; continue; }
    map.set(parts[i + 1], code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified');
  }
  return map;
}

/** Concurrent reads of the same folder share one run (several panes, quick refreshes). */
const branchInFlight = new Map<string, Promise<BranchChanges>>();

/**
 * Files an agent's branch changed since it left main: committed,
 * uncommitted and untracked, with line counts from getDiffNumstat (which
 * caps and budgets untracked reads). Paths are relative to the repo root.
 */
export function getBranchChanges(dirPath: string, base?: string, counts = false): Promise<BranchChanges> {
  const key = `${dirPath}\0${base ?? ''}\0${counts ? 1 : 0}`;
  const running = branchInFlight.get(key);
  if (running) return running;
  const run = readBranchChanges(dirPath, base, counts).finally(() => branchInFlight.delete(key));
  branchInFlight.set(key, run);
  return run;
}

/** `counts` also reads how many commits the branch has and how many files are uncommitted (the review and project page). */
async function readBranchChanges(dirPath: string, base: string | undefined, counts: boolean): Promise<BranchChanges> {
  const op: GitOp = 'branch_changes';
  const root = await tryGitExec(['rev-parse', '--show-toplevel'], dirPath, op);
  if (!root) return { available: false, files: [] };
  const head = await tryGitExec(['rev-parse', '--abbrev-ref', 'HEAD'], root, op);
  // A detached HEAD shows as its short sha.
  const branch = head && head !== 'HEAD' ? head : (await tryGitExec(['rev-parse', '--short', 'HEAD'], root, op)) ?? undefined;
  const resolved = await resolveMergeBase(root, base);
  if (!resolved) return { available: true, branch, files: [], noBase: true };
  const [numstat, nameStatus] = await Promise.all([
    getDiffNumstat(root, resolved.sha),
    gitExec(['diff', '--no-ext-diff', '--no-color', '--name-status', '-z', resolved.sha, '--'], root, undefined, op, NUMSTAT_MAX_BUFFER).catch(() => ''),
  ]);
  const statuses = parseNameStatusZ(nameStatus);
  const files: ChangedFile[] = numstat
    .map((e) => ({ path: e.path, status: statuses.get(e.path) ?? 'added', additions: e.added, deletions: e.removed, binary: e.binary }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const out: BranchChanges = { available: true, branch, base: resolved.name, mergeBase: resolved.sha, files };
  if (counts) {
    const [ahead, dirty] = await Promise.all([
      tryGitExec(['rev-list', '--count', `${resolved.sha}..HEAD`], root, op),
      gitExec(['status', '--porcelain', '-z', '--untracked-files=normal'], root, undefined, op, NUMSTAT_MAX_BUFFER).catch(() => ''),
    ]);
    out.ahead = Number(ahead) || 0;
    // -z puts a rename's old path in its own field, with no status letters in front.
    out.uncommitted = dirty.split('\0').filter((e) => /^[ MTADRCU?!]{2} /.test(e)).length;
  }
  return out;
}

/** The branch's own commits since it left the main line, newest first (the Changes review). */
export async function getBranchLog(dirPath: string, base?: string, limit = 100): Promise<GitLogEntry[]> {
  const op: GitOp = 'branch_log';
  const root = await tryGitExec(['rev-parse', '--show-toplevel'], dirPath, op);
  if (!root) return [];
  const resolved = await resolveMergeBase(root, base);
  if (!resolved) return [];
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  const raw = await gitExec(['log', `-${n}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1e', `${resolved.sha}..HEAD`], root, undefined, op);
  return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [hash, shortHash, subject, author, date] = r.split('\x1f');
    return { hash, shortHash, subject, author, date };
  });
}

/**
 * Turn a GitHub remote URL into "owner/repo": https://github.com/o/r(.git),
 * git@github.com:o/r(.git) or ssh://git@github.com/o/r(.git). Null for any
 * other host or shape; owner and repo are limited to [\w.-].
 */
export function githubRepoOf(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * Whether `url` is a GitHub pull request or compare page of `repo`
 * ("owner/repo"), the only pages the review opens.
 */
export function isPullRequestUrlFor(url: string, repo: string): boolean {
  return pullRequestHref(url, repo) !== null;
}

/** The normalized href of a GitHub pull request or compare page of `repo`, or null for anything else. */
function pullRequestHref(url: string, repo: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // telemetry-exempt: not a URL at all; the caller refuses it as a validation failure, which its span records.
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password || u.port) return null;
  const [owner, name, kind, ...rest] = u.pathname.split('/').filter(Boolean);
  const [wantOwner, wantName] = repo.split('/');
  if (!owner || !name || owner.toLowerCase() !== wantOwner.toLowerCase() || name.toLowerCase() !== wantName.toLowerCase()) return null;
  const ok = kind === 'pull' ? rest.length >= 1 && /^\d+$/.test(rest[0]) : kind === 'compare' && rest.length >= 1;
  return ok ? u.href : null;
}

/**
 * Open the branch's pull request page (#2032) after checking it belongs to
 * this repo's GitHub remote, so a URL from gh or the renderer can't send the
 * browser elsewhere. `open` is shell.openExternal, passed in by the handler.
 */
export async function openPullRequest(dirPath: string, url: string, open: (url: string) => Promise<void>): Promise<GitOpResult> {
  return gitOp<GitOpResult>('open_pr', async () => {
    // The same remote getPullRequestInfo built the URL from: the branch's upstream first.
    const branch = await tryGitExec(['rev-parse', '--abbrev-ref', 'HEAD'], dirPath, 'open_pr');
    const remote = await resolvePushRemote(dirPath, branch && branch !== 'HEAD' ? branch : undefined);
    const remoteUrl = remote ? await tryGitExec(['remote', 'get-url', '--', remote], dirPath, 'open_pr') : null;
    const repo = remoteUrl ? githubRepoOf(remoteUrl) : null;
    const href = repo ? pullRequestHref(url, repo) : null;
    if (!href) {
      return { value: { ok: false, message: 'That page isn\u2019t this repository\u2019s pull request on GitHub.' }, failure: { errorType: 'validation', timedOut: false } };
    }
    // The parsed, normalized URL, never the raw string that was checked.
    await open(href);
    return { value: { ok: true, message: '' } };
  });
}

function ghExec(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    nodeExecFile('gh', args, { cwd, encoding: 'utf-8', timeout: 10_000, env: getShellEnvironment() }, (err, stdout) => {
      // telemetry-exempt: gh is optional; without it (or signed out) the review offers the compare page instead.
      if (err) resolve(null);
      else resolve((stdout as string).trim());
    });
  });
}

/**
 * Where the branch stands with its remote and pull request, for the review's
 * footer: whether it's pushed, an open PR if `gh` can find one, and the
 * GitHub page that opens a new one.
 */
export async function getPullRequestInfo(dirPath: string): Promise<PullRequestInfo> {
  const op: GitOp = 'pr_info';
  const root = await tryGitExec(['rev-parse', '--show-toplevel'], dirPath, op);
  if (!root) return { available: false };
  const branch = await tryGitExec(['rev-parse', '--abbrev-ref', 'HEAD'], root, op);
  if (!branch || branch === 'HEAD') return { available: true };
  if (branch.startsWith('-') || branch.includes('\0')) return { available: true };
  const remote = await resolvePushRemote(root, branch);
  const [resolved, remoteUrl, remoteRef] = await Promise.all([
    resolveMergeBase(root),
    remote ? tryGitExec(['remote', 'get-url', '--', remote], root, op) : Promise.resolve(null),
    remote ? tryGitExec(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], root, op) : Promise.resolve(null),
  ]);
  const unpushed = remote && remoteRef ? Number(await tryGitExec(['rev-list', '--count', `refs/remotes/${remote}/${branch}..HEAD`], root, op)) || 0 : undefined;
  const repo = remoteUrl ? githubRepoOf(remoteUrl) : null;
  const info: PullRequestInfo = {
    available: true, branch, base: resolved?.name, remote: remote ?? undefined, hasRemote: !!remoteUrl, github: !!repo, pushed: !!remoteRef, unpushed,
  };
  if (repo && resolved) {
    const [owner, name] = repo.split('/').map(encodeURIComponent);
    info.compareUrl = `https://github.com/${owner}/${name}/compare/${encodeURIComponent(resolved.name)}...${encodeURIComponent(branch)}?expand=1`;
  }
  if (repo) {
    // --head=<branch> and --repo=<repo> keep both values out of option position; only open PRs count.
    const raw = await ghExec(root, ['pr', 'list', `--repo=${repo}`, `--head=${branch}`, '--state=open', '--limit=1', '--json=url,number,state']);
    if (raw) {
      try {
        const [pr] = JSON.parse(raw) as Array<{ url?: string; number?: number; state?: string }>;
        if (pr?.url && isPullRequestUrlFor(pr.url, repo)) info.pr = { url: pr.url, number: pr.number ?? 0, state: (pr.state ?? 'OPEN').toLowerCase() };
      } catch {
        // telemetry-exempt: unexpected gh output; the footer just offers to open a PR.
      }
    }
  }
  return info;
}

/** Patches and untracked files past this size aren't shown; the review says the file is too large. */
const BRANCH_PATCH_MAX_BYTES = 1024 * 1024;

/**
 * One file's change on the branch: a unified diff against the merge base, or
 * the text of an untracked file. Large files come back as `tooLarge` without
 * being read whole.
 */
export async function getBranchFilePatch(dirPath: string, filePath: string, base?: string): Promise<BranchFilePatch> {
  validateFilePath(filePath);
  const op: GitOp = 'branch_patch';
  const root = await tryGitExec(['rev-parse', '--show-toplevel'], dirPath, op);
  if (!root) return {};
  const untracked = (await gitExec(['ls-files', '--others', '--exclude-standard', '-z', '--', filePath], root, undefined, op)).split('\0');
  if (untracked.includes(filePath)) {
    const full = path.join(root, filePath);
    // lstat: a symlink shows as a link and is never followed, so nothing outside the repo is read.
    const stat = await fs.promises.lstat(full).catch((): null => null);
    if (stat?.isSymbolicLink()) {
      const target = await fs.promises.readlink(full).catch((): string => '');
      return { link: target };
    }
    if (!stat?.isFile()) return {};
    // A folder on the way could itself be a link; refuse anything that resolves outside the repo.
    const [realFile, realRoot] = await Promise.all([fs.promises.realpath(full), fs.promises.realpath(root)]);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return {};
    if (stat.size > BRANCH_PATCH_MAX_BYTES) return { tooLarge: true };
    const buf = await fs.promises.readFile(full);
    if (buf.includes(0)) return { binary: true };
    return { newText: buf.toString('utf-8') };
  }
  const resolved = await resolveMergeBase(root, base);
  const from = resolved?.sha ?? 'HEAD';
  try {
    const patch = await gitExec(
      ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', from, '--', filePath],
      root, undefined, op, BRANCH_PATCH_MAX_BYTES,
    );
    return { patch };
  } catch (err) {
    // A patch past the buffer cap is reported as too large instead of failing the card.
    if ((err as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { tooLarge: true };
    throw err;
  }
}
