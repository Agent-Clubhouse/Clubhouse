import { app } from 'electron';
import type { LogLevel } from '../../shared/types';
import { bridgeLog, type LogTelemetry } from '../telemetry/log-bridge';
import { diag, getDiagSink, isDiagActive, type DiagEntry } from '../telemetry/diag';

/** Startup appLog lines held for diag; well under the recorder's queue (500), so the drain can't overflow it. */
const MAX_EARLY_DIAG = 200;

/**
 * appLog lines from before the local recorder started (#2301), written to
 * diag once it has. `null` once startup is over: from then on a line with no
 * recorder (logging off) is dropped, as diag does.
 */
let earlyDiag: DiagEntry[] | null = [];
let earlyDiagDropped = 0;
let quitHooked = false;

/** Write the held startup lines to diag, if the recorder has started. */
function drainEarlyDiag(): void {
  if (!earlyDiag || !isDiagActive()) return;
  const lines = earlyDiag;
  earlyDiag = null;
  if (earlyDiagDropped > 0) {
    diag('core:startup', 'warn', 'Startup log lines dropped before the recorder started', { dropped: earlyDiagDropped });
  }
  earlyDiagDropped = 0;
  for (const e of lines) diag(e.ns, e.level, e.msg, e.meta);
}

/** Writes the diag lines (the local recorder). */
export async function flush(): Promise<void> {
  drainEarlyDiag();
  await getDiagSink()?.flush().catch(() => {});
}

/**
 * Write the diag lines now, synchronously: an OS shutdown, restart or logoff
 * may end the process before an async write lands (#2335).
 */
export function flushSync(): void {
  try {
    getDiagSink()?.flushSync?.();
  } catch {
    // telemetry-exempt: the recorder's own write failed; it counts its drops
  }
}

/**
 * The diag half of appLog (#2301): `projectId` goes in `meta`. Before the
 * recorder starts the line is held, raw and in memory only; diag gates and
 * redacts it when it is written.
 */
function appDiag(ns: string, level: LogLevel, msg: string, opts?: { projectId?: string; meta?: Record<string, unknown> }): void {
  const meta = opts?.projectId && opts.meta?.projectId === undefined ? { projectId: opts.projectId, ...opts.meta } : opts?.meta;
  drainEarlyDiag();
  if (earlyDiag && !isDiagActive()) {
    // A copy, so a caller changing its object later doesn't change the line.
    earlyDiag.push({ ns, level, msg, meta: meta && { ...meta } });
    if (earlyDiag.length > MAX_EARLY_DIAG) {
      earlyDiag.shift();
      earlyDiagDropped++;
    }
    return;
  }
  diag(ns, level, msg, meta);
}

/**
 * A main-process log line, written to the local-only diag tier (spec
 * §6.12). `telemetry` (spec §6.6) is bridged before the logging settings'
 * filters, which apply only to the diag line. Whether the bridged event is
 * recorded or exported follows the telemetry recording settings. Only the
 * declared event and attributes are kept.
 */
export function appLog(
  ns: string,
  level: LogLevel,
  msg: string,
  opts?: { projectId?: string; meta?: Record<string, unknown>; telemetry?: LogTelemetry },
): void {
  if (opts?.telemetry) bridgeLog(level, opts.telemetry);
  try {
    appDiag(ns, level, msg, opts);
  } catch {
    // telemetry-exempt: a logger must never throw, and reporting would recurse
  }
}

/**
 * Startup is over: the recorder has started if logging is on. Lines held
 * until now are written, or dropped when it never will start.
 */
export function init(): void {
  drainEarlyDiag();
  earlyDiag = null;
  earlyDiagDropped = 0;

  if (quitHooked) return;
  quitHooked = true;
  app.on('before-quit', () => {
    void flush();
  });
}

/** Test-only: back to startup, with nothing held. */
export function _resetEarlyLogForTests(): void {
  earlyDiag = [];
  earlyDiagDropped = 0;
}
