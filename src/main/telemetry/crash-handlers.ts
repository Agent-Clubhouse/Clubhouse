/**
 * Process-level crash and hang signals (spec §4.2). All level E.
 *
 * - Main `uncaughtException` / `unhandledRejection`: exception records. An
 *   uncaught exception also force-flushes (2 s), since the process may be
 *   unstable afterwards.
 * - `render-process-gone` / `child-process-gone`: events with Electron's
 *   reason enum, never details like the exit message.
 * - `unresponsive` → `responsive` on any window: one span per hang, plus a
 *   counter. Both ends are also written to the local log under `ui:perf`
 *   with the duration, telemetry or not (#2126): these are the hangs the
 *   renderer can't report itself.
 *
 * Nothing here changes existing behavior: the app's own handlers and logging
 * stay as they are; these only add telemetry calls next to them.
 */
import { app, type BrowserWindow } from 'electron';
import { ATTR } from '../../shared/telemetry/attributes';
import { forceFlushTelemetry, replaySpan, tel } from './facade';
import { windowKindFor } from './renderer-bridge';
import { appLog } from '../services/log-service';
import { recordBreadcrumb } from '../services/breadcrumbs';

export const CRASH_FLUSH_TIMEOUT_MS = 2000;

/** Report a main-process error caught by the process-level handlers. */
export function reportMainProcessError(error: unknown, kind: 'uncaught' | 'unhandled-rejection'): void {
  try {
    tel.exception(error, { origin: 'main', handled: false });
    if (kind === 'uncaught') void forceFlushTelemetry(CRASH_FLUSH_TIMEOUT_MS);
  } catch {
    // Telemetry must never throw from a crash handler.
  }
}

function trackUnresponsive(win: BrowserWindow): void {
  let since: number | null = null;
  win.on('unresponsive', () => {
    since = Date.now();
    if (!win.isDestroyed()) appLog('ui:perf', 'warn', 'Window unresponsive', { meta: { windowKind: windowKindFor(win.webContents) } });
  });
  win.on('responsive', () => {
    if (since === null) return;
    const startMs = since;
    since = null;
    if (win.isDestroyed()) return;
    const kind = windowKindFor(win.webContents);
    const durationMs = Date.now() - startMs;
    // For feedback reports (#2098), recorded here so it doesn't depend on the log line (#2303).
    recordBreadcrumb('performance', 'window.unresponsive', durationMs);
    appLog('ui:perf', 'warn', 'Window responsive again', { meta: { windowKind: kind, durationMs } });
    replaySpan({
      name: 'clubhouse.renderer.unresponsive',
      startMs,
      endMs: Date.now(),
      attrs: [ATTR.windowKind(kind)],
      outcome: 'ok',
    });
    tel.count('clubhouse.renderer.unresponsive_count', 1, [ATTR.windowKind(kind)]);
  });
}

let installed = false;

/**
 * Install the Electron-level handlers. Call once, before the first window is
 * created, so `browser-window-created` sees every window.
 */
export function installCrashTelemetry(): void {
  if (installed) return;
  installed = true;

  app.on('render-process-gone', (_event, webContents, details) => {
    try {
      tel.event('clubhouse.renderer.gone', [
        ATTR.rendererGoneReason(details.reason as Parameters<typeof ATTR.rendererGoneReason>[0]),
        ATTR.exitCode(details.exitCode),
        ATTR.windowKind(windowKindFor(webContents)),
      ]);
    } catch {
      // Never let telemetry interfere with crash recovery.
    }
  });

  app.on('child-process-gone', (_event, details) => {
    try {
      tel.event('clubhouse.child_process.gone', [
        ATTR.childProcessType(details.type as Parameters<typeof ATTR.childProcessType>[0]),
        ATTR.childProcessGoneReason(details.reason as Parameters<typeof ATTR.childProcessGoneReason>[0]),
        ATTR.exitCode(details.exitCode),
      ]);
    } catch {
      // Never let telemetry interfere with crash recovery.
    }
  });

  app.on('browser-window-created', (_event, win) => trackUnresponsive(win));
}

/** Test-only reset. */
export function _resetCrashTelemetryForTests(): void {
  installed = false;
}
