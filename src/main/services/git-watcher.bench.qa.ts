/**
 * Micro-benchmark for the git watcher's rebuild (#3230); not part of CI.
 * Run with `npm run bench:git-watcher` (GIT_WATCH_BENCH_N worktrees, default
 * 60). It builds one repo with N linked worktrees on nested branch names (as
 * Clubhouse agents have), then with real fs.watch times a helper being
 * created and disposed, once watching folders (Linux, Windows, and macOS
 * before #3230) and once with one recursive watch (macOS now). For each step
 * it prints the rebuild stats and the main thread's worst timer delay.
 * Numbers depend heavily on machine load: on macOS a watch close waits on
 * fseventsd.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it, vi } from 'vitest';

vi.mock('./agent-config', () => ({ listDurable: vi.fn(async () => []), onAgentConfigChanged: vi.fn(() => () => undefined) }));
vi.mock('./agent-registry', () => ({ getAgentCwd: vi.fn(() => undefined) }));
vi.mock('./agent-runtime/chat-event-bus', () => ({ onChatEvent: vi.fn(() => () => undefined) }));
vi.mock('./project-store', () => ({ list: vi.fn(async () => []), onProjectsChanged: vi.fn(() => () => undefined) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { GitWatcher, type RebuildStats } from './git-watcher';

const N = Number(process.env.GIT_WATCH_BENCH_N) || 60;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=B', '-c', 'user.email=b@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-watch-bench-')));
const repo = path.join(root, 'repo');

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** Run `fn` and report the main thread's worst timer delay meanwhile. */
async function withDrift<T>(fn: () => Promise<T>): Promise<{ result: T; maxDriftMs: number }> {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 10);
    last = now;
  }, 10);
  try {
    const result = await fn();
    await new Promise((r) => setTimeout(r, 30));
    return { result, maxDriftMs: Math.round(max) };
  } finally {
    clearInterval(timer);
  }
}

describe('git watcher rebuild benchmark', () => {
  it(`times a helper create and dispose with ${N} worktrees`, async () => {
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'a');
    const worktrees: string[] = [];
    for (let i = 0; i < N; i++) {
      const wt = path.join(root, `wt${i}`);
      git(repo, 'worktree', 'add', '-q', '-b', `agent-${i}/standby`, wt);
      worktrees.push(wt);
    }
    const helper = path.join(root, 'helper');
    const rows: Array<Record<string, unknown>> = [];

    for (const recursiveWatch of [false, true]) {
      const mode = recursiveWatch ? 'recursive' : 'folders';
      const w = new GitWatcher({ publish: () => undefined, pollMs: 0, recursiveWatch, watchRemovableDirs: true });
      const step = async (name: string, paths: string[]) => {
        const { maxDriftMs } = await withDrift(() => w.setPaths(paths));
        const s = w.lastRebuildStats() as RebuildStats;
        rows.push({
          mode, step: name, watched: w.watchedDirCount(), created: s.watchersCreated, closed: s.watchersClosed,
          watchSyncMs: s.watchSyncMs, totalMs: s.totalMs, maxDriftMs,
        });
      };
      await step('start', [repo, ...worktrees]);
      git(repo, 'worktree', 'add', '-q', '-b', 'helper-x/standby', helper);
      await step('helper created', [repo, ...worktrees, helper]);
      git(repo, 'worktree', 'remove', '--force', helper);
      git(repo, 'branch', '-q', '-D', 'helper-x/standby');
      await step('helper disposed', [repo, ...worktrees]);
      const { maxDriftMs } = await withDrift(async () => { w.close(); });
      rows.push({ mode, step: 'close all', maxDriftMs });
    }
    const lines = [`git watcher rebuild, ${N} worktrees, ${process.platform}, load ${os.loadavg().map((n) => n.toFixed(1)).join(' ')}`];
    for (const r of rows) lines.push(JSON.stringify(r));
    // Straight to stdout: the runner may hold console output back.
    process.stdout.write(`\n${lines.join('\n')}\n`);
  }, 600_000);
});
