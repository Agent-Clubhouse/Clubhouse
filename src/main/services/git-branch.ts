/**
 * An agent's branch against main (#2032): what the branch changed since it
 * left its base, committed or not. The checkpoint diffs (checkpoints.ts) only
 * cover chat turns; this covers the whole branch, for terminal agents too.
 *
 * The base is the merge base of HEAD with the project's main branch, so
 * commits made on main after the branch started don't show up as the
 * branch's changes. The comparison is against the working tree, so
 * uncommitted edits count, and untracked files show as added.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { BranchChanges, BranchFilePatch } from '../../shared/git-branch';
import type { ChangedFile } from '../../shared/chat-checkpoints';
import type { GitLogEntry } from '../../shared/types';
import { parseNameStatus, parseNumstat } from './agent-runtime/checkpoints';

/** Plain, machine-readable diff output whatever the user's diff config says. */
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];
/** Untracked files larger than this aren't read to count their lines. */
const MAX_COUNT_BYTES = 1_000_000;

function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf-8', timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as string);
    });
  });
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).trim();
  } catch {
    // telemetry-exempt: a probe (is there an origin HEAD, a main, a merge base); failing just means no.
    return null;
  }
}

/**
 * The branch agents' work is measured against: origin's default branch when
 * it's known, else a local main or master. Returns the ref to diff against
 * and the short name to show ("main").
 */
export async function resolveBaseBranch(cwd: string): Promise<{ ref: string; name: string } | null> {
  const originHead = await tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const candidates: string[] = [];
  if (originHead) {
    const name = originHead.replace(/^origin\//, '');
    candidates.push(name, originHead);
  }
  candidates.push('main', 'master', 'origin/main', 'origin/master');
  for (const ref of candidates) {
    if (await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) {
      return { ref, name: ref.replace(/^origin\//, '') };
    }
  }
  return null;
}

async function repoRoot(dir: string): Promise<string | null> {
  return tryGit(dir, ['rev-parse', '--show-toplevel']);
}

function splitZ(raw: string): string[] {
  return raw.split('\0').filter(Boolean);
}

/** Lines in a small text file; null for large or binary files. */
function countLines(file: string): { lines: number; binary: boolean } {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_COUNT_BYTES) return { lines: 0, binary: false };
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return { lines: 0, binary: true };
    const text = buf.toString('utf-8');
    if (!text) return { lines: 0, binary: false };
    return { lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), binary: false };
  } catch {
    // telemetry-exempt: a line count for display; an unreadable file just shows +0.
    return { lines: 0, binary: false };
  }
}

async function untrackedFiles(root: string): Promise<string[]> {
  return splitZ(await git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
}

/** Files the branch changed against its merge base with main, uncommitted work and untracked files included. */
export async function getBranchChanges(dir: string, base?: string): Promise<BranchChanges> {
  const root = await repoRoot(dir);
  if (!root) return { available: false, files: [], ahead: 0, uncommitted: 0 };
  const resolved = base ? { ref: base, name: base.replace(/^origin\//, '') } : await resolveBaseBranch(root);
  const branch = (await tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? undefined;
  if (!resolved) return { available: true, branch, files: [], ahead: 0, uncommitted: 0, noBase: true };
  const mergeBase = await tryGit(root, ['merge-base', 'HEAD', resolved.ref]);
  if (!mergeBase) return { available: true, branch, base: resolved.name, files: [], ahead: 0, uncommitted: 0, noBase: true };

  const [numstat, nameStatus, aheadRaw, untracked, statusRaw] = await Promise.all([
    git(root, ['diff', ...DIFF_FLAGS, '--numstat', '-z', '-M', mergeBase]),
    git(root, ['diff', ...DIFF_FLAGS, '--name-status', '-z', '-M', mergeBase]),
    tryGit(root, ['rev-list', '--count', `${mergeBase}..HEAD`]),
    untrackedFiles(root),
    git(root, ['status', '--porcelain', '-z', '-uall']),
  ]);
  const files: ChangedFile[] = parseNumstat(numstat, parseNameStatus(nameStatus));
  for (const p of untracked) {
    const { lines, binary } = countLines(path.join(root, p));
    files.push({ path: p, status: 'added', additions: lines, deletions: 0, binary });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const uncommitted = splitZ(statusRaw).filter((e) => /^[ MADRCU?!]{2} /.test(e)).length;
  return {
    available: true,
    branch,
    base: resolved.name,
    mergeBase,
    files,
    ahead: Number(aheadRaw) || 0,
    uncommitted,
  };
}

/** One file's change on the branch: a unified diff, or the whole text of an untracked file. */
export async function getBranchFilePatch(dir: string, filePath: string, base?: string): Promise<BranchFilePatch> {
  if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..') || filePath.includes('\0')) {
    throw new Error('Invalid file path');
  }
  const root = await repoRoot(dir);
  if (!root) return {};
  const untracked = splitZ(await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', filePath]));
  if (untracked.includes(filePath)) {
    const { binary } = countLines(path.join(root, filePath));
    if (binary) return { binary: true };
    try {
      return { newText: fs.readFileSync(path.join(root, filePath), 'utf-8') };
    } catch {
      // telemetry-exempt: the card says there's no diff to show for a file it can't read.
      return {};
    }
  }
  const resolved = base ? { ref: base } : await resolveBaseBranch(root);
  const mergeBase = resolved ? await tryGit(root, ['merge-base', 'HEAD', resolved.ref]) : null;
  const from = mergeBase ?? 'HEAD';
  const patch = await git(root, ['diff', ...DIFF_FLAGS, '--src-prefix=a/', '--dst-prefix=b/', '-M', from, '--', filePath]);
  return { patch };
}

/** The branch's own commits since it left main, newest first. */
export async function getBranchLog(dir: string, base?: string, limit = 100): Promise<GitLogEntry[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  const resolved = base ? { ref: base } : await resolveBaseBranch(root);
  if (!resolved) return [];
  const mergeBase = await tryGit(root, ['merge-base', 'HEAD', resolved.ref]);
  if (!mergeBase) return [];
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  const raw = await git(root, ['log', `-${n}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1e', `${mergeBase}..HEAD`]);
  return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [hash, shortHash, subject, author, date] = r.split('\x1f');
    return { hash, shortHash, subject, author, date };
  });
}
