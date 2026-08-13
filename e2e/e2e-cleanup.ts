/**
 * Local-only cleanup for E2E-launched Electron instances.
 *
 * `test.afterAll` only runs on a graceful worker shutdown. When a worker is
 * killed — a 120s timeout, or Ctrl-C on the run — the Electron process tree is
 * orphaned (~300–500 MB each) and its temp user-data dir is left on disk. This
 * module reaps both at the end of a run.
 *
 * ## Why we track PIDs instead of pattern-matching `ps`
 *
 * The obvious sweep — "kill anything whose `--user-data-dir` looks like ours" —
 * does not work in this codebase and is unsafe:
 *
 * - The E2E user-data dir is passed via the `CLUBHOUSE_USER_DATA` env var and
 *   applied with `app.setPath('userData', …)` (`src/main/index.ts`). It never
 *   reaches any command line, so no `clubhouse-e2e-*` path appears in `ps`.
 * - The only processes that *do* carry `--user-data-dir=` on a dev machine are
 *   real applications, and a developer's installed `/Applications/Clubhouse.app`
 *   carries `.webpack` in its command line. Matching on either would miss every
 *   process we want and risk killing ones we must never touch.
 *
 * So discovery is by the PIDs we actually launched, recorded to a run-state
 * file (workers and global teardown are separate processes, so an in-memory
 * registry would not survive the boundary). Every kill is then gated on the
 * process running from this repo's `node_modules/electron/dist` — which an
 * installed Clubhouse.app can never match.
 *
 * A developer's own `npm start` instance is never a candidate: it is not in the
 * recorded set, and nothing is discovered by scanning.
 *
 * Everything here is a no-op when `CI` is set. CI runners are ephemeral and
 * already upload `test-results/` as artifacts.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Where launched-instance PIDs are recorded, so global teardown can read them. */
const RUN_STATE_DIR = path.resolve(__dirname, '.run-state');
const PID_FILE_NAME = 'electron-pids.jsonl';

/** Overridable locations, so tests can run hermetically. */
export interface CleanupPaths {
  /** Directory holding the recorded-PID file. */
  stateDir?: string;
  /** Root scanned for stray `clubhouse-e2e-*` directories. */
  tmpDir?: string;
}

function stateDirOf(paths?: CleanupPaths): string {
  return paths?.stateDir ?? RUN_STATE_DIR;
}

function pidFileOf(paths?: CleanupPaths): string {
  return path.join(stateDirOf(paths), PID_FILE_NAME);
}

function tmpDirOf(paths?: CleanupPaths): string {
  return paths?.tmpDir ?? os.tmpdir();
}

/** Shared prefix of every temp dir E2E creates under `os.tmpdir()`. */
const TEMP_DIR_PREFIX = 'clubhouse-e2e-';

/**
 * This repo's Electron binary directory. Every E2E-launched process — the main
 * process and its `Electron Helper` children — runs from under here. An
 * installed `/Applications/Clubhouse.app` never does, which is what makes a
 * kill safe.
 */
export const ELECTRON_DIST_DIR = path.resolve(__dirname, '..', 'node_modules', 'electron', 'dist');

/** Local-only: never touch CI, whose runners are ephemeral. */
export function isLocalRun(): boolean {
  return !process.env.CI;
}

interface LaunchRecord {
  pid: number;
  userDataDir?: string;
}

/**
 * Record an Electron instance so it can be reaped even if the worker that
 * launched it is killed before `afterAll` runs. No-op in CI.
 */
export function recordElectronApp(pid: number | undefined, userDataDir?: string, paths?: CleanupPaths): void {
  if (!isLocalRun() || !pid) return;
  try {
    fs.mkdirSync(stateDirOf(paths), { recursive: true });
    fs.appendFileSync(pidFileOf(paths), JSON.stringify({ pid, userDataDir } as LaunchRecord) + '\n', 'utf-8');
  } catch {
    // Best-effort bookkeeping — never fail a test over it.
  }
}

function readLaunchRecords(paths?: CleanupPaths): LaunchRecord[] {
  try {
    return fs.readFileSync(pidFileOf(paths), 'utf-8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as LaunchRecord)
      .filter((r) => typeof r.pid === 'number');
  } catch {
    return [];
  }
}

interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

/** Snapshot the process table. Returns an empty list if it cannot be read. */
function listProcesses(): ProcessInfo[] {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
        { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
      );
      const parsed = JSON.parse(out) as Array<{ ProcessId: number; ParentProcessId: number; CommandLine: string | null }>;
      return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
        pid: p.ProcessId,
        ppid: p.ParentProcessId,
        command: p.CommandLine ?? '',
      }));
    }
    const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return out.split('\n').flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return [];
      return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }];
    });
  } catch {
    return [];
  }
}

/**
 * The safety gate: only a process running from this repo's Electron dist may
 * ever be killed. Guarantees an installed Clubhouse.app is untouchable.
 */
function isRepoElectronProcess(info: ProcessInfo): boolean {
  return info.command.includes(ELECTRON_DIST_DIR);
}

/** Collect a PID plus every live descendant of it. */
function withDescendants(roots: number[], processes: ProcessInfo[]): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const p of processes) {
    const siblings = childrenByParent.get(p.ppid);
    if (siblings) siblings.push(p.pid);
    else childrenByParent.set(p.ppid, [p.pid]);
  }

  const collected = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (collected.has(pid)) continue;
    collected.add(pid);
    for (const child of childrenByParent.get(pid) ?? []) queue.push(child);
  }
  return collected;
}

function kill(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false; // Already gone, or not ours to signal.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function realPath(p: string): string {
  try {
    return path.resolve(fs.realpathSync(p));
  } catch {
    return path.resolve(p);
  }
}

/**
 * Delete a temp dir — but only a direct child of the temp root whose name
 * carries our prefix. Anything else (a repo path, a home directory, a nested
 * path escaping via `..`) is refused.
 */
export function removeTempDir(dir: string, paths?: CleanupPaths): boolean {
  const tmpRoot = realPath(tmpDirOf(paths));
  const resolved = path.resolve(dir);
  if (!path.basename(resolved).startsWith(TEMP_DIR_PREFIX)) return false;
  // Compare the parent against the temp root, resolving symlinks on both sides
  // (macOS /var → /private/var) so a legitimate dir is not skipped.
  const parent = path.dirname(resolved);
  if (realPath(parent) !== tmpRoot && path.resolve(parent) !== path.resolve(tmpDirOf(paths))) return false;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Remove every `clubhouse-e2e-*` directory left in the temp root. */
function removeStrayTempDirs(paths?: CleanupPaths): number {
  const tmpDir = tmpDirOf(paths);
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(tmpDir)) {
      if (!entry.startsWith(TEMP_DIR_PREFIX)) continue;
      if (removeTempDir(path.join(tmpDir, entry), paths)) removed++;
    }
  } catch {
    // Temp dir unreadable — nothing to do.
  }
  return removed;
}

export interface SweepResult {
  killed: number;
  tempDirsRemoved: number;
}

/**
 * Kill Electron instances left over from this run and remove their temp dirs.
 * No-op in CI. Never throws — cleanup must not fail a run.
 */
export function sweepE2EProcesses(paths?: CleanupPaths): SweepResult {
  const result: SweepResult = { killed: 0, tempDirsRemoved: 0 };
  if (!isLocalRun()) return result;

  try {
    const records = readLaunchRecords(paths);
    const livePids = records.map((r) => r.pid).filter(isAlive);

    if (livePids.length > 0) {
      const processes = listProcesses();
      const byPid = new Map(processes.map((p) => [p.pid, p]));
      const candidates = withDescendants(livePids, processes);

      // Only ever kill processes running from this repo's Electron dist.
      const targets = [...candidates].filter((pid) => {
        const info = byPid.get(pid);
        return info ? isRepoElectronProcess(info) : false;
      });

      for (const pid of targets) {
        if (kill(pid, 'SIGTERM')) result.killed++;
      }
      // Escalate for anything that ignored SIGTERM.
      for (const pid of targets) {
        if (isAlive(pid)) kill(pid, 'SIGKILL');
      }
    }

    for (const record of records) {
      if (record.userDataDir) removeTempDir(record.userDataDir, paths);
    }
    result.tempDirsRemoved = removeStrayTempDirs(paths);

    try {
      fs.rmSync(stateDirOf(paths), { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  } catch {
    // Cleanup is best-effort by design.
  }

  return result;
}

// ── Belt-and-braces: reap on an interrupted run ──────────────────────────
//
// Global teardown never runs when the process is interrupted, so each worker
// also closes its own instances on the way out.

type Closable = { close: () => Promise<void> };
const openApps = new Set<Closable>();
let exitHooksInstalled = false;

/** Track an app handle so an interrupted run still tears it down. No-op in CI. */
export function trackOpenApp(app: Closable): void {
  if (!isLocalRun()) return;
  openApps.add(app);
  installExitHooks();
}

/** Stop tracking an app that was closed gracefully. */
export function untrackOpenApp(app: Closable): void {
  openApps.delete(app);
}

function closeAllSync(): void {
  for (const app of openApps) {
    // On exit there is no time to await — fire the close and let the OS reap
    // whatever is left. sweepE2EProcesses() is the real backstop.
    void app.close().catch(() => {});
  }
  openApps.clear();
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;

  process.on('exit', closeAllSync);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      closeAllSync();
      // Deliberately do NOT sweep here. This runs inside a Playwright worker,
      // and a sweep would shell out to `ps` and kill instances belonging to
      // other workers mid-shutdown. An interrupted run is healed instead by
      // the *next* run's global teardown: the recorded PIDs outlive this
      // process in the state file, and that sweep clears the file when done.
      //
      // Restore default signal behaviour rather than calling process.exit(),
      // so Playwright's own shutdown is not truncated.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}
