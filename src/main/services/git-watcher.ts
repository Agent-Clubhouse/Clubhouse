/**
 * The git watcher (#2955): publishes commits, branch switches and
 * remote-tracking ref updates to the app event bus for every registered
 * project root and durable agent worktree.
 *
 * It watches each repo's git dir (HEAD, refs/heads, refs/remotes and
 * packed-refs) with fs.watch, debounces, then reads the ref files directly
 * and compares with the last snapshot. On macOS that is one recursive watch
 * of the shared git dir, filtered to ref changes; elsewhere it is plain
 * directories (see GitWatcherOptions.recursiveWatch for why). A slow timer reads
 * every repo again in case a watcher event never came (and, on Windows, for
 * the folders it doesn't watch). It never runs git and never fetches.
 * Worktrees that share a common git dir are one group, so a ref moving there
 * is read once and only the worktree(s) on that branch get a commit.
 *
 * Attribution: an event names an agent when that agent ran a matching git
 * command through a shell tool (terminal hook or chat tool call) in the
 * minute before, in a directory inside that worktree. Each command is
 * credited once per kind of change. Otherwise the event names nobody.
 *
 * Reftable repos (`extensions.refStorage = reftable`) keep refs in binary
 * tables this can't read; they're logged once and skipped.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { listDurable, onAgentConfigChanged } from './agent-config';
import { getAgentCwd } from './agent-registry';
import { onChatEvent } from './agent-runtime/chat-event-bus';
import { publishAppEvent, type AppEventInput } from './app-event-bus';
import { noteAgentToolCall, recentGitCommands, type GitCommandRecord, type GitVerb } from './git-command-log';
import { appLog } from './log-service';
import { beginOperation, trackOperation } from './main-stall-monitor';
import * as projectStore from './project-store';

export const GIT_WATCH_DEBOUNCE_MS = 500;
/**
 * How often every repo is checked again whatever the watchers say. macOS
 * delivers fs.watch events late or not at all at times (agent-config checks
 * agents.json on a timer for the same reason), so this bounds the lateness.
 */
export const GIT_POLL_INTERVAL_MS = 10_000;
/** A poll reads a repo in full at least this often, even when nothing looks changed. */
const POLLS_PER_FULL_READ = 6;
/** Worktree paths watched at most; beyond this the rest are skipped and logged. */
export const MAX_WATCHED_REPOS = 100;
/** Directories watched per shared git dir (deeply nested branch names add one each). */
export const MAX_DIRS_PER_REPO = 256;
/**
 * Remote branches reported one by one per remote per scan. Past this (a
 * first fetch of a big repo) the remote gets one event with branch `*`, plus
 * one each for branches checked out in a watched worktree.
 */
export const MAX_REMOTE_EVENTS_PER_SCAN = 20;
/** The branch of a `git.remote_updated` that stands for many branches at once. */
export const MANY_BRANCHES = '*';

const COMMIT_VERBS: readonly GitVerb[] = ['commit', 'merge', 'rebase', 'pull', 'cherry-pick', 'revert', 'reset', 'am'];
const SWITCH_VERBS: readonly GitVerb[] = ['checkout', 'switch'];
const REMOTE_VERBS: readonly GitVerb[] = ['push', 'pull', 'fetch'];

// ── Reading a repo ──────────────────────────────────────────────────────────

export interface GitDirs {
  /** Where this worktree's HEAD lives. */
  gitDir: string;
  /** Where refs and packed-refs live (the same as gitDir for a main worktree). */
  commonDir: string;
}

/**
 * The git dirs of a worktree. A main worktree's `.git` is a directory; a
 * linked worktree's is a file `gitdir: <common>/worktrees/<name>`, and that
 * dir's `commondir` file points back to the common dir.
 */
export async function resolveGitDirs(worktreePath: string): Promise<GitDirs | null> {
  const dotGit = path.join(worktreePath, '.git');
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(dotGit);
  } catch {
    // telemetry-exempt: not a git repo (or not there); nothing to watch
    return null;
  }
  let gitDir: string;
  if (stat.isDirectory()) {
    gitDir = dotGit;
  } else if (stat.isFile()) {
    let text: string;
    try {
      text = await fsp.readFile(dotGit, 'utf-8');
    } catch {
      // telemetry-exempt: an unreadable .git file is not a repo we can watch
      return null;
    }
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) return null;
    gitDir = path.resolve(worktreePath, m[1]);
  } else {
    return null;
  }
  let commonDir = gitDir;
  try {
    const common = (await fsp.readFile(path.join(gitDir, 'commondir'), 'utf-8')).trim();
    if (common) commonDir = path.resolve(gitDir, common);
  } catch {
    // telemetry-exempt: no commondir file means a main worktree
  }
  // Real paths, so a project root and its worktrees agree on the common dir
  // (git writes real paths into a worktree's .git file; a project path may
  // go through a symlink, such as /var on macOS).
  const real = (p: string) => fsp.realpath(p).catch((): string => p);
  return { gitDir: await real(gitDir), commonDir: await real(commonDir) };
}

/** True when the repo keeps its refs in reftable, which this watcher can't read. */
export async function isReftableRepo(commonDir: string): Promise<boolean> {
  try {
    const config = await fsp.readFile(path.join(commonDir, 'config'), 'utf-8');
    if (/^\s*refstorage\s*=\s*reftable\s*$/im.test(config)) return true;
  } catch {
    // telemetry-exempt: no config; fall through to the folder check
  }
  try {
    return (await fsp.stat(path.join(commonDir, 'reftable'))).isDirectory();
  } catch {
    // telemetry-exempt: no reftable folder means files-backend refs
    return false;
  }
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function isWatchedRef(ref: string): boolean {
  return ref.startsWith('refs/heads/') || ref.startsWith('refs/remotes/');
}

/** Branch and remote-tracking refs in a packed-refs file. Peeled (`^`) lines are skipped. */
export function parsePackedRefs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    const sha = line.slice(0, space);
    const ref = line.slice(space + 1).trim();
    if (SHA_RE.test(sha) && isWatchedRef(ref)) out.set(ref, sha);
  }
  return out;
}

/**
 * The branch HEAD is on, or null when detached (or on something other than
 * a branch). Reftable's placeholder HEAD (`refs/heads/.invalid`) is null too.
 */
export function parseHead(text: string): string | null {
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(text.trim());
  return m && m[1] !== '.invalid' ? m[1] : null;
}

export interface RefRead {
  /** False when the git dir couldn't be read at all; the caller keeps its last snapshot. */
  ok: boolean;
  /** Full ref name to sha. Loose refs override packed ones; symrefs are skipped. */
  refs: Map<string, string>;
  /** Directories under refs/heads and refs/remotes (including those two), to watch. */
  dirs: string[];
}

async function walkRefs(dir: string, prefix: string, refs: Map<string, string>, dirs: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    // telemetry-exempt: no such ref folder (no remotes yet, a deleted branch folder)
    return;
  }
  dirs.push(dir);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const ref = `${prefix}/${e.name}`;
    if (e.isDirectory()) {
      await walkRefs(full, ref, refs, dirs);
    } else if (e.isFile() && !e.name.endsWith('.lock')) {
      try {
        const value = (await fsp.readFile(full, 'utf-8')).trim();
        if (SHA_RE.test(value)) refs.set(ref, value);
      } catch {
        // telemetry-exempt: gone between readdir and read; the packed value (if any) stands
      }
    }
  }
}

/**
 * Read every branch and remote-tracking ref in a common git dir. Loose refs
 * are read before packed-refs: `git pack-refs` writes packed-refs before it
 * deletes the loose files, so a loose ref missed mid-pack is in the
 * packed-refs read after it, never an older packed value.
 */
export async function readRefs(commonDir: string): Promise<RefRead> {
  const refs = new Map<string, string>();
  const dirs: string[] = [];
  try {
    await fsp.access(path.join(commonDir, 'refs'));
  } catch {
    // telemetry-exempt: the git dir is gone or unreadable; the caller keeps its last snapshot
    return { ok: false, refs, dirs };
  }
  await walkRefs(path.join(commonDir, 'refs', 'heads'), 'refs/heads', refs, dirs);
  await walkRefs(path.join(commonDir, 'refs', 'remotes'), 'refs/remotes', refs, dirs);
  try {
    for (const [ref, sha] of parsePackedRefs(await fsp.readFile(path.join(commonDir, 'packed-refs'), 'utf-8'))) {
      if (!refs.has(ref)) refs.set(ref, sha);
    }
  } catch {
    // telemetry-exempt: no packed-refs yet
  }
  return { ok: true, refs, dirs };
}

// ── Snapshots ───────────────────────────────────────────────────────────────

export interface WorktreeState {
  /** The branch HEAD is on now; null while detached (a rebase, a checked-out sha). */
  branch: string | null;
  /** The last branch HEAD was on, carried through detached spells. */
  lastBranch: string | null;
}

export interface RepoSnapshot {
  refs: ReadonlyMap<string, string>;
  /** Keyed by the watcher's worktree key. */
  worktrees: ReadonlyMap<string, WorktreeState>;
}

export type GitChange =
  | { type: 'commit'; worktree: string; branch: string }
  | { type: 'branch_switched'; worktree: string; branch: string; previousBranch?: string }
  | { type: 'remote_updated'; remote: string; branch: string };

/**
 * What changed between two snapshots of one shared git dir. A worktree new
 * in `next` is a baseline, not a change. A detached HEAD reports nothing
 * until it lands on a branch: back on the same branch is a commit if the
 * branch moved (a finished rebase), on another is a switch. A switch
 * reports no commit for the same scan. Deleted refs report nothing.
 */
export function diffSnapshots(prev: RepoSnapshot, next: RepoSnapshot): GitChange[] {
  const out: GitChange[] = [];
  for (const [worktree, n] of next.worktrees) {
    const p = prev.worktrees.get(worktree);
    if (!p || n.branch === null) continue;
    if (n.branch !== p.lastBranch) {
      out.push({ type: 'branch_switched', worktree, branch: n.branch, ...(p.lastBranch !== null && { previousBranch: p.lastBranch }) });
      continue;
    }
    const ref = `refs/heads/${n.branch}`;
    const after = next.refs.get(ref);
    if (after && after !== prev.refs.get(ref)) out.push({ type: 'commit', worktree, branch: n.branch });
  }
  for (const [ref, sha] of next.refs) {
    if (!ref.startsWith('refs/remotes/') || prev.refs.get(ref) === sha) continue;
    const rest = ref.slice('refs/remotes/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) continue;
    const branch = rest.slice(slash + 1);
    if (!branch || branch === 'HEAD') continue;
    out.push({ type: 'remote_updated', remote: rest.slice(0, slash), branch });
  }
  return out;
}

/**
 * The remote updates of one scan, as published: per branch up to `cap` per
 * remote; past that one `*` entry for the remote plus the branches in
 * `checkedOut` (so a branch filter on a checked-out branch still matches).
 */
export function coalesceRemoteUpdates(
  changes: ReadonlyArray<{ remote: string; branch: string }>,
  checkedOut: ReadonlySet<string>,
  cap = MAX_REMOTE_EVENTS_PER_SCAN,
): Array<{ remote: string; branch: string }> {
  const byRemote = new Map<string, string[]>();
  for (const c of changes) {
    const list = byRemote.get(c.remote);
    if (list) list.push(c.branch);
    else byRemote.set(c.remote, [c.branch]);
  }
  const out: Array<{ remote: string; branch: string }> = [];
  for (const [remote, branches] of byRemote) {
    if (branches.length <= cap) {
      for (const branch of branches) out.push({ remote, branch });
      continue;
    }
    for (const branch of branches) if (checkedOut.has(branch)) out.push({ remote, branch });
    out.push({ remote, branch: MANY_BRANCHES });
  }
  return out;
}

// ── Paths ───────────────────────────────────────────────────────────────────

/** Path identity: case-folded where the usual file systems ignore case. */
function keyOf(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** True when `child` is `parent` or inside it (both already keyed). */
function within(parentKey: string, childKey: string): boolean {
  const rel = path.relative(parentKey, childKey);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function statSignature(paths: readonly string[]): Promise<string> {
  const parts = await Promise.all(paths.map((p) => fsp.stat(p).then(
    (s) => `${s.mtimeMs}:${s.size}`,
    (): string => '-',
  )));
  return parts.join('|');
}

// ── The watcher ─────────────────────────────────────────────────────────────

interface WatchedPath {
  /** As registered (project path or agent worktree path); what events carry. */
  path: string;
  key: string;
  /** Key of the real path, when it differs (symlinked temp dirs, mapped drives). */
  realKey?: string;
  gitDir: string;
}

interface Group {
  key: string;
  commonDir: string;
  paths: Map<string, WatchedPath>;
  snapshot: RepoSnapshot | null;
  /** What a poll compares to skip a full read: mtimes of packed-refs, HEADs and ref folders. */
  signature: string | null;
  signaturePaths: string[];
  pollsSinceRead: number;
  watchers: Map<string, DirWatcher>;
  timer: ReturnType<typeof setTimeout> | null;
  scanning: Promise<void> | null;
  dirty: boolean;
  /** A scan asked for a full read (a watcher event, a path change, rescan()). */
  wantFull: boolean;
  disposed: boolean;
  dirCapLogged: boolean;
}

type Credit = 'commit' | 'switch' | 'remote';

export interface GitWatcherOptions {
  publish?: (event: AppEventInput) => void;
  debounceMs?: number;
  maxRepos?: number;
  maxDirsPerRepo?: number;
  /** Where an agent's commands run when the tool call didn't say. */
  agentCwd?: (agentId: string) => string | undefined;
  recentCommands?: (now: number) => readonly GitCommandRecord[];
  now?: () => number;
  /** fs.watch on one directory, or a fake in tests. */
  watch?: WatchFn;
  /** 0 turns the periodic check off. */
  pollMs?: number;
  /**
   * Watch folders that deleting an agent removes (a linked worktree's
   * `.git/worktrees/<name>`, `refs/heads/<folder>/`). Off on Windows, where
   * an open watch handle can hold up their deletion; the poll covers them.
   */
  watchRemovableDirs?: boolean;
  /**
   * One recursive watch of each shared git dir (plus any worktree admin dir
   * outside it) in place of a watch per ref folder and worktree. On by
   * default on macOS only (#3230): there, closing a watch waits on the
   * FSEvents thread, which measured 0.4 to 7 s a close on a busy machine, all
   * of it blocking the main thread, and a helper's create or dispose closed
   * some. With one watch per repo a worktree coming or going closes none.
   * Linux would emulate recursion with a watch per folder, and Windows' plain
   * watches are cheap to close, so both keep watching folders.
   */
  recursiveWatch?: boolean;
}

/** What the watcher needs from a directory watch: an fs.FSWatcher, or a fake in tests. */
export interface DirWatcher {
  close(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** `filename` is relative to the watched dir, when the platform says. */
export type WatchFn = (dir: string, onChange: (filename?: string | null) => void, opts?: { recursive?: boolean }) => DirWatcher;

const watchDir: WatchFn = (dir, onChange, opts) => fs.watch(
  dir,
  { persistent: false, recursive: opts?.recursive ?? false },
  (_event, filename) => onChange(filename == null ? null : String(filename)),
);

const REF_CHANGE_RE = /^(?:HEAD|packed-refs|refs|refs\/(?:heads|remotes)(?:\/.*)?|worktrees(?:\/[^/]+(?:\/HEAD)?)?)$/;

/**
 * True when a change at `rel` (relative to a shared git dir, from a
 * recursive watch) can move a branch, a HEAD or a remote-tracking ref.
 * Objects, the index and logs can't. Lock files count as the ref they lock.
 * No name (the platform didn't say) counts too.
 */
export function isRefChange(rel: string | null | undefined): boolean {
  if (!rel) return true;
  return REF_CHANGE_RE.test(rel.replace(/\\/g, '/').replace(/\.lock$/, ''));
}

/** What one setPaths did, for the rebuild log line. */
export interface RebuildStats {
  repos: number;
  watched: number;
  groupsAdded: number;
  groupsRemoved: number;
  groupsKept: number;
  watchersCreated: number;
  watchersClosed: number;
  /** Time spent inside watch() and close() calls (synchronous). */
  watchSyncMs: number;
  totalMs: number;
}

export class GitWatcher {
  private readonly groups = new Map<string, Group>();
  private readonly publish: (event: AppEventInput) => void;
  private readonly debounceMs: number;
  private readonly maxRepos: number;
  private readonly maxDirs: number;
  private readonly agentCwd: (agentId: string) => string | undefined;
  private readonly recentCommands: (now: number) => readonly GitCommandRecord[];
  private readonly now: () => number;
  private readonly watch: WatchFn;
  private readonly pollMs: number;
  private readonly watchRemovableDirs: boolean;
  private readonly recursiveWatch: boolean;
  private poll: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private lastCapped = 0;
  private readonly reftableLogged = new Set<string>();
  /** Running totals; a rebuild reports the difference. */
  private watchersCreated = 0;
  private watchersClosed = 0;
  private watchSyncMs = 0;
  private lastRebuild: RebuildStats | null = null;

  constructor(opts: GitWatcherOptions = {}) {
    this.publish = opts.publish ?? publishAppEvent;
    this.debounceMs = opts.debounceMs ?? GIT_WATCH_DEBOUNCE_MS;
    this.maxRepos = opts.maxRepos ?? MAX_WATCHED_REPOS;
    this.maxDirs = opts.maxDirsPerRepo ?? MAX_DIRS_PER_REPO;
    this.agentCwd = opts.agentCwd ?? (() => undefined);
    this.recentCommands = opts.recentCommands ?? recentGitCommands;
    this.now = opts.now ?? Date.now;
    this.watch = opts.watch ?? watchDir;
    this.pollMs = opts.pollMs ?? GIT_POLL_INTERVAL_MS;
    this.watchRemovableDirs = opts.watchRemovableDirs ?? process.platform !== 'win32';
    this.recursiveWatch = opts.recursiveWatch ?? process.platform === 'darwin';
  }

  /** Watch exactly these worktree paths. Calls are serialized; resolves once baselines are read. */
  setPaths(paths: readonly string[]): Promise<void> {
    const run = () => this.applyPaths(paths);
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** What the last setPaths did, for tests. */
  lastRebuildStats(): RebuildStats | null {
    return this.lastRebuild;
  }

  /** The number of directories being watched, for tests and logs. */
  watchedDirCount(): number {
    let n = 0;
    for (const g of this.groups.values()) n += g.watchers.size;
    return n;
  }

  /** Read every repo in full now and publish what changed. */
  async rescan(): Promise<void> {
    await this.queue;
    await Promise.all([...this.groups.values()].map((g) => this.scan(g, true)));
  }

  /** The periodic check: a full read only where something looks changed (or now and then). */
  async pollOnce(): Promise<void> {
    await this.queue;
    await Promise.all([...this.groups.values()].map((g) => this.scan(g, false)));
  }

  close(): void {
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    for (const g of this.groups.values()) this.dispose(g);
    this.groups.clear();
  }

  private async applyPaths(paths: readonly string[]): Promise<void> {
    if (this.closed) return;
    const startedAt = performance.now();
    const before = { created: this.watchersCreated, closed: this.watchersClosed, syncMs: this.watchSyncMs };
    const counts = { added: 0, removed: 0, kept: 0, repos: 0, watched: 0 };
    await trackOperation('git watcher rebuild', () => this.rebuild(paths, counts));
    if (this.closed) return;
    const stats: RebuildStats = {
      repos: counts.repos,
      watched: counts.watched,
      groupsAdded: counts.added,
      groupsRemoved: counts.removed,
      groupsKept: counts.kept,
      watchersCreated: this.watchersCreated - before.created,
      watchersClosed: this.watchersClosed - before.closed,
      watchSyncMs: Math.round(this.watchSyncMs - before.syncMs),
      totalMs: Math.round(performance.now() - startedAt),
    };
    this.lastRebuild = stats;
    appLog('core:app-events', 'info', 'The git watcher rebuilt its repo list', { meta: { ...stats } });
  }

  private async rebuild(
    paths: readonly string[],
    counts: { added: number; removed: number; kept: number; repos: number; watched: number },
  ): Promise<void> {
    const unique = new Map<string, string>();
    for (const p of paths) if (p && !unique.has(keyOf(p))) unique.set(keyOf(p), p);
    let kept = [...unique.entries()];
    counts.repos = kept.length;
    if (kept.length > this.maxRepos) {
      if (this.lastCapped !== kept.length) {
        appLog('core:app-events', 'warn', 'Too many repos for the git watcher; watching the first ones', {
          meta: { repos: kept.length, watched: this.maxRepos },
        });
      }
      this.lastCapped = kept.length;
      kept = kept.slice(0, this.maxRepos);
    } else {
      this.lastCapped = 0;
    }
    counts.watched = kept.length;

    const resolved = await Promise.all(kept.map(async ([key, p]) => {
      const dirs = await resolveGitDirs(p);
      if (!dirs) return null;
      if (await isReftableRepo(dirs.commonDir)) {
        const commonKey = keyOf(dirs.commonDir);
        if (!this.reftableLogged.has(commonKey)) {
          this.reftableLogged.add(commonKey);
          appLog('core:app-events', 'info', 'The git watcher skips a reftable repo', { meta: { repoPath: p } });
        }
        return null;
      }
      const real = await fsp.realpath(p).then(keyOf, (): undefined => undefined);
      return { dirs, wp: { path: p, key, gitDir: dirs.gitDir, ...(real && real !== key && { realKey: real }) } };
    }));
    if (this.closed) return;

    const wanted = new Map<string, { commonDir: string; paths: Map<string, WatchedPath> }>();
    // Two registered paths for one worktree (a different spelling or case) are one.
    const seenGitDirs = new Set<string>();
    for (const r of resolved) {
      if (!r) continue;
      const gitDirKey = keyOf(r.dirs.gitDir);
      if (seenGitDirs.has(gitDirKey)) continue;
      seenGitDirs.add(gitDirKey);
      const groupKey = keyOf(r.dirs.commonDir);
      let entry = wanted.get(groupKey);
      if (!entry) wanted.set(groupKey, entry = { commonDir: r.dirs.commonDir, paths: new Map() });
      entry.paths.set(r.wp.key, r.wp);
    }

    for (const [key, g] of this.groups) {
      if (!wanted.has(key)) {
        this.dispose(g);
        this.groups.delete(key);
        counts.removed++;
      }
    }
    const scans: Promise<void>[] = [];
    for (const [key, w] of wanted) {
      const existing = this.groups.get(key);
      if (existing) {
        counts.kept++;
        const same = existing.paths.size === w.paths.size
          && [...w.paths.values()].every((p) => existing.paths.get(p.key)?.gitDir === p.gitDir);
        existing.paths = w.paths;
        // A new worktree joins as a baseline in the next scan.
        if (!same) scans.push(this.scan(existing, true));
      } else {
        const g: Group = {
          key, commonDir: w.commonDir, paths: w.paths, snapshot: null,
          signature: null, signaturePaths: [], pollsSinceRead: 0, watchers: new Map(),
          timer: null, scanning: null, dirty: false, wantFull: false, disposed: false, dirCapLogged: false,
        };
        this.groups.set(key, g);
        counts.added++;
        scans.push(this.scan(g, true));
      }
    }
    await Promise.all(scans);
    if (!this.poll && this.pollMs > 0 && !this.closed) {
      this.poll = setInterval(() => { void this.pollOnce(); }, this.pollMs);
      this.poll.unref?.();
    }
  }

  private dispose(g: Group): void {
    g.disposed = true;
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
    for (const w of g.watchers.values()) this.closeWatcher(w);
    g.watchers.clear();
  }

  private closeWatcher(w: DirWatcher): void {
    const t = performance.now();
    w.close();
    this.watchSyncMs += performance.now() - t;
    this.watchersClosed++;
  }

  private schedule(g: Group): void {
    if (g.disposed) return;
    if (g.timer) clearTimeout(g.timer);
    g.timer = setTimeout(() => {
      g.timer = null;
      void this.scan(g, true);
    }, this.debounceMs);
    g.timer.unref?.();
  }

  private scan(g: Group, full: boolean): Promise<void> {
    if (full) g.wantFull = true;
    if (g.scanning) {
      g.dirty = true;
      return g.scanning;
    }
    const run = async () => {
      do {
        g.dirty = false;
        const fullRead = g.wantFull;
        g.wantFull = false;
        try {
          await this.scanOnce(g, fullRead);
        } catch (err) {
          // telemetry-exempt: logged; the next change scans again
          appLog('core:app-events', 'warn', 'The git watcher could not read a repo', {
            meta: { commonDir: g.commonDir, error: err instanceof Error ? err.message : String(err) },
          });
        }
      } while (g.dirty && !g.disposed);
    };
    g.scanning = run().finally(() => { g.scanning = null; });
    return g.scanning;
  }

  private async readHead(g: Group, wp: WatchedPath): Promise<{ branch: string | null } | null> {
    try {
      return { branch: parseHead(await fsp.readFile(path.join(wp.gitDir, 'HEAD'), 'utf-8')) };
    } catch {
      // telemetry-exempt: the worktree may have moved its admin folder; resolve again once
    }
    const dirs = await resolveGitDirs(wp.path);
    if (!dirs || keyOf(dirs.commonDir) !== g.key || dirs.gitDir === wp.gitDir) return null;
    wp.gitDir = dirs.gitDir;
    try {
      return { branch: parseHead(await fsp.readFile(path.join(wp.gitDir, 'HEAD'), 'utf-8')) };
    } catch {
      // telemetry-exempt: unreadable HEAD (mid-removal); the caller keeps what it had
      return null;
    }
  }

  private async scanOnce(g: Group, full: boolean): Promise<void> {
    const scanAt = this.now();
    // Taken before the read, so a change during the read shows on the next poll.
    const signature = g.signaturePaths.length ? await statSignature(g.signaturePaths) : null;
    if (!full && g.snapshot && signature !== null && signature === g.signature && g.pollsSinceRead + 1 < POLLS_PER_FULL_READ) {
      g.pollsSinceRead++;
      return;
    }
    const read = await readRefs(g.commonDir);
    if (!read.ok || g.disposed) return;
    const prev = g.snapshot;
    const worktrees = new Map<string, WorktreeState>();
    for (const wp of g.paths.values()) {
      const before = prev?.worktrees.get(wp.key);
      const head = await this.readHead(g, wp);
      if (!head) {
        if (before) worktrees.set(wp.key, before);
        continue;
      }
      worktrees.set(wp.key, { branch: head.branch, lastBranch: head.branch ?? before?.lastBranch ?? null });
    }
    if (g.disposed) return;
    const next: RepoSnapshot = { refs: read.refs, worktrees };
    g.snapshot = next;
    g.pollsSinceRead = 0;
    const signaturePaths = [
      path.join(g.commonDir, 'packed-refs'),
      ...[...g.paths.values()].map((wp) => path.join(wp.gitDir, 'HEAD')),
      ...read.dirs,
    ];
    const samePaths = signaturePaths.length === g.signaturePaths.length && signaturePaths.every((p, i) => p === g.signaturePaths[i]);
    g.signaturePaths = signaturePaths;
    // New paths (the baseline, a new branch folder) have no earlier stats;
    // take them now. A change in the moment since is caught by a watcher or
    // the periodic full read.
    g.signature = samePaths ? signature : await statSignature(signaturePaths);
    this.syncWatchers(g, read.dirs);
    if (!prev) return;
    this.publishChanges(g, diffSnapshots(prev, next), next, scanAt);
  }

  private syncWatchers(g: Group, refDirs: string[]): void {
    const endOperation = beginOperation('git watcher watch sync');
    try {
      this.syncWatchersNow(g, refDirs);
    } finally {
      endOperation();
    }
  }

  private syncWatchersNow(g: Group, refDirs: string[]): void {
    const ordered: string[] = [];
    if (this.recursiveWatch) {
      // The shared git dir holds refs, packed-refs and each linked worktree's
      // admin dir (worktrees/<name>); one outside it is watched on its own.
      ordered.push(g.commonDir);
      for (const wp of g.paths.values()) if (!within(g.key, keyOf(wp.gitDir))) ordered.push(wp.gitDir);
    } else {
      const refsRoot = path.join(g.commonDir, 'refs');
      ordered.push(g.commonDir, refsRoot);
      if (this.watchRemovableDirs) {
        for (const wp of g.paths.values()) ordered.push(wp.gitDir);
        ordered.push(...refDirs);
      } else {
        // refs/heads, refs/remotes and refs/remotes/<remote> only: deleting an
        // agent can remove anything deeper (and its .git/worktrees folder).
        for (const dir of refDirs) {
          const parts = path.relative(refsRoot, dir).split(path.sep);
          if (parts.length === 1 || (parts.length === 2 && parts[0] === 'remotes')) ordered.push(dir);
        }
      }
    }
    let want = [...new Set(ordered)];
    if (want.length > this.maxDirs) {
      if (!g.dirCapLogged) {
        appLog('core:app-events', 'warn', 'Too many ref directories for the git watcher; some branches may be late', {
          meta: { commonDir: g.commonDir, dirs: want.length, watched: this.maxDirs },
        });
        g.dirCapLogged = true;
      }
      want = want.slice(0, this.maxDirs);
    }
    const wantSet = new Set(want);
    for (const [dir, w] of g.watchers) {
      if (!wantSet.has(dir)) {
        this.closeWatcher(w);
        g.watchers.delete(dir);
      }
    }
    for (const dir of want) {
      if (g.watchers.has(dir)) continue;
      const recursive = this.recursiveWatch && dir === g.commonDir;
      const t = performance.now();
      try {
        const w = recursive
          ? this.watch(dir, (filename) => { if (isRefChange(filename)) this.schedule(g); }, { recursive: true })
          : this.watch(dir, () => this.schedule(g));
        this.watchersCreated++;
        w.on('error', () => {
          // The dir went away (a deleted branch folder, a removed worktree).
          // Its parent's watcher scans again; this one is re-added if it returns.
          this.closeWatcher(w);
          if (g.watchers.get(dir) === w) g.watchers.delete(dir);
        });
        g.watchers.set(dir, w);
      } catch {
        // telemetry-exempt: missing right now; the next scan tries again
      } finally {
        this.watchSyncMs += performance.now() - t;
      }
    }
  }

  /** The deepest watched path holding `cwd`. */
  private ownerOf(cwd: string): WatchedPath | undefined {
    const cwdKey = keyOf(cwd);
    let best: WatchedPath | undefined;
    let bestLen = -1;
    for (const g of this.groups.values()) {
      for (const wp of g.paths.values()) {
        for (const k of [wp.key, wp.realKey]) {
          if (k && within(k, cwdKey) && k.length > bestLen) {
            best = wp;
            bestLen = k.length;
          }
        }
      }
    }
    return best;
  }

  /**
   * The newest uncredited agent call with one of these verbs that ran in one
   * of these worktrees before the scan; it is then credited for `credit`.
   */
  private attribute(
    credit: Credit,
    verbs: readonly GitVerb[],
    candidates: readonly WatchedPath[],
    records: readonly GitCommandRecord[],
  ): { agentId: string; at: WatchedPath } | undefined {
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i];
      if (rec.credited.includes(credit) || !verbs.includes(rec.verb)) continue;
      const cwd = rec.cwd ?? this.agentCwd(rec.agentId);
      if (!cwd) continue;
      const owner = this.ownerOf(cwd);
      if (owner && candidates.includes(owner)) {
        rec.credited.push(credit);
        return { agentId: rec.agentId, at: owner };
      }
    }
    return undefined;
  }

  private publishChanges(g: Group, changes: GitChange[], snapshot: RepoSnapshot, scanAt: number): void {
    if (changes.length === 0) return;
    const records = this.recentCommands(scanAt);
    const remote: Array<{ remote: string; branch: string }> = [];
    for (const change of changes) {
      if (change.type === 'remote_updated') {
        remote.push(change);
        continue;
      }
      const wp = g.paths.get(change.worktree);
      if (!wp) continue;
      if (change.type === 'commit') {
        const hit = this.attribute('commit', COMMIT_VERBS, [wp], records);
        this.publish({ type: 'git.commit', repoPath: wp.path, branch: change.branch, ...(hit && { agentId: hit.agentId }) });
      } else {
        const hit = this.attribute('switch', SWITCH_VERBS, [wp], records);
        this.publish({
          type: 'git.branch_switched', repoPath: wp.path, branch: change.branch,
          ...(change.previousBranch !== undefined && { previousBranch: change.previousBranch }),
          ...(hit && { agentId: hit.agentId }),
        });
      }
    }
    if (remote.length === 0) return;
    // Remote-tracking refs are shared by every worktree of the repo. One
    // push or fetch is one attribution for the whole scan. Name the worktree
    // where it ran, else the one on that branch, else the main worktree.
    const all = [...g.paths.values()];
    const hit = this.attribute('remote', REMOTE_VERBS, all, records);
    const main = all.find((wp) => keyOf(wp.gitDir) === g.key) ?? all[0];
    const checkedOut = new Set<string>();
    for (const wp of all) {
      const branch = snapshot.worktrees.get(wp.key)?.branch;
      if (branch) checkedOut.add(branch);
    }
    for (const update of coalesceRemoteUpdates(remote, checkedOut)) {
      const onBranch = all.find((wp) => snapshot.worktrees.get(wp.key)?.branch === update.branch);
      const repo = hit?.at ?? onBranch ?? main;
      if (!repo) continue;
      this.publish({
        type: 'git.remote_updated', repoPath: repo.path, branch: update.branch, remote: update.remote,
        ...(hit && { agentId: hit.agentId }),
      });
    }
  }
}

// ── App wiring ──────────────────────────────────────────────────────────────

/** How long to gather project and agent config changes before re-reading the paths. */
const REFRESH_DEBOUNCE_MS = 1_000;

let active: { watcher: GitWatcher; unsubs: Array<() => void>; timer: ReturnType<typeof setTimeout> | null } | null = null;
/** Where each durable agent works: its worktree, or the project root. */
const agentHomes = new Map<string, string>();

async function collectPaths(): Promise<string[]> {
  const projects = await projectStore.list();
  const roots: string[] = [];
  const worktrees: string[] = [];
  const homes = new Map<string, string>();
  for (const project of projects) {
    roots.push(project.path);
    let configs: Awaited<ReturnType<typeof listDurable>> = [];
    try {
      configs = await listDurable(project.path);
    } catch (err) {
      // telemetry-exempt: logged; the project root is still watched
      appLog('core:app-events', 'warn', 'The git watcher could not read a project\'s agents', {
        meta: { projectPath: project.path, error: err instanceof Error ? err.message : String(err) },
      });
    }
    for (const c of configs) {
      if (isDisposedAgent(c)) continue;
      homes.set(c.id, c.worktreePath || project.path);
      if (c.worktreePath) worktrees.push(c.worktreePath);
    }
  }
  agentHomes.clear();
  for (const [id, home] of homes) agentHomes.set(id, home);
  // Roots first: past the repo cap, agent worktrees are left out, never a
  // whole project, and a helper coming or going doesn't shift the cut onto
  // another project's root (dropping and re-adding its watches, #3230).
  return [...roots, ...worktrees];
}

async function refresh(): Promise<void> {
  const current = active;
  if (!current) return;
  try {
    const paths = await collectPaths();
    if (active !== current) return;
    await current.watcher.setPaths(paths);
  } catch (err) {
    // telemetry-exempt: logged; the next project or agent change refreshes again
    appLog('core:app-events', 'warn', 'The git watcher could not refresh its repos', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

function scheduleRefresh(): void {
  const current = active;
  if (!current) return;
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    current.timer = null;
    void refresh();
  }, REFRESH_DEBOUNCE_MS);
  current.timer.unref?.();
}

/** Start watching every project and agent worktree. Resolves once the baselines are read. */
export async function startGitWatcher(options: Omit<GitWatcherOptions, 'agentCwd'> = {}): Promise<void> {
  if (active) return;
  const watcher = new GitWatcher({ ...options, agentCwd: (id) => getAgentCwd(id) ?? agentHomes.get(id) });
  active = { watcher, unsubs: [], timer: null };
  active.unsubs.push(
    projectStore.onProjectsChanged(scheduleRefresh),
    onAgentConfigChanged(scheduleRefresh),
    // Terminal hooks feed the command log from hook-server.
    onChatEvent((event) => {
      if (event.type === 'tool_call') noteAgentToolCall(event.agentId, event.data.rawInput, { callId: event.data.toolCallId });
    }),
  );
  await refresh();
}

export function stopGitWatcher(): void {
  if (!active) return;
  if (active.timer) clearTimeout(active.timer);
  for (const u of active.unsubs) u();
  active.watcher.close();
  active = null;
  agentHomes.clear();
}
