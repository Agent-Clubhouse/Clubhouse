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
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chatListeners: Array<(event: unknown) => void> = [];
let projects: Array<{ id: string; path: string }> = [];
let durables: Record<string, Array<Record<string, unknown>>> = {};

vi.mock('./agent-config', () => ({
  listDurable: vi.fn(async (p: string) => durables[p] ?? []),
  onAgentConfigChanged: vi.fn(() => () => undefined),
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

import { onAppEvent, resetAppEventBus, type AppEvent, type AppEventInput } from './app-event-bus';
import { resetGitCommandLog, type GitCommandRecord } from './git-command-log';
import { GitWatcher, readRefs, resolveGitDirs, startGitWatcher, stopGitWatcher } from './git-watcher';

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

interface FakeWatch { dir: string; fire: () => void; closed: boolean }
let watches: FakeWatch[];
function fakeWatch(dir: string, onChange: () => void): fsTypes.FSWatcher {
  const entry: FakeWatch = { dir, fire: onChange, closed: false };
  watches.push(entry);
  return Object.assign(new EventEmitter(), { close: () => { entry.closed = true; } }) as unknown as fsTypes.FSWatcher;
}

let events: AppEventInput[];
let records: GitCommandRecord[];
let cwds: Record<string, string>;
let watcher: GitWatcher | null;

function newWatcher(extra: { maxRepos?: number; pollMs?: number } = {}): GitWatcher {
  watcher = new GitWatcher({
    publish: (e) => events.push(e),
    debounceMs: 20,
    pollMs: 0,
    watch: fakeWatch,
    agentCwd: (id) => cwds[id],
    recentCommands: () => records,
    ...extra,
  });
  return watcher;
}

beforeEach(() => {
  events = [];
  records = [];
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
    records = [{ agentId: 'a1', verbs: ['commit'], at: Date.now() }];
    await newWatcher().setPaths([repo, wt]);
    commit(wt, 'b.txt');
    await watcher!.rescan();
    commit(repo, 'c.txt');
    await watcher!.rescan();
    expect(events).toEqual([
      { type: 'git.commit', repoPath: wt, branch: 'agent', agentId: 'a1' },
      { type: 'git.commit', repoPath: repo, branch: 'main' },
    ]);
  });

  it('attributes a command run in a subfolder of the worktree', async () => {
    const { repo, wt } = makeRepo();
    records = [{ agentId: 'a1', verbs: ['commit'], cwd: path.join(wt, 'src'), at: Date.now() }];
    await newWatcher().setPaths([repo, wt]);
    commit(wt, 'b.txt');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt, branch: 'agent', agentId: 'a1' }]);
  });

  it('only names an agent for a matching command', async () => {
    const { repo, wt } = makeRepo();
    records = [{ agentId: 'a1', verbs: ['push'], cwd: wt, at: Date.now() }];
    await newWatcher().setPaths([repo, wt]);
    commit(wt, 'b.txt');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.commit', repoPath: wt, branch: 'agent' }]);
  });

  it('names the pushing agent and its worktree for a remote update', async () => {
    const { repo, wt } = makeRepo();
    addRemote(repo);
    records = [{ agentId: 'a1', verbs: ['push'], cwd: wt, at: Date.now() }];
    await newWatcher().setPaths([repo, wt]);
    git(wt, 'push', '-q', 'origin', 'main');
    await watcher!.rescan();
    expect(events).toEqual([{ type: 'git.remote_updated', repoPath: wt, branch: 'main', remote: 'origin', agentId: 'a1' }]);
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
});
