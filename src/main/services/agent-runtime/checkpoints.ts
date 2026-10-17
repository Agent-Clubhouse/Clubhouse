/**
 * Clubhouse-owned git checkpoints (docs/structured-chat-research.md, "Changes
 * panel"). A checkpoint is a commit of the whole working tree, including
 * untracked files that aren't ignored, stored under a hidden ref
 * `refs/clubhouse/checkpoints/...`. It is built with a temporary index file,
 * so the user's index, HEAD, branch and working tree are never touched.
 *
 * Revert works the same for every provider: restore the files a turn changed
 * to their state at turn start, refusing any file that has changed again since
 * the turn ended unless forced.
 */

import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

export const CHECKPOINT_REF_PREFIX = 'refs/clubhouse/checkpoints';

/** Identity for checkpoint commits, so they work without user git config. */
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'Clubhouse',
  GIT_AUTHOR_EMAIL: 'checkpoints@clubhouse.invalid',
  GIT_COMMITTER_NAME: 'Clubhouse',
  GIT_COMMITTER_EMAIL: 'checkpoints@clubhouse.invalid',
};

function git(cwd: string, args: string[], env?: Record<string, string>, encoding: 'utf-8' | 'buffer' = 'utf-8'): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 64 * 1024 * 1024,
      encoding: encoding === 'buffer' ? 'buffer' : 'utf-8',
      windowsHide: true,
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(typeof stdout === 'string' ? stdout : stdout.toString('utf-8'));
    });
  });
}

function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as Buffer);
    });
  });
}

/** Serialize git work per repository so checkpoints and reverts never interleave. */
const repoChains = new Map<string, Promise<unknown>>();
function inRepo<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoChains.get(cwd) ?? Promise.resolve();
  const next = prev.catch((): void => undefined).then(fn);
  repoChains.set(cwd, next);
  return next;
}

export async function isGitWorkTree(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** Ref names may not contain spaces, colons, etc.; Clubhouse ids are already safe but sanitize anyway. */
export function checkpointRef(agentId: string, sessionId: string, turnId: string, phase: 'start' | 'end'): string {
  const seg = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${CHECKPOINT_REF_PREFIX}/${seg(agentId)}/${seg(sessionId)}/${seg(turnId)}/${phase}`;
}

/** Tree of the current working tree (tracked + untracked, minus ignored) via a throwaway index. */
async function snapshotTree(cwd: string): Promise<string> {
  const indexFile = path.join(os.tmpdir(), `clubhouse-checkpoint-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    // Seed from HEAD when there is one so unchanged files are cheap to hash.
    try {
      await git(cwd, ['read-tree', 'HEAD'], env);
    } catch {
      // Unborn branch: start from an empty index.
    }
    await git(cwd, ['add', '-A', '--', '.'], env);
    return (await git(cwd, ['write-tree'], env)).trim();
  } finally {
    await fsp.rm(indexFile, { force: true });
  }
}

/** Create a checkpoint commit of the working tree and point `ref` at it. Returns the commit sha. */
export function createCheckpoint(cwd: string, ref: string, message: string): Promise<string> {
  return inRepo(cwd, async () => {
    const tree = await snapshotTree(cwd);
    let parentArgs: string[] = [];
    try {
      parentArgs = ['-p', (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim()];
    } catch {
      // No HEAD yet.
    }
    const commit = (await git(cwd, ['commit-tree', tree, ...parentArgs, '-m', message], COMMIT_ENV)).trim();
    await git(cwd, ['update-ref', ref, commit]);
    return commit;
  });
}

/** Point `ref` at an existing checkpoint commit. */
export function pointRef(cwd: string, ref: string, commit: string): Promise<void> {
  return inRepo(cwd, async () => { await git(cwd, ['update-ref', ref, commit]); });
}

import type { ChangeStatus, ChangedFile, RevertResult } from '../../../shared/chat-checkpoints';
export type { ChangeStatus, ChangedFile, RevertResult };

/** Parse `git diff --numstat -z -M` output, which lists renames as "a\tb\t\0old\0new\0". */
function parseNumstat(raw: string, nameStatus: Map<string, ChangeStatus>): ChangedFile[] {
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

function parseNameStatus(raw: string): Map<string, ChangeStatus> {
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

/** Files changed between two checkpoints (or a checkpoint and the current working tree when `to` is omitted). */
export function diffFiles(cwd: string, from: string, to?: string): Promise<ChangedFile[]> {
  return inRepo(cwd, async () => {
    const target = to ?? await snapshotTree(cwd);
    const [numstat, nameStatus] = await Promise.all([
      git(cwd, ['diff', '--numstat', '-z', '-M', from, target]),
      git(cwd, ['diff', '--name-status', '-z', '-M', from, target]),
    ]);
    return parseNumstat(numstat, parseNameStatus(nameStatus));
  });
}

/** Unified diff for one file between two checkpoints (or vs the working tree). */
export function diffPatch(cwd: string, from: string, to: string | undefined, filePath: string): Promise<string> {
  return inRepo(cwd, async () => {
    const target = to ?? await snapshotTree(cwd);
    return git(cwd, ['diff', '-M', from, target, '--', filePath]);
  });
}

async function blobOf(cwd: string, commit: string, filePath: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${commit}:${filePath}`])).trim() || null;
  } catch {
    return null;
  }
}

async function workingBlob(cwd: string, filePath: string): Promise<string | null> {
  try {
    await fsp.access(path.join(cwd, filePath));
  } catch {
    return null;
  }
  return (await git(cwd, ['hash-object', '--', filePath])).trim();
}


/**
 * Restore the files changed between `start` and `end` to their `start` state.
 * A file that no longer matches `end` was edited afterwards; it's reported as
 * a conflict and skipped unless `force` is set.
 */
export function revertChanges(cwd: string, start: string, end: string, force = false): Promise<RevertResult> {
  return inRepo(cwd, async () => {
    const nameStatus = parseNameStatus(await git(cwd, ['diff', '--name-status', '-z', '--no-renames', start, end]));
    const reverted: string[] = [];
    const conflicts: string[] = [];
    for (const filePath of nameStatus.keys()) {
      const [endBlob, current] = await Promise.all([blobOf(cwd, end, filePath), workingBlob(cwd, filePath)]);
      if (!force && endBlob !== current) {
        conflicts.push(filePath);
        continue;
      }
      const absolute = path.join(cwd, filePath);
      const startBlob = await blobOf(cwd, start, filePath);
      if (startBlob) {
        await fsp.mkdir(path.dirname(absolute), { recursive: true });
        await fsp.writeFile(absolute, await gitBuffer(cwd, ['cat-file', 'blob', startBlob]));
      } else {
        await fsp.rm(absolute, { force: true });
      }
      reverted.push(filePath);
    }
    return { reverted, conflicts };
  });
}

export interface CheckpointRefInfo {
  ref: string;
  commit: string;
  sessionId: string;
  turnId: string;
  phase: 'start' | 'end';
  createdAt: number;
}

/** All checkpoint refs for an agent, oldest first. */
export async function listCheckpointRefs(cwd: string, agentId: string): Promise<CheckpointRefInfo[]> {
  const prefix = `${CHECKPOINT_REF_PREFIX}/${agentId.replace(/[^A-Za-z0-9._-]/g, '_')}/`;
  let raw: string;
  try {
    raw = await git(cwd, ['for-each-ref', '--sort=creatordate', '--format=%(refname)%09%(objectname)%09%(creatordate:unix)', prefix]);
  } catch {
    return [];
  }
  const out: CheckpointRefInfo[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [ref, commit, unix] = line.split('\t');
    const rest = ref.slice(prefix.length).split('/');
    if (rest.length !== 3 || (rest[2] !== 'start' && rest[2] !== 'end')) continue;
    out.push({ ref, commit, sessionId: rest[0], turnId: rest[1], phase: rest[2], createdAt: Number(unix) * 1000 });
  }
  // Ref dates have one-second resolution; within a second keep git's order but put a turn's start before its end.
  return out
    .map((r, i) => ({ r, i }))
    .sort((x, y) => x.r.createdAt - y.r.createdAt || (x.r.turnId === y.r.turnId ? (x.r.phase === 'start' ? -1 : 1) : x.i - y.i))
    .map(({ r }) => r);
}

/** Delete an agent's oldest checkpoint refs beyond `keepTurns` turns. */
export async function pruneCheckpoints(cwd: string, agentId: string, keepTurns: number): Promise<number> {
  const refs = await listCheckpointRefs(cwd, agentId);
  const turns = [...new Set(refs.map((r) => `${r.sessionId}/${r.turnId}`))];
  const drop = new Set(turns.slice(0, Math.max(0, turns.length - keepTurns)));
  const doomed = refs.filter((r) => drop.has(`${r.sessionId}/${r.turnId}`));
  await inRepo(cwd, async () => {
    for (const r of doomed) await git(cwd, ['update-ref', '-d', r.ref]);
  });
  return doomed.length;
}
