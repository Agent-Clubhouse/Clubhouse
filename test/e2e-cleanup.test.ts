/**
 * Tests for the local-only E2E orphan sweep (`e2e/e2e-cleanup.ts`).
 *
 * The sweep kills processes and deletes directories, so the safety properties
 * matter more than the happy path: it must never kill a process that is not a
 * repo-local Electron instance, and never delete a directory outside the temp
 * root. Both are exercised here against real processes and real directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  isLocalRun,
  recordElectronApp,
  sweepE2EProcesses,
  removeTempDir,
  trackOpenApp,
  untrackOpenApp,
  ELECTRON_DIST_DIR,
  type CleanupPaths,
} from '../e2e/e2e-cleanup';

/** Sandbox for state + temp roots, so tests never touch the real ones. */
let sandbox: string;
let paths: CleanupPaths;
const spawned: ChildProcess[] = [];

/**
 * A long-lived process whose command line contains `marker`.
 *
 * The `--` terminates node's own option parsing, so a marker that looks like a
 * flag (`--user-data-dir=…`) lands in argv instead of making node exit.
 */
function spawnMarked(marker: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', marker], {
    stdio: 'ignore',
  });
  spawned.push(child);
  return child;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `predicate` holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

/**
 * Give a freshly spawned process time to appear in the process table, and
 * assert it is actually running — otherwise a process that exited on its own
 * would look identical to one the sweep correctly spared.
 */
async function waitUntilVisible(pid: number): Promise<void> {
  await waitFor(() => isAlive(pid));
  await new Promise((r) => setTimeout(r, 150));
  expect(isAlive(pid), `probe process ${pid} exited before the sweep ran`).toBe(true);
}

beforeEach(() => {
  delete process.env.CI;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cleanup-test-'));
  paths = {
    stateDir: path.join(sandbox, 'state'),
    tmpDir: path.join(sandbox, 'tmp'),
  };
  fs.mkdirSync(paths.tmpDir!, { recursive: true });
});

afterEach(() => {
  delete process.env.E2E_LIVE_ORCHESTRATOR;
  for (const child of spawned) {
    if (child.pid && isAlive(child.pid)) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  spawned.length = 0;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// ── The safety gate ──────────────────────────────────────────────────────

describe('kill safety', () => {
  it('does NOT kill a recorded process that is not a repo-local Electron', async () => {
    // Simulates a stale PID file entry whose PID has been recycled by an
    // unrelated program. Killing it would be the worst-case bug.
    const victim = spawnMarked('/Applications/Clubhouse.app/Contents/MacOS/Clubhouse');
    await waitUntilVisible(victim.pid!);
    recordElectronApp(victim.pid, undefined, paths);

    const result = sweepE2EProcesses(paths);

    expect(result.killed).toBe(0);
    expect(isAlive(victim.pid!)).toBe(true);
  });

  it('does NOT kill a process merely because its command line mentions .webpack', async () => {
    // A developer's installed Clubhouse.app runs from app.asar.unpacked/.webpack.
    const victim = spawnMarked('/Applications/Clubhouse.app/Contents/Resources/app.asar.unpacked/.webpack/main/index.js');
    await waitUntilVisible(victim.pid!);
    recordElectronApp(victim.pid, undefined, paths);

    sweepE2EProcesses(paths);

    expect(isAlive(victim.pid!)).toBe(true);
  });

  it('does NOT kill a process carrying a --user-data-dir switch', async () => {
    // On a dev machine the only processes with this switch are real apps.
    const victim = spawnMarked('--user-data-dir=/Users/dev/Library/Application Support/Code');
    await waitUntilVisible(victim.pid!);
    recordElectronApp(victim.pid, undefined, paths);

    sweepE2EProcesses(paths);

    expect(isAlive(victim.pid!)).toBe(true);
  });

  it('kills a recorded process running from this repo\'s Electron dist', async () => {
    const target = spawnMarked(path.join(ELECTRON_DIST_DIR, 'Electron.app/Contents/MacOS/Electron'));
    await waitUntilVisible(target.pid!);
    recordElectronApp(target.pid, undefined, paths);

    const result = sweepE2EProcesses(paths);

    expect(result.killed).toBeGreaterThan(0);
    expect(await waitFor(() => !isAlive(target.pid!))).toBe(true);
  });

  it('never kills a repo-local Electron that was not recorded', async () => {
    // A developer's own `npm start` uses the same binary. It is not in the
    // recorded set, and nothing is discovered by scanning, so it must survive.
    const devInstance = spawnMarked(path.join(ELECTRON_DIST_DIR, 'Electron.app/Contents/MacOS/Electron'));
    await waitUntilVisible(devInstance.pid!);
    // Deliberately not recorded.

    const result = sweepE2EProcesses(paths);

    expect(result.killed).toBe(0);
    expect(isAlive(devInstance.pid!)).toBe(true);
  });

  it('kills recorded descendants, so Electron helper processes are reaped', async () => {
    // The Electron main process spawns helper children. Only the main process
    // PID is recorded, so the sweep must walk down to the helpers — killing
    // just the root is what left ~300-500MB orphans behind.
    const helperMarker = path.join(ELECTRON_DIST_DIR, 'Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper');
    const parentScript = `
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', ${JSON.stringify(helperMarker)}], { stdio: 'ignore' });
      console.log(child.pid);
      setTimeout(() => {}, 60000);
    `;
    const parent = spawn(
      process.execPath,
      ['-e', parentScript, '--', path.join(ELECTRON_DIST_DIR, 'Electron.app/Contents/MacOS/Electron')],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    spawned.push(parent);

    const helperPid = await new Promise<number>((resolve, reject) => {
      parent.stdout!.on('data', (chunk) => resolve(Number(String(chunk).trim())));
      parent.on('error', reject);
      setTimeout(() => reject(new Error('helper pid never reported')), 5_000);
    });
    await waitUntilVisible(parent.pid!);
    await waitUntilVisible(helperPid);

    // Only the parent is recorded — the helper must be found by descent.
    recordElectronApp(parent.pid, undefined, paths);

    sweepE2EProcesses(paths);

    expect(await waitFor(() => !isAlive(parent.pid!)), 'parent survived').toBe(true);
    expect(await waitFor(() => !isAlive(helperPid)), 'helper survived').toBe(true);
  });

  it('tolerates a recorded PID that is already gone', async () => {
    const child = spawnMarked(path.join(ELECTRON_DIST_DIR, 'Electron.app/Contents/MacOS/Electron'));
    const pid = child.pid!;
    await waitUntilVisible(pid);
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !isAlive(pid));
    recordElectronApp(pid, undefined, paths);

    expect(() => sweepE2EProcesses(paths)).not.toThrow();
  });
});

// ── Temp directory safety ────────────────────────────────────────────────

describe('temp directory safety', () => {
  it('removes a clubhouse-e2e-* dir in the temp root', () => {
    const dir = path.join(paths.tmpDir!, 'clubhouse-e2e-abc123');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Cache'), 'x');

    expect(removeTempDir(dir, paths)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses a directory without the clubhouse-e2e- prefix', () => {
    const dir = path.join(paths.tmpDir!, 'important-work');
    fs.mkdirSync(dir, { recursive: true });

    expect(removeTempDir(dir, paths)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('refuses a correctly-prefixed directory outside the temp root', () => {
    const outside = path.join(sandbox, 'elsewhere', 'clubhouse-e2e-evil');
    fs.mkdirSync(outside, { recursive: true });

    expect(removeTempDir(outside, paths)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('refuses a path that escapes the temp root via ..', () => {
    const escapeTarget = path.join(sandbox, 'clubhouse-e2e-escape');
    fs.mkdirSync(escapeTarget, { recursive: true });
    const traversal = path.join(paths.tmpDir!, '..', 'clubhouse-e2e-escape');

    expect(removeTempDir(traversal, paths)).toBe(false);
    expect(fs.existsSync(escapeTarget)).toBe(true);
  });

  it('sweeps every stray clubhouse-e2e-* dir and reports the count', () => {
    for (const name of ['clubhouse-e2e-assistant-a', 'clubhouse-e2e-builder-project-b', 'clubhouse-e2e-c']) {
      fs.mkdirSync(path.join(paths.tmpDir!, name), { recursive: true });
    }
    const keep = path.join(paths.tmpDir!, 'unrelated-dir');
    fs.mkdirSync(keep, { recursive: true });

    const result = sweepE2EProcesses(paths);

    expect(result.tempDirsRemoved).toBe(3);
    expect(fs.existsSync(keep)).toBe(true);
  });
});

// ── CI must be untouched ─────────────────────────────────────────────────

describe('CI is never affected', () => {
  it('reports a non-local run when CI is set', () => {
    process.env.CI = '1';
    expect(isLocalRun()).toBe(false);
  });

  it('records nothing when CI is set', () => {
    process.env.CI = '1';
    recordElectronApp(12345, '/tmp/clubhouse-e2e-x', paths);

    expect(fs.existsSync(path.join(paths.stateDir!, 'electron-pids.jsonl'))).toBe(false);
  });

  it('sweeps nothing when CI is set', async () => {
    const target = spawnMarked(path.join(ELECTRON_DIST_DIR, 'Electron.app/Contents/MacOS/Electron'));
    await waitUntilVisible(target.pid!);
    recordElectronApp(target.pid, undefined, paths);
    const strayDir = path.join(paths.tmpDir!, 'clubhouse-e2e-stray');
    fs.mkdirSync(strayDir, { recursive: true });

    process.env.CI = '1';
    const result = sweepE2EProcesses(paths);

    expect(result).toEqual({ killed: 0, tempDirsRemoved: 0 });
    expect(isAlive(target.pid!)).toBe(true);
    expect(fs.existsSync(strayDir)).toBe(true);
  });

  it('does not track app handles when CI is set', () => {
    process.env.CI = '1';
    let closed = false;
    const app = { close: async () => { closed = true; } };
    trackOpenApp(app);
    untrackOpenApp(app);
    expect(closed).toBe(false);
  });
});

// ── Recording ────────────────────────────────────────────────────────────

describe('PID recording', () => {
  it('carries a launch across process boundaries, so teardown can reap it', async () => {
    // A worker records; global teardown (a different process) reaps. Recording
    // must therefore survive in the state file, not just in memory.
    const target = spawnMarked(path.join(ELECTRON_DIST_DIR, 'Electron.app/Contents/MacOS/Electron'));
    const dir = path.join(paths.tmpDir!, 'clubhouse-e2e-crossproc');
    fs.mkdirSync(dir, { recursive: true });
    await waitUntilVisible(target.pid!);

    recordElectronApp(target.pid, dir, paths);
    const result = sweepE2EProcesses(paths);

    expect(result.killed).toBeGreaterThan(0);
    expect(await waitFor(() => !isAlive(target.pid!))).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('reaps every launch of a run, not just the most recent', async () => {
    // beforeAll runs once per file, so a full run records many instances.
    const first = spawnMarked(path.join(ELECTRON_DIST_DIR, 'Electron.app/Contents/MacOS/Electron'));
    const second = spawnMarked(path.join(ELECTRON_DIST_DIR, 'Electron.app/Contents/MacOS/Electron'));
    await waitUntilVisible(first.pid!);
    await waitUntilVisible(second.pid!);

    recordElectronApp(first.pid, undefined, paths);
    recordElectronApp(second.pid, undefined, paths);
    sweepE2EProcesses(paths);

    expect(await waitFor(() => !isAlive(first.pid!)), 'first survived').toBe(true);
    expect(await waitFor(() => !isAlive(second.pid!)), 'second survived').toBe(true);
  });

  it('ignores an undefined pid', () => {
    recordElectronApp(undefined, '/tmp/clubhouse-e2e-a', paths);
    expect(fs.existsSync(path.join(paths.stateDir!, 'electron-pids.jsonl'))).toBe(false);
  });

  it('clears the state file after a sweep, so the next run starts clean', () => {
    recordElectronApp(999999, undefined, paths);
    sweepE2EProcesses(paths);
    expect(fs.existsSync(path.join(paths.stateDir!, 'electron-pids.jsonl'))).toBe(false);
  });

  it('removes the userDataDir recorded for a launch', () => {
    const dir = path.join(paths.tmpDir!, 'clubhouse-e2e-recorded');
    fs.mkdirSync(dir, { recursive: true });
    recordElectronApp(999999, dir, paths);

    sweepE2EProcesses(paths);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('survives a corrupt state file', () => {
    fs.mkdirSync(paths.stateDir!, { recursive: true });
    fs.writeFileSync(path.join(paths.stateDir!, 'electron-pids.jsonl'), 'not json\n{"pid":\n', 'utf-8');

    expect(() => sweepE2EProcesses(paths)).not.toThrow();
  });

  it('returns zeroes when there is nothing to clean', () => {
    expect(sweepE2EProcesses(paths)).toEqual({ killed: 0, tempDirsRemoved: 0 });
  });
});

// ── Orchestrator stub gating ─────────────────────────────────────────────

describe('useLiveOrchestrator', () => {
  it('is false in CI, so CI always takes the stub path (unchanged)', async () => {
    const { useLiveOrchestrator } = await import('../e2e/assistant/helpers');
    process.env.CI = '1';
    process.env.E2E_LIVE_ORCHESTRATOR = '1';
    // Even with the opt-in set, CI never uses a live orchestrator: no binary.
    expect(useLiveOrchestrator()).toBe(false);
  });

  it('is false locally by default, so a plain run matches CI', async () => {
    const { useLiveOrchestrator } = await import('../e2e/assistant/helpers');
    delete process.env.CI;
    delete process.env.E2E_LIVE_ORCHESTRATOR;
    expect(useLiveOrchestrator()).toBe(false);
  });

  it('is true locally only when explicitly opted in', async () => {
    const { useLiveOrchestrator } = await import('../e2e/assistant/helpers');
    delete process.env.CI;
    process.env.E2E_LIVE_ORCHESTRATOR = '1';
    expect(useLiveOrchestrator()).toBe(true);
  });

  it('ignores a non-"1" value, so a stray export cannot enable live calls', async () => {
    const { useLiveOrchestrator } = await import('../e2e/assistant/helpers');
    delete process.env.CI;
    process.env.E2E_LIVE_ORCHESTRATOR = 'true';
    expect(useLiveOrchestrator()).toBe(false);
  });
});
