/**
 * Clubhouse-owned git checkpoints (docs/structured-chat-research.md, "Changes
 * panel"). A checkpoint is a commit of the whole working tree, including
 * untracked files that aren't ignored, stored under a hidden ref
 * `refs/clubhouse/checkpoints/...`. It is built with a temporary index file
 * seeded from a copy of the user's index, so the user's index, HEAD, branch
 * and working tree are never touched. Untracked files over
 * MAX_UNTRACKED_BYTES are left out and noted in the commit message.
 *
 * Every function takes the repository root (`git rev-parse --show-toplevel`),
 * because git reports paths relative to it.
 *
 * Revert works the same for every provider: restore the files a turn changed
 * to their state at turn start. It first snapshots the current tree as a
 * backup, refuses files that changed again since the turn ended (unless
 * forced) and never touches a path whose current contents the backup can't
 * hold (large or ignored files, directories, anything behind a non-directory).
 * Files are written by `git checkout-index` from a temporary index, so
 * symlinks, file modes, LFS and other filters and line endings come back the
 * way git would check them out. If writing fails, the backup is restored.
 * Line endings follow checkout rules, not the bytes that were on disk: with
 * core.autocrlf=true a file stored with LF comes back with CRLF.
 *
 * A nested repository with no commits yet (an agent ran `git init` in a
 * subfolder) can't be added to a tree; it's left out and noted like a large
 * file instead of failing the whole checkpoint.
 *
 * The refs are ordinary refs: `git push --mirror` pushes refs/clubhouse/*
 * along with everything else. Plain `git push` and `git push --all` don't.
 */

import { execFile } from 'child_process';
import type { Stats } from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ChangeStatus, ChangedFile, RevertResult } from '../../../shared/chat-checkpoints';
export type { ChangeStatus, ChangedFile, RevertResult };

export const CHECKPOINT_REF_PREFIX = 'refs/clubhouse/checkpoints';
export const PENDING_REF_PREFIX = 'refs/clubhouse/pending';
/** Untracked files larger than this aren't checkpointed, so a revert never touches them. */
export const MAX_UNTRACKED_BYTES = 10 * 1024 * 1024;
/** Upper bound for one git command, so a hung process can't block a repository's queue forever. */
const GIT_TIMEOUT_MS = 120_000;
const SKIPPED_PREFIX = 'Skipped-large: ';
const SKIPPED_REPO_PREFIX = 'Skipped-repo: ';

/** Identity for checkpoint commits, so they work without user git config. */
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'Clubhouse',
  GIT_AUTHOR_EMAIL: 'checkpoints@clubhouse.invalid',
  GIT_COMMITTER_NAME: 'Clubhouse',
  GIT_COMMITTER_EMAIL: 'checkpoints@clubhouse.invalid',
};
/** Paths passed to these commands are file names, never patterns. */
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

interface GitOptions {
  env?: Record<string, string>;
  /** Written to stdin. */
  input?: string;
}

function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      // English messages: some failures are recognised by their text.
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

function splitZ(raw: string): string[] {
  return raw.split('\0').filter(Boolean);
}

function tempIndexPath(): string {
  return path.join(os.tmpdir(), `clubhouse-checkpoint-${randomUUID()}.index`);
}

/** Serialize git work per repository so checkpoints and reverts never interleave. */
const repoChains = new Map<string, Promise<unknown>>();
function inRepo<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoChains.get(root) ?? Promise.resolve();
  const next = prev.catch((): void => undefined).then(fn);
  repoChains.set(root, next);
  return next;
}

export async function isGitWorkTree(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** Top of the work tree containing `cwd`, or undefined outside one. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim() || undefined;
  } catch {
    return undefined;
  }
}

export type CheckpointPhase = 'start' | 'end' | 'shared' | 'pre-revert' | 'post-revert';
const PHASE_ORDER: Record<CheckpointPhase, number> = { start: 0, end: 1, shared: 2, 'pre-revert': 3, 'post-revert': 4 };

function refSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Ref names may not contain spaces, colons, etc.; Clubhouse ids are already safe but sanitize anyway. */
export function checkpointRef(agentId: string, sessionId: string, turnId: string, phase: CheckpointPhase): string {
  return `${CHECKPOINT_REF_PREFIX}/${refSegment(agentId)}/${refSegment(sessionId)}/${refSegment(turnId)}/${phase}`;
}

/** Holds the snapshot taken just before a prompt until the turn's id is known. */
export function pendingRef(agentId: string): string {
  return `${PENDING_REF_PREFIX}/${refSegment(agentId)}`;
}

async function lstatOrNull(file: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(file);
  } catch {
    return null;
  }
}

/** Seed a temporary index from a copy of the user's, so `add -A` only rehashes what changed. */
async function seedIndex(root: string, indexFile: string): Promise<void> {
  try {
    const userIndex = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim());
    const st = await fsp.stat(userIndex);
    await fsp.copyFile(userIndex, indexFile);
    // Keep the index's mtime: git re-hashes entries modified at or after it
    // ("racily clean"), and a fresh mtime would hide same-size edits made in
    // the same second as the user's last index write.
    await fsp.utimes(indexFile, st.atime, st.mtime);
    return;
  } catch {
    // No index yet: fall back to HEAD.
  }
  await seedFromHead(root, indexFile);
}

async function seedFromHead(root: string, indexFile: string): Promise<void> {
  await fsp.rm(indexFile, { force: true });
  try {
    await git(root, ['read-tree', 'HEAD'], { env: { GIT_INDEX_FILE: indexFile } });
  } catch {
    // Unborn branch: start from an empty index.
  }
}

/** Untracked, non-ignored files over the size cap. */
async function largeUntracked(root: string, env: Record<string, string>): Promise<string[]> {
  const files = splitZ(await git(root, ['ls-files', '-z', '--others', '--exclude-standard'], { env }));
  const large: string[] = [];
  for (let i = 0; i < files.length; i += 64) {
    const batch = files.slice(i, i + 64);
    const stats = await Promise.all(batch.map((f) => lstatOrNull(path.join(root, f))));
    stats.forEach((st, j) => { if (st?.isFile() && st.size > MAX_UNTRACKED_BYTES) large.push(batch[j]); });
  }
  return large;
}

async function addOnce(root: string, env: Record<string, string>, excluded: string[]): Promise<void> {
  if (!excluded.length) {
    await git(root, ['add', '-A', '--', '.'], { env });
    return;
  }
  const specs = ['.', ...excluded.map((p) => `:(exclude,literal)${p}`)];
  await git(root, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: specs.join('\0') });
}

/** Nested repositories `git add` refused because they have no commit yet. */
function reposWithoutCommits(message: string): string[] {
  return [...message.matchAll(/'([^']+)' does not have a commit checked out/g)].map((m) => m[1].replace(/\/+$/, ''));
}

/** `git add -A`, leaving out large files and any nested repository with no commits. Returns those repositories. */
async function addAll(root: string, env: Record<string, string>, large: string[]): Promise<string[]> {
  const repos: string[] = [];
  for (;;) {
    try {
      await addOnce(root, env, [...large, ...repos]);
      return repos;
    } catch (err) {
      const found = reposWithoutCommits(err instanceof Error ? err.message : String(err)).filter((p) => !repos.includes(p));
      if (!found.length) throw err;
      repos.push(...found);
    }
  }
}

interface Snapshot {
  tree: string;
  /** Untracked files over the size cap. */
  skipped: string[];
  /** Nested repositories with no commits. */
  repos: string[];
}

/** Tree of the current working tree (tracked + untracked, minus ignored and large untracked files). */
async function snapshotTree(root: string): Promise<Snapshot> {
  const indexFile = tempIndexPath();
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await seedIndex(root, indexFile);
    let skipped: string[];
    let repos: string[];
    try {
      skipped = await largeUntracked(root, env);
      repos = await addAll(root, env, skipped);
    } catch {
      // A copied index git can't use here (unusual extensions): start over from HEAD.
      await seedFromHead(root, indexFile);
      skipped = await largeUntracked(root, env);
      repos = await addAll(root, env, skipped);
    }
    return { tree: (await git(root, ['write-tree'], { env })).trim(), skipped, repos };
  } finally {
    await fsp.rm(indexFile, { force: true });
  }
}

async function commitSnapshot(root: string, message: string): Promise<string> {
  const { tree, skipped, repos } = await snapshotTree(root);
  let parentArgs: string[] = [];
  try {
    parentArgs = ['-p', (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim()];
  } catch {
    // No HEAD yet.
  }
  const notes = [
    ...skipped.map((p) => SKIPPED_PREFIX + JSON.stringify(p)),
    ...repos.map((p) => SKIPPED_REPO_PREFIX + JSON.stringify(p)),
  ];
  const body = notes.length ? `\n\n${notes.join('\n')}\n` : '\n';
  return (await git(root, ['commit-tree', tree, ...parentArgs, '-F', '-'], { env: COMMIT_ENV, input: message + body })).trim();
}

/** Create a checkpoint commit of the working tree and point `ref` at it. Returns the commit sha. */
export function createCheckpoint(root: string, ref: string, message: string): Promise<string> {
  return inRepo(root, async () => {
    const commit = await commitSnapshot(root, message);
    await git(root, ['update-ref', ref, commit]);
    return commit;
  });
}

/** Point `ref` at an existing checkpoint commit. */
export function pointRef(root: string, ref: string, commit: string): Promise<void> {
  return inRepo(root, async () => { await git(root, ['update-ref', ref, commit]); });
}

export function deleteRef(root: string, ref: string): Promise<void> {
  return inRepo(root, async () => {
    try {
      await git(root, ['update-ref', '-d', ref]);
    } catch {
      // Already gone.
    }
  });
}

/** What a checkpoint left out: large untracked files and nested repositories with no commits. */
export async function readSkipped(root: string, commit: string): Promise<{ large: string[]; repos: string[] }> {
  const body = await git(root, ['show', '-s', '--format=%B', commit]);
  const out = { large: [] as string[], repos: [] as string[] };
  for (const line of body.split('\n')) {
    const list = line.startsWith(SKIPPED_PREFIX) ? out.large : line.startsWith(SKIPPED_REPO_PREFIX) ? out.repos : null;
    if (!list) continue;
    try {
      list.push(JSON.parse(line.slice(line.indexOf(': ') + 2)) as string);
    } catch {
      // Not ours.
    }
  }
  return out;
}

/** Parse `git diff --numstat -z -M` output, which lists renames as "a\tb\t\0old\0new\0". */
export function parseNumstat(raw: string, nameStatus: Map<string, ChangeStatus>): ChangedFile[] {
  const out: ChangedFile[] = [];
  const parts = raw.split('\0');
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (!head) { i++; continue; }
    const [add, del, maybePath] = head.split('\t');
    const binary = add === '-' && del === '-';
    let filePath = maybePath;
    let oldPath: string | undefined;
    if (maybePath === '') {
      oldPath = parts[i + 1];
      filePath = parts[i + 2];
      i += 3;
    } else {
      i += 1;
    }
    out.push({
      path: filePath,
      ...(oldPath ? { oldPath } : {}),
      status: oldPath ? 'renamed' : nameStatus.get(filePath) ?? 'modified',
      additions: binary ? 0 : Number(add),
      deletions: binary ? 0 : Number(del),
      binary,
    });
  }
  return out;
}

export function parseNameStatus(raw: string): Map<string, ChangeStatus> {
  const map = new Map<string, ChangeStatus>();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length;) {
    const code = parts[i];
    if (!code) { i++; continue; }
    if (code.startsWith('R') || code.startsWith('C')) {
      map.set(parts[i + 2], 'renamed');
      i += 3;
    } else {
      map.set(parts[i + 1], code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified');
      i += 2;
    }
  }
  return map;
}

/** Plain, machine-readable diff output whatever the user's diff config says. */
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

/** Files changed between two checkpoints (or a checkpoint and the current working tree when `to` is omitted). */
export function diffFiles(root: string, from: string, to?: string): Promise<ChangedFile[]> {
  return inRepo(root, async () => {
    const target = to ?? (await snapshotTree(root)).tree;
    const [numstat, nameStatus] = await Promise.all([
      git(root, ['diff', ...DIFF_FLAGS, '--numstat', '-z', '-M', from, target]),
      git(root, ['diff', ...DIFF_FLAGS, '--name-status', '-z', '-M', from, target]),
    ]);
    return parseNumstat(numstat, parseNameStatus(nameStatus));
  });
}

/** Unified diff for one file between two checkpoints (or vs the working tree). */
export function diffPatch(root: string, from: string, to: string | undefined, filePath: string): Promise<string> {
  return inRepo(root, async () => {
    const target = to ?? (await snapshotTree(root)).tree;
    return git(root, ['diff', ...DIFF_FLAGS, '--src-prefix=a/', '--dst-prefix=b/', '-M', from, target, '--', filePath], { env: LITERAL });
  });
}

/** Paths that differ between two commits, renames split into delete + add. */
async function changedPaths(root: string, from: string, to: string): Promise<string[]> {
  return splitZ(await git(root, ['diff', ...DIFF_FLAGS, '--name-only', '-z', '--no-renames', from, to]));
}

/** Which of `paths` are files (or links) in `commit`. */
async function presentIn(root: string, commit: string, paths: string[]): Promise<Set<string>> {
  const present = new Set<string>();
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    const raw = await git(root, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit, '--', ...chunk], { env: LITERAL });
    for (const p of splitZ(raw)) present.add(p);
  }
  return present;
}

async function sameTree(root: string, a: string, b: string): Promise<boolean> {
  try {
    const [ta, tb] = await Promise.all([
      git(root, ['rev-parse', '--verify', '--quiet', `${a}^{tree}`]),
      git(root, ['rev-parse', '--verify', '--quiet', `${b}^{tree}`]),
    ]);
    return ta.trim() !== '' && ta.trim() === tb.trim();
  } catch {
    return false;
  }
}

/**
 * Whether restoring `filePath` could destroy something the backup doesn't
 * hold: 'unsafe' for a leading component that isn't a real directory (git
 * would replace it, and deleting through it would follow a link) or a file
 * the backup left out (ignored or too large); 'dir' for a directory at the
 * path, which is only safe if the revert itself empties it.
 */
async function protection(root: string, filePath: string, inBackup: boolean): Promise<'ok' | 'dir' | 'unsafe'> {
  const parts = filePath.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    const st = await lstatOrNull(dir);
    if (!st) return 'ok';
    if (!st.isDirectory()) return 'unsafe';
  }
  const st = await lstatOrNull(path.join(root, filePath));
  if (!st) return 'ok';
  if (st.isDirectory()) return 'dir';
  return inBackup ? 'ok' : 'unsafe';
}

/** Everything under `dir` (relative to root), not following links; undefined past `limit` entries. */
async function filesUnder(root: string, dir: string, limit = 1000): Promise<string[] | undefined> {
  const out: string[] = [];
  const queue = [dir];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const entry of await fsp.readdir(path.join(root, current), { withFileTypes: true })) {
      const rel = `${current}/${entry.name}`;
      if (entry.isDirectory()) queue.push(rel);
      else out.push(rel);
      if (out.length + queue.length > limit) return undefined;
    }
  }
  return out;
}

/** True when `filePath`, a parent of it or something under it is in `changed`. */
function overlaps(filePath: string, changed: Set<string>, changedDirs: Set<string>): boolean {
  if (changed.has(filePath) || changedDirs.has(filePath)) return true;
  for (let i = filePath.indexOf('/'); i !== -1; i = filePath.indexOf('/', i + 1)) {
    if (changed.has(filePath.slice(0, i))) return true;
  }
  return false;
}

function parentDirs(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) dirs.add(p.slice(0, i));
  }
  return dirs;
}

/** Delete one file or link, never following a link in its leading path, then prune emptied directories. */
async function removePath(root: string, filePath: string): Promise<void> {
  if ((await protection(root, filePath, true)) !== 'ok') throw new Error(`Refusing to delete ${filePath}: its path changed`);
  await fsp.rm(path.join(root, filePath), { force: true });
  let dir = path.dirname(filePath);
  while (dir && dir !== '.') {
    try {
      await fsp.rmdir(path.join(root, dir));
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

/** Make `paths` in the working tree match `commit`: check out the ones it has, delete the rest. */
async function restorePaths(root: string, commit: string, paths: string[], present: Set<string>): Promise<void> {
  for (const p of paths) if (!present.has(p)) await removePath(root, p);
  const write = paths.filter((p) => present.has(p));
  if (!write.length) return;
  const indexFile = tempIndexPath();
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git(root, ['read-tree', commit], { env });
    await git(root, ['checkout-index', '-f', '-z', '--stdin'], { env, input: write.join('\0') });
  } finally {
    await fsp.rm(indexFile, { force: true });
  }
}

export interface RevertOptions {
  /** Also overwrite files that changed after `end`; the backup still holds them. */
  force?: boolean;
  /**
   * Refs to point at the backup taken before the revert and the tree after it,
   * so it can be undone. A later revert that starts from the previous one's
   * `after` keeps the original `before`, so one undo covers both.
   */
  backupRefs?: { before: string; after: string };
}

export interface RevertOutcome extends RevertResult {
  /** Backup of the working tree just before the revert. */
  before?: string;
  /** Working tree just after it. */
  after?: string;
}

/**
 * Restore the files changed between `start` and `end` to their `start` state.
 * Undoing a revert is the same operation with `start` = its backup and
 * `end` = the tree after it.
 */
export function revertChanges(root: string, start: string, end: string, opts: RevertOptions = {}): Promise<RevertOutcome> {
  return inRepo(root, async (): Promise<RevertOutcome> => {
    const paths = await changedPaths(root, start, end);
    if (!paths.length) return { reverted: [], conflicts: [], skipped: [] };

    // Validate everything before writing anything.
    const before = await commitSnapshot(root, 'Clubhouse checkpoint: before revert');
    const changedSince = new Set(await changedPaths(root, end, before));
    const changedSinceDirs = parentDirs(changedSince);
    const [inBefore, inStart] = await Promise.all([presentIn(root, before, paths), presentIn(root, start, paths)]);
    const apply: string[] = [];
    const conflicts: string[] = [];
    const skipped: string[] = [];
    const dirs: string[] = [];
    for (const p of paths) {
      const state = await protection(root, p, inBefore.has(p));
      if (state === 'unsafe') { skipped.push(p); continue; }
      if (overlaps(p, changedSince, changedSinceDirs) && !opts.force) { conflicts.push(p); continue; }
      if (state === 'dir') dirs.push(p);
      else apply.push(p);
    }
    // A directory where a file goes back is fine when the revert deletes everything in it.
    const deleted = new Set(apply.filter((p) => !inStart.has(p)));
    for (const dir of dirs) {
      const inside = await filesUnder(root, dir);
      if (inside?.every((f) => deleted.has(f))) apply.push(dir);
      else skipped.push(dir);
    }
    if (!apply.length) return { reverted: [], conflicts, skipped };

    if (opts.backupRefs && !(await sameTree(root, opts.backupRefs.after, before))) {
      await git(root, ['update-ref', opts.backupRefs.before, before]);
    }
    try {
      await restorePaths(root, start, apply, inStart);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        await restorePaths(root, before, apply, inBefore);
      } catch (rollbackErr) {
        const rollback = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(`Revert failed (${reason}) and so did restoring the backup (${rollback}). Your files are saved in checkpoint ${before}.`);
      }
      throw new Error(`Revert failed and nothing was changed: ${reason}`);
    }
    const after = await commitSnapshot(root, 'Clubhouse checkpoint: after revert');
    if (opts.backupRefs) await git(root, ['update-ref', opts.backupRefs.after, after]);
    return { reverted: apply, conflicts, skipped, before, after };
  });
}

export interface CheckpointRefInfo {
  ref: string;
  commit: string;
  sessionId: string;
  turnId: string;
  phase: CheckpointPhase;
  createdAt: number;
}

/** All checkpoint refs for an agent, oldest first. */
export async function listCheckpointRefs(root: string, agentId: string): Promise<CheckpointRefInfo[]> {
  const prefix = `${CHECKPOINT_REF_PREFIX}/${refSegment(agentId)}/`;
  let raw: string;
  try {
    raw = await git(root, ['for-each-ref', '--sort=creatordate', '--format=%(refname)%09%(objectname)%09%(creatordate:unix)', prefix]);
  } catch {
    return [];
  }
  const out: CheckpointRefInfo[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [ref, commit, unix] = line.split('\t');
    const rest = ref.slice(prefix.length).split('/');
    if (rest.length !== 3 || !(rest[2] in PHASE_ORDER)) continue;
    out.push({ ref, commit, sessionId: rest[0], turnId: rest[1], phase: rest[2] as CheckpointPhase, createdAt: Number(unix) * 1000 });
  }
  // Ref dates have one-second resolution; within a second keep git's order but order a turn's own refs by phase.
  return out
    .map((r, i) => ({ r, i }))
    .sort((x, y) => x.r.createdAt - y.r.createdAt || (x.r.turnId === y.r.turnId ? PHASE_ORDER[x.r.phase] - PHASE_ORDER[y.r.phase] : x.i - y.i))
    .map(({ r }) => r);
}

/** Delete an agent's oldest checkpoint refs beyond `keepTurns` turns. */
export async function pruneCheckpoints(root: string, agentId: string, keepTurns: number): Promise<number> {
  const refs = await listCheckpointRefs(root, agentId);
  const turns = [...new Set(refs.map((r) => `${r.sessionId}/${r.turnId}`))];
  const drop = new Set(turns.slice(0, Math.max(0, turns.length - keepTurns)));
  const doomed = refs.filter((r) => drop.has(`${r.sessionId}/${r.turnId}`));
  await inRepo(root, async () => {
    for (const r of doomed) await git(root, ['update-ref', '-d', r.ref]);
  });
  return doomed.length;
}
