/**
 * The git watcher against real repos. The directory watchers are fakes
 * (macOS delivers real fs.watch events late or not at all, see
 * agent-config-watcher.test.ts); tests read repos with rescan(), fire a fake
 * watcher, or let the poll find the change.
 */
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type * as fsTypes from 'node:fs';
import * as fs from 'node:fs';
import * as fsp from 'fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test spawns several git processes, which can crawl on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const chatListeners: Array<(event: unknown) => void> = [];
const configListeners: Array<() => void> = [];
let projects: Array<{ id: string; path: string }> = [];
let durables: Record<string, Array<Record<string, unknown>>> = {};

vi.mock('./agent-config', () => ({
  listDurable: vi.fn(async (p: string) => durables[p] ?? []),
  onAgentConfigChanged: vi.fn((l: () => void) => { configListeners.push(l); return () => undefined; }),
}));
vi.mock('./agent-registry', () => ({ getAgentCwd: vi.fn(() => undefined) }));
vi.mock('./agent-runtime/chat-event-bus', () => ({
  onChatEvent: vi.fn((l: (event: unknown) => void) => { chatListeners.push(l); return () => undefined; }),
}));
vi.mock('./project-store', () => ({
  list: vi.fn(async () => projects),
  onProjectsChanged: vi.fn(() => () => undefined),
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
// Real fs, with readFile watched for the order and number of reads.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readFile = vi.fn(actual.readFile);
  const readdir = vi.fn(actual.readdir);
  return { ...actual, default: { ...actual, readFile, readdir }, readFile, readdir };
});

import { appLog } from './log-service';
import { onAppEvent, resetAppEventBus, type AppEvent, type AppEventInput } from './app-event-bus';
import { noteAgentToolCall, resetGitCommandLog } from './git-command-log';
import {
  GitWatcher, MANY_BRANCHES, readRefs, resolveGitDirs, startGitWatcher, stopGitWatcher, type GitWatcherOptions,
} from './git-watcher';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, stdio: 'pipe' }).toString().trim();
}

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-watch-'));
  temps.push(dir);
  return dir;
}

function commit(cwd: string, name: string): void {
  fs.writeFileSync(path.join(cwd, name), name);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', name);
}

/** A repo on main with one commit, and an agent worktree inside it on branch `agent`. */
function makeRepo(): { repo: string; wt: string } {
  const repo = tempDir();
  git(repo, 'init', '-q');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  commit(repo, 'a.txt');
  const wt = path.join(repo, '.clubhouse', 'agents', 'a1');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent', wt);
  return { repo, wt };
}

function addRemote(repo: string): void {
  const remote = tempDir();
  git(remote, 'init', '-q', '--bare');
  git(repo, 'remote', 'add', 'origin', remote);
}

async function waitFor(check: () => boolean, ms = 4_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface FakeWatch { dir: string; fire: (filename?: string | null) => void; closed: boolean; recursive: boolean }
let watches: FakeWatch[];
function fakeWatch(dir: string, onChange: (filename?: string | null) => void, opts?: { recursive?: boolean }): fsTypes.FSWatcher {
  const entry: FakeWatch = { dir, fire: onChange, closed: false, recursive: opts?.recursive ?? false };
  watches.push(entry);
  return Object.assign(new EventEmitter(), { close: () => { entry.closed = true; } }) as unknown as fsTypes.FSWatcher;
}

let events: AppEventInput[];
let cwds: Record<string, string>;
let watcher: GitWatcher | null;

function newWatcher(extra: Partial<GitWatcherOptions> = {}): GitWatcher {
  watcher = new GitWatcher({
    publish: (e) => events.push(e),
    debounceMs: 20,
    pollMs: 0,
    watch: fakeWatch,
    watchRemovableDirs: true,
    recursiveWatch: false,
    agentCwd: (id) => cwds[id],
    ...extra,
  });
  return watcher;
}

/** An agent's shell ran this command (as a hook would note it). */
function ran(agentId: string, command: string, cwd?: string): void {
  noteAgentToolCall(agentId, { command }, { cwd });
}

beforeEach(() => {
  events = [];
  cwds = {};
  watches = [];
  watcher = null;
});

afterEach(() => {
  watcher?.close();
  stopGitWatcher();
  resetAppEventBus();
  resetGitCommandLog();
  chatListeners.length = 0;
  configListeners.length = 0;
  for (const dir of temps.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Best effort on Windows.
    }
  }
});

describe('reading repos', () => {
  it('resolves a linked worktree to its own HEAD dir and the shared common dir', async () => {
    const { repo, wt } = makeRepo();
    const main = await resolveGitDirs(repo);
    const linked = await resolveGitDirs(wt);
    const real = (p: string) => fs.realpathSync.native(p);
    expect(main!.gitDir).toBe(real(path.join(repo, '.git')));
    expect(main!.commonDir).toBe(real(path.join(repo, '.git')));
    expect(linked!.commonDir).toBe(real(path.join(repo, '.git')));
    expect(linked!.gitDir).toBe(real(path.join(repo, '.git', 'worktrees', 'a1')));
    expect(await resolveGitDirs(tempDir())).toBeNull();
  });

  it('reads loose and packed refs the same', async () => {
    const { repo } = makeRepo();
    const loose = await readRefs(path.join(repo, '.git'));
    git(repo, 'pack-refs', '--all');
    const packed = await readRefs(path.join(repo, '.git'));
    expect(packed.ok).toBe(true);
    expect([...packed.refs].sort()).toEqual([...loose.refs].sort());
    expect(packed.refs.get('refs/heads/main')).toBe(git(repo, 'rev-parse', 'main'));
  });

  it('reads loose refs before packed-refs, so a pack in between never shows an older value', async () => {
    const { repo } = makeRepo();
    git(repo, 'pack-refs', '--all');
    commit(repo, 'b.txt');
    const read = vi.mocked(fsp.readFile);
    read.mockClear();
    const refs = await readRefs(path.join(repo, '.git'));
    const files = read.mock.calls.map((c) => path.basename(String(c[0])));
    expect(files.indexOf('main')).toBeGreaterThanOrEqual(0);
    expect(files.indexOf('main')).toBeLessThan(files.indexOf('packed-refs'));
    // The loose value (newer) wins over the packed one.
    expect(refs.refs.get('refs/heads/main')).toBe(git(repo, 'rev-parse', 'main'));
  });
});

describe('GitWatcher', () => {
  it('watches the shared git dir once, with each worktree\'s HEAD dir', async () => {
    const { repo, wt } = makeRepo();
    await newWatcher().setPaths([repo, wt]);
    const common = fs.realpathSync.native(path.join(repo, '.git'));
    expect(watches.map((w) => w.dir).sort()).toEqual([
      common,
      path.join(common, 'refs'),
      path.join(common, 'refs', 'heads'),
      path.join(common, 'worktrees', 'a1'),
    ].sort());
  });

  it('reports a commit in a worktree for that worktree only', async () => {
    const { repo, wt } = makeRepo();
    await newWatcher().setPaths([repo, wt]);
    commit(wt, 'b.txt');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt, branch: 'agent' }]);
  });

  it('reports a commit in the main worktree for it only', async () => {
    const { repo, wt } = makeRepo();
    await newWatcher().setPaths([repo, wt]);
    commit(repo, 'b.txt');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: repo, branch: 'main' }]);
  });

  it('reports a branch switch, then commits on a nested branch name, watching its new folder', async () => {
    const { repo } = makeRepo();
    await newWatcher().setPaths([repo]);
    git(repo, 'checkout', '-q', '-b', 'feature/x');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.branch_switched', repoPath: repo, branch: 'feature/x', previousBranch: 'main' }]);
    const featureDir = path.join(fs.realpathSync.native(path.join(repo, '.git')), 'refs', 'heads', 'feature');
    expect(watches.some((w) => w.dir === featureDir && !w.closed)).toBe(true);
    events.length = 0;
    commit(repo, 'b.txt');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: repo, branch: 'feature/x' }]);
  });

  it('reports nothing when refs are only packed', async () => {
    const { repo, wt } = makeRepo();
    await newWatcher().setPaths([repo, wt]);
    git(repo, 'pack-refs', '--all');
    await watcher!.rescan();
    expect(events).toEqual([]);
  });

  it('reports a push as a remote-tracking update on the worktree that is on that branch', async () => {
    const { repo, wt } = makeRepo();
    addRemote(repo);
    await newWatcher().setPaths([repo, wt]);
    git(wt, 'push', '-q', 'origin', 'agent');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.remote_updated', repoPath: wt, branch: 'agent', remote: 'origin' }]);
  });

  it('scans after a watcher event, debounced', async () => {
    const { repo } = makeRepo();
    await newWatcher().setPaths([repo]);
    commit(repo, 'b.txt');
    for (const w of watches) w.fire();
    await waitFor(() => events.length > 0);
    await new Promise((r) => setTimeout(r, 60));
    expect(events).toEqual([{ type: 'git.commit', repoPath: repo, branch: 'main' }]);
  });

  it('finds a change with no watcher event, on the poll', async () => {
    const { repo } = makeRepo();
    await newWatcher({ pollMs: 25 }).setPaths([repo]);
    commit(repo, 'b.txt');
    await waitFor(() => events.length > 0);
    expect(events).toEqual([{ type: 'git.commit', repoPath: repo, branch: 'main' }]);
  });

  it('names the agent that just ran the command in its worktree, and nobody in the project root around it', async () => {
    const { repo, wt } = makeRepo();
    cwds = { a1: wt };
    await newWatcher().setPaths([repo, wt]);
    ran('a1', 'git commit -am x');
    commit(wt, 'b.txt');
    await watcher!.rescan();
    commit(repo, 'c.txt');
    await watcher!.rescan();
    expect(events).toEqual([
      { type: 'git.commit', repoPath: wt, branch: 'agent', agentId: 'a1' },
      { type: 'git.commit', repoPath: repo, branch: 'main' },
    ]);
  });

  it('credits one command once: a later commit with no new command names nobody', async () => {
    const { repo, wt } = makeRepo();
    await newWatcher().setPaths([repo, wt]);
    ran('a1', 'git commit -m x', wt);
    commit(wt, 'b.txt');
    await watcher!.rescan();
    commit(wt, 'c.txt');
    await watcher!.rescan();
    expect(events).toEqual([
      { type: 'git.commit', repoPath: wt, branch: 'agent', agentId: 'a1' },
      { type: 'git.commit', repoPath: wt, branch: 'agent' },
    ]);
  });

  it('uses the hook\'s cwd and git -C over where the agent started', async () => {
    const { repo, wt } = makeRepo();
    // The agent started in the project root but committed in its worktree.
    cwds = { a1: repo };
    await newWatcher().setPaths([repo, wt]);
    ran('a1', 'git -C .clubhouse/agents/a1 commit -m x', repo);
    commit(wt, 'b.txt');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt, branch: 'agent', agentId: 'a1' }]);
  });

  it('attributes a command run in a subfolder of the worktree', async () => {
    const { repo, wt } = makeRepo();
    await newWatcher().setPaths([repo, wt]);
    ran('a1', 'git commit -m x', path.join(wt, 'src'));
    commit(wt, 'b.txt');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt, branch: 'agent', agentId: 'a1' }]);
  });

  it('only names an agent for a matching command', async () => {
    const { repo, wt } = makeRepo();
    await newWatcher().setPaths([repo, wt]);
    ran('a1', 'git push', wt);
    commit(wt, 'b.txt');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt, branch: 'agent' }]);
  });

  it('names the pushing agent and its worktree for a remote update', async () => {
    const { repo, wt } = makeRepo();
    addRemote(repo);
    ran('a1', 'git push origin main', wt);
    await newWatcher().setPaths([repo, wt]);
    git(wt, 'push', '-q', 'origin', 'main');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.remote_updated', repoPath: wt, branch: 'main', remote: 'origin', agentId: 'a1' }]);
  });

  it('reports a big push as one event for the remote plus the checked-out branches, attributed once', async () => {
    const { repo, wt } = makeRepo();
    addRemote(repo);
    for (let i = 0; i < 25; i++) git(repo, 'branch', `b${i}`);
    await newWatcher().setPaths([repo, wt]);
    ran('a1', 'git push --all origin', wt);
    git(wt, 'push', '-q', '--all', 'origin');
    await watcher!.rescan();
    const sorted = [...events].sort((a, b) => ('branch' in a && 'branch' in b ? a.branch.localeCompare(b.branch) : 0));
    expect(sorted).toEqual([
      { type: 'git.remote_updated', repoPath: wt, branch: MANY_BRANCHES, remote: 'origin', agentId: 'a1' },
      { type: 'git.remote_updated', repoPath: wt, branch: 'agent', remote: 'origin', agentId: 'a1' },
      { type: 'git.remote_updated', repoPath: wt, branch: 'main', remote: 'origin', agentId: 'a1' },
    ]);
  });

  it('on Windows, leaves folders that deleting an agent removes to the poll', async () => {
    const { repo, wt } = makeRepo();
    addRemote(repo);
    git(repo, 'branch', 'feature/x');
    git(repo, 'push', '-q', 'origin', 'feature/x');
    await newWatcher({ watchRemovableDirs: false }).setPaths([repo, wt]);
    const common = fs.realpathSync.native(path.join(repo, '.git'));
    expect(watches.map((w) => w.dir).sort()).toEqual([
      common,
      path.join(common, 'refs'),
      path.join(common, 'refs', 'heads'),
      path.join(common, 'refs', 'remotes'),
      path.join(common, 'refs', 'remotes', 'origin'),
    ].sort());
    // A switch in the linked worktree (its HEAD folder unwatched) still shows on a read.
    git(wt, 'checkout', '-q', '-b', 'other');
    await watcher!.pollOnce();
    expect(events).toEqual([{ type: 'git.branch_switched', repoPath: wt, branch: 'other', previousBranch: 'agent' }]);
  });

  it('skips a poll\'s full read when nothing looks changed, and reads when something did', async () => {
    const { repo } = makeRepo();
    await newWatcher().setPaths([repo]);
    // Let the mtimes of the baseline settle behind us.
    await new Promise((r) => setTimeout(r, 20));
    vi.mocked(fsp.readFile).mockClear();
    await watcher!.pollOnce();
    expect(vi.mocked(fsp.readFile)).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    commit(repo, 'b.txt');
    await watcher!.pollOnce();
    expect(events).toEqual([{ type: 'git.commit', repoPath: repo, branch: 'main' }]);
  });

  it('watches one worktree once though it is registered under two spellings', async () => {
    const { repo } = makeRepo();
    const link = path.join(tempDir(), 'link');
    fs.symlinkSync(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
    await newWatcher().setPaths([repo, link]);
    commit(repo, 'b.txt');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: repo, branch: 'main' }]);
  });

  it('logs and skips a reftable repo', async () => {
    const repo = tempDir();
    fs.mkdirSync(path.join(repo, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = reftable\n');
    vi.mocked(appLog).mockClear();
    const w = newWatcher();
    await w.setPaths([repo]);
    await w.setPaths([repo]);
    expect(w.watchedDirCount()).toBe(0);
    expect(vi.mocked(appLog).mock.calls.filter((c) => String(c[2]).includes('reftable'))).toHaveLength(1);
    await w.rescan();
    expect(events).toEqual([]);
  });

  it('caps the repos it watches', async () => {
    const one = makeRepo();
    const two = makeRepo();
    await newWatcher({ maxRepos: 1 }).setPaths([one.repo, two.repo]);
    commit(two.repo, 'b.txt');
    commit(one.repo, 'b.txt');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: one.repo, branch: 'main' }]);
  });

  it('closes the watchers of a dropped path, and all of them on close', async () => {
    const { repo, wt } = makeRepo();
    const w = newWatcher();
    await w.setPaths([repo, wt]);
    const wtDir = fs.realpathSync.native(path.join(repo, '.git', 'worktrees', 'a1'));
    await w.setPaths([repo]);
    expect(watches.find((x) => x.dir === wtDir)?.closed).toBe(true);
    expect(w.watchedDirCount()).toBe(3);
    w.close();
    expect(w.watchedDirCount()).toBe(0);
    expect(watches.every((x) => x.closed)).toBe(true);
    commit(repo, 'b.txt');
    await w.rescan();
    expect(events).toEqual([]);
  });

  it('refreshes registered path spelling when worktree membership is unchanged', async () => {
    const { repo, wt } = makeRepo();
    const w = newWatcher({ recursiveWatch: true });
    await w.setPaths([repo, wt]);
    const registered = `${repo}${path.sep}`;
    await w.setPaths([registered, wt]);
    expect(w.lastRebuildStats()).toMatchObject({ groupsKept: 1, watchersCreated: 0, watchersClosed: 0 });
    commit(repo, 'spelling.txt');
    await w.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: registered, branch: 'main' }]);
  });

  it('adds and closes watchers only for the worktrees that came or went, and reports the rebuild (#3230)', async () => {
    const { repo, wt } = makeRepo();
    const other = makeRepo();
    const w = newWatcher();
    await w.setPaths([repo, wt, other.repo]);
    const first = watches.length;
    expect(w.lastRebuildStats()).toMatchObject({ repos: 3, watched: 3, groupsAdded: 2, groupsRemoved: 0, groupsKept: 0, watchersCreated: first, watchersClosed: 0 });

    // A helper is created: one new worktree joins the first repo.
    const wt2 = path.join(repo, '.clubhouse', 'agents', 'a2');
    git(repo, 'worktree', 'add', '-q', '-b', 'agent2', wt2);
    await w.setPaths([repo, wt, wt2, other.repo]);
    const wt2Dir = fs.realpathSync.native(path.join(repo, '.git', 'worktrees', 'a2'));
    expect(watches.slice(first).map((x) => x.dir)).toEqual([wt2Dir]);
    expect(watches.some((x) => x.closed)).toBe(false);
    expect(w.lastRebuildStats()).toMatchObject({ repos: 4, groupsAdded: 0, groupsRemoved: 0, groupsKept: 2, watchersCreated: 1, watchersClosed: 0 });

    // Then disposed: only its watcher closes; the other repo's are left alone.
    await w.setPaths([repo, wt, other.repo]);
    expect(watches.filter((x) => x.closed).map((x) => x.dir)).toEqual([wt2Dir]);
    expect(w.lastRebuildStats()).toMatchObject({ groupsKept: 2, watchersCreated: 0, watchersClosed: 1 });
    expect(appLog).toHaveBeenCalledWith('core:app-events', 'info', 'The git watcher rebuilt its repo list', {
      meta: expect.objectContaining({ groupsKept: 2, watchersClosed: 1, totalMs: expect.any(Number), watchSyncMs: expect.any(Number) }),
    });
  });
});

describe('GitWatcher, one recursive watch per repo (macOS, #3230)', () => {
  it('watches only the shared git dir, recursively', async () => {
    const { repo, wt } = makeRepo();
    await newWatcher({ recursiveWatch: true }).setPaths([repo, wt]);
    expect(watches).toEqual([expect.objectContaining({ dir: fs.realpathSync.native(path.join(repo, '.git')), recursive: true })]);
  });

  it('scans for a ref change and not for objects or the index', async () => {
    const { repo, wt } = makeRepo();
    const w = newWatcher({ recursiveWatch: true, debounceMs: 10 });
    await w.setPaths([repo, wt]);
    commit(wt, 'b.txt');
    watches[0].fire('objects/ab/cdef');
    watches[0].fire(path.join('worktrees', 'a1', 'index'));
    watches[0].fire('logs/HEAD');
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toEqual([]);
    watches[0].fire(path.join('refs', 'heads', 'agent.lock'));
    await waitFor(() => events.length > 0);
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt, branch: 'agent' }]);
  });

  it('sees a branch switch in a linked worktree through its admin dir HEAD', async () => {
    const { repo, wt } = makeRepo();
    const w = newWatcher({ recursiveWatch: true, debounceMs: 10 });
    await w.setPaths([repo, wt]);
    git(wt, 'checkout', '-q', '-b', 'next');
    watches[0].fire(path.join('worktrees', 'a1', 'HEAD'));
    await waitFor(() => events.length > 0);
    expect(events).toEqual([{ type: 'git.branch_switched', repoPath: wt, branch: 'next', previousBranch: 'agent' }]);
  });

  it('does not walk shared refs or reread existing HEADs for worktree membership changes (#3230)', async () => {
    const { repo, wt } = makeRepo();
    const w = newWatcher({ recursiveWatch: true });
    await w.setPaths([repo, wt]);
    const wt2 = path.join(repo, '.clubhouse', 'agents', 'a2');
    git(repo, 'worktree', 'add', '-q', '-b', 'helper/x', wt2);
    vi.mocked(fsp.readdir).mockClear();
    vi.mocked(fsp.readFile).mockClear();
    await w.setPaths([repo, wt, wt2]);
    expect(fsp.readdir).not.toHaveBeenCalled();
    const heads = vi.mocked(fsp.readFile).mock.calls.filter(([p]) => path.basename(String(p)) === 'HEAD');
    expect(heads).toHaveLength(1);
    expect(String(heads[0][0])).toContain(`${path.sep}a2${path.sep}HEAD`);
    await w.rescan();
    expect(events).toEqual([]); // Joining is a baseline, including its new branch.
    commit(wt2, 'helper.txt');
    await w.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt2, branch: 'helper/x' }]);
    vi.mocked(fsp.readdir).mockClear();
    vi.mocked(fsp.readFile).mockClear();
    await w.setPaths([repo, wt]);
    expect(fsp.readdir).not.toHaveBeenCalled();
    expect(vi.mocked(fsp.readFile).mock.calls.filter(([p]) => path.basename(String(p)) === 'HEAD')).toHaveLength(0);
    expect(w.lastRebuildStats()).toMatchObject({ watchersCreated: 0, watchersClosed: 0 });
  });

  it('baselines a packed branch without hiding changes to existing worktrees', async () => {
    const { repo, wt } = makeRepo();
    git(repo, 'branch', 'packed-helper');
    git(repo, 'pack-refs', '--all');
    const w = newWatcher({ recursiveWatch: true });
    await w.setPaths([repo, wt]);
    const wt2 = path.join(repo, '.clubhouse', 'agents', 'a2');
    commit(wt, 'existing.txt');
    git(repo, 'branch', '-f', 'packed-helper', 'agent');
    git(repo, 'pack-refs', '--all');
    git(repo, 'worktree', 'add', '-q', wt2, 'packed-helper');
    await w.setPaths([repo, wt, wt2]);
    await w.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt, branch: 'agent' }]);
    events.length = 0;
    commit(wt2, 'new.txt');
    await w.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt2, branch: 'packed-helper' }]);
  });

  it('serializes a ref event arriving while a new HEAD is being baselined', async () => {
    const { repo, wt } = makeRepo();
    const w = newWatcher({ recursiveWatch: true, debounceMs: 1 });
    await w.setPaths([repo, wt]);
    const wt2 = path.join(repo, '.clubhouse', 'agents', 'a2');
    git(repo, 'worktree', 'add', '-q', '-b', 'helper/x', wt2);
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    let release!: () => void;
    let readingHead = false;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(fsp.readFile).mockImplementation((async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).endsWith(`${path.sep}a2${path.sep}HEAD`)) {
        readingHead = true;
        await barrier;
      }
      return actual.readFile(...args);
    }) as typeof actual.readFile);
    const update = w.setPaths([repo, wt, wt2]);
    try {
      await waitFor(() => readingHead);
      commit(wt, 'during-update.txt');
      watches[0].fire('refs/heads/agent');
      await new Promise((r) => setTimeout(r, 30));
      expect(events).toEqual([]);
    } finally {
      release();
      await update;
    }
    await waitFor(() => events.length > 0);
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt, branch: 'agent' }]);
  });

  it('coalesces overlapping path requests into one rebuild of the latest paths (#3230)', async () => {
    const { repo, wt } = makeRepo();
    const w = newWatcher({ recursiveWatch: true });
    const before = vi.mocked(appLog).mock.calls.length;
    await Promise.all(Array.from({ length: 25 }, (_, i) => w.setPaths(i === 24 ? [repo, wt] : [repo])));
    const rebuilds = vi.mocked(appLog).mock.calls.slice(before).filter((c) => c[2] === 'The git watcher rebuilt its repo list');
    expect(rebuilds).toHaveLength(1);
    expect(w.lastRebuildStats()).toMatchObject({ repos: 2 });
    commit(wt, 'helper.txt');
    await w.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt, branch: 'agent' }]);
  });

  it('creates and closes no watchers when a helper worktree comes and goes', async () => {
    const { repo, wt } = makeRepo();
    const w = newWatcher({ recursiveWatch: true });
    await w.setPaths([repo, wt]);
    const wt2 = path.join(repo, '.clubhouse', 'agents', 'a2');
    git(repo, 'worktree', 'add', '-q', '-b', 'helper/x', wt2);
    await w.setPaths([repo, wt, wt2]);
    expect(w.lastRebuildStats()).toMatchObject({ groupsKept: 1, watchersCreated: 0, watchersClosed: 0 });
    git(repo, 'worktree', 'remove', '--force', wt2);
    git(repo, 'branch', '-q', '-D', 'helper/x');
    await w.setPaths([repo, wt]);
    expect(w.lastRebuildStats()).toMatchObject({ groupsKept: 1, watchersCreated: 0, watchersClosed: 0 });
    expect(watches).toHaveLength(1);
    expect(watches[0].closed).toBe(false);
  });
});

describe('startGitWatcher', () => {
  it('watches projects and agent worktrees, and attributes from chat tool calls', async () => {
    const { repo, wt } = makeRepo();
    projects = [{ id: 'p1', path: repo }];
    durables = { [repo]: [{ id: 'a1', worktreePath: wt }, { id: 'gone', worktreePath: path.join(repo, 'x'), disposedAt: 'then' }] };
    const published: AppEvent[] = [];
    onAppEvent((e) => published.push(e));
    await startGitWatcher({ watch: fakeWatch, pollMs: 25 });
    expect(chatListeners).toHaveLength(1);
    chatListeners[0]({
      type: 'tool_call', agentId: 'a1',
      data: { toolCallId: 't', kind: 'execute', title: 'Bash', status: 'pending', rawInput: { command: 'git commit -am x' } },
    });
    commit(wt, 'b.txt');
    await waitFor(() => published.some((e) => e.type === 'git.commit'));
    expect(published.filter((e) => e.type.startsWith('git.'))).toMatchObject([
      { type: 'git.commit', repoPath: wt, branch: 'agent', agentId: 'a1' },
    ]);
  });

  it('rebuilds once for a burst of agent config changes, such as one helper create (#3230)', async () => {
    const { repo, wt } = makeRepo();
    projects = [{ id: 'p1', path: repo }];
    durables = { [repo]: [{ id: 'a1', worktreePath: wt }] };
    await startGitWatcher({ watch: fakeWatch, pollMs: 0 });
    const rebuilds = () => vi.mocked(appLog).mock.calls.filter((c) => c[2] === 'The git watcher rebuilt its repo list').length;
    const before = rebuilds();
    // agents.json is written about five times while a helper is created.
    for (let i = 0; i < 5; i++) {
      configListeners[0]();
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(rebuilds()).toBe(before);
    await waitFor(() => rebuilds() > before, 5_000);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(rebuilds()).toBe(before + 1);
  });

  it('keeps every project root under the repo cap, leaving out agent worktrees instead (#3230)', async () => {
    const one = makeRepo();
    const two = makeRepo();
    projects = [{ id: 'p1', path: one.repo }, { id: 'p2', path: two.repo }];
    durables = { [one.repo]: [{ id: 'a1', worktreePath: one.wt }] };
    const published: AppEvent[] = [];
    onAppEvent((e) => published.push(e));
    await startGitWatcher({ watch: fakeWatch, pollMs: 25, maxRepos: 2 });
    commit(two.repo, 'b.txt');
    await waitFor(() => published.some((e) => e.type === 'git.commit'));
    expect(published.filter((e) => e.type === 'git.commit')).toMatchObject([{ repoPath: two.repo, branch: 'main' }]);
  });
});
