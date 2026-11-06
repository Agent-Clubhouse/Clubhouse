import { execFile, type ChildProcess } from 'node:child_process';

export interface ProcessInfo { pid: number; ppid: number; command: string }
export type ProcessTableResult = { ok: true; processes: ProcessInfo[]; elapsedMs: number }
  | { ok: false; reason: 'timeout' | 'error' | 'invalid' | 'unreconciled'; elapsedMs: number; cleanupRequested: boolean; exitObserved: boolean };
export const PROCESS_TABLE_DEADLINE_MS = 10_000;

function parse(output: string, platform: NodeJS.Platform): ProcessInfo[] {
  if (platform === 'win32') {
    const parsed: unknown = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => {
      if (!row || !Number.isSafeInteger(row.ProcessId) || row.ProcessId < 0
        || !Number.isSafeInteger(row.ParentProcessId) || row.ParentProcessId < 0
        || (row.CommandLine !== null && typeof row.CommandLine !== 'string')) throw new Error('invalid_snapshot');
      return { pid: row.ProcessId, ppid: row.ParentProcessId, command: row.CommandLine ?? '' };
    });
  }
  return output.split('\n').filter((line) => line.trim()).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) throw new Error('invalid_snapshot');
    return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
  });
}

/** Test-infrastructure only. One owned enumerator at a time, through actual close. */
export function createProcessTableReader(options: { execute?: typeof execFile; platform?: NodeJS.Platform; deadlineMs?: number } = {}) {
  const execute = options.execute ?? execFile;
  const platform = options.platform ?? process.platform;
  const deadlineMs = options.deadlineMs ?? PROCESS_TABLE_DEADLINE_MS;
  let active: { child?: ChildProcess; cleanupRequested: boolean; exitObserved: boolean } | undefined;
  return async (): Promise<ProcessTableResult> => {
    if (active) return { ok: false, reason: 'unreconciled', elapsedMs: 0,
      cleanupRequested: active.cleanupRequested, exitObserved: active.exitObserved };
    const attempt = { child: undefined as ChildProcess | undefined, cleanupRequested: false, exitObserved: false };
    active = attempt;
    const started = performance.now();
    return new Promise((resolve) => {
      let settled = false;
      let timingOut = false;
      const finish = (result: ProcessTableResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const failure = (reason: 'timeout' | 'error' | 'invalid'): ProcessTableResult => ({ ok: false, reason,
        elapsedMs: Math.round(performance.now() - started), cleanupRequested: attempt.cleanupRequested, exitObserved: attempt.exitObserved });
      const timer = setTimeout(() => {
        timingOut = true;
        // Only the child created for this query is eligible. Signal dispatch is
        // not exit evidence; keep the reservation until its actual close event.
        try { attempt.cleanupRequested = attempt.child?.kill('SIGKILL') === true; } catch {
          // telemetry-exempt: fixed metadata only; no process table or raw error output.
          attempt.cleanupRequested = false;
        }
        finish(failure('timeout'));
        // A failed cleanup must not pin the test worker's event loop, and must
        // not spawn replacements while the unresolved child can still be alive.
        for (const release of [() => attempt.child?.stdout?.destroy(), () => attempt.child?.stderr?.destroy(), () => attempt.child?.unref()]) {
          try { release(); } catch {
            // telemetry-exempt: best-effort local query handles; no raw errors or process data.
          }
        }
      }, deadlineMs);
      try {
        attempt.child = execute(platform === 'win32' ? 'powershell.exe' : 'ps', platform === 'win32'
          ? ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress']
          : ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, output) => {
          if (settled || timingOut) return; // A late reply cannot turn an unknown snapshot into permission to sweep.
          if (error) { finish(failure('error')); return; }
          try { finish({ ok: true, processes: parse(output, platform), elapsedMs: Math.round(performance.now() - started) }); }
          catch {
            // telemetry-exempt: malformed table contents and raw errors never reach logs.
            finish(failure('invalid'));
          }
        });
        attempt.child.once('close', () => {
          attempt.exitObserved = true;
          if (active === attempt) active = undefined;
        });
      } catch {
        // telemetry-exempt: synchronous creation failure has no created child to reconcile.
        active = undefined; finish(failure('error'));
      }
    });
  };
}

export const readProcessTable = createProcessTableReader();
