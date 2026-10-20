/**
 * OS shutdown, restart and logoff (#2335). These end the app without
 * `before-quit` on Windows, and the process can be killed right after the
 * handler returns, so the final flush is synchronous: the log buffer, the
 * local telemetry recording and the session marker. An export flush is
 * started too, but the OS may not wait for it.
 *
 * - Windows: each window's `query-session-end` (the OS is asking; there is
 *   still time, so async flushes get a head start) and `session-end` (the
 *   session is ending now).
 * - macOS and Linux: powerMonitor `shutdown`. macOS then also quits normally,
 *   and the session stays marked as an OS shutdown.
 */
import { app, powerMonitor } from 'electron';
import * as logService from './services/log-service';
import { flushForOsSessionEnd, forceFlushTelemetry } from './telemetry/facade';
import { markOsShutdown } from './telemetry/lifecycle';

type Source = 'session-end' | 'shutdown';

/** Every window gets the query; one head start per query is enough. */
const QUERY_DEDUPE_MS = 5_000;

let installed = false;
let ended = false;
let lastQueryAt = -Infinity;

/** The OS asked whether the session may end: start the async flushes early. */
export function onQuerySessionEnd(now = Date.now()): void {
  if (ended || now - lastQueryAt < QUERY_DEDUPE_MS) return;
  lastQueryAt = now;
  logService.appLog('core:shutdown', 'info', 'OS asked to end the session (shutdown, restart or logoff)');
  void logService.flush();
  void forceFlushTelemetry();
}

/** Run one step, so a failing step can't skip the others. */
function attempt(step: () => void): void {
  try {
    step();
  } catch {
    // telemetry-exempt: the process is ending; each step is best effort
  }
}

/** The OS session is ending now. Runs once, however many windows report it. */
export function onOsSessionEnd(source: Source): void {
  if (ended) return;
  ended = true;
  attempt(() => logService.appLog('core:shutdown', 'info', 'OS session ending (shutdown, restart or logoff)', { meta: { source } }));
  attempt(markOsShutdown);
  attempt(flushForOsSessionEnd);
  // Last, so it includes the line above.
  attempt(logService.flushSync);
}

export function installOsSessionEndFlush(): void {
  if (installed) return;
  installed = true;
  app.on('browser-window-created', (_event, win) => {
    win.on('query-session-end', () => onQuerySessionEnd());
    win.on('session-end', () => onOsSessionEnd('session-end'));
  });
  // powerMonitor can't be used before app ready.
  void app.whenReady().then(() => {
    try {
      powerMonitor.on('shutdown', () => onOsSessionEnd('shutdown'));
    } catch {
      // Not available on this platform.
    }
  });
}

/** Test-only reset. */
export function _resetOsSessionEndForTests(): void {
  installed = false;
  ended = false;
  lastQueryAt = -Infinity;
}
