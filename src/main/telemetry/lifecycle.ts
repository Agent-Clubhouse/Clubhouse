/**
 * App lifecycle telemetry (spec §4.1): the startup span tree, the shutdown
 * span tree, unclean-exit detection and the config snapshot.
 *
 * Startup is measured from process start (backdated from process.uptime) to
 * the main window's `telemetry:renderer-ready`. Main records marks as it goes;
 * the renderer sends its own marks with renderer-ready; the whole tree is
 * replayed with explicit times once, so nothing holds a span open.
 *
 * No OpenTelemetry imports: part of the main bundle.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { ATTR, type SpanName, type TelAttr } from '../../shared/telemetry/attributes';
import type { RendererReadyMarks } from '../../shared/telemetry/renderer-protocol';
import { isTelemetryActive, onIntentionalExit, onRuntimeChange, replaySpanTree, tel } from './facade';
import { getInstallKind } from './install-kind';
import type { ErrorType, ReplaySpan } from './types';

// --- Startup ----------------------------------------------------------------

/** Wall-clock process start, backdated so startup includes module loading. */
export const PROCESS_START_MS = Date.now() - Math.round(process.uptime() * 1000);

export type StartupMark =
  | 'ready'
  | 'register_ipc_start'
  | 'register_ipc_end'
  | 'create_window_start'
  | 'window_ready_to_show';

const marks = new Map<StartupMark, number>();
let startupRecorded = false;
let startupKind: 'cold' | 'after_update' | 'safe_mode' = 'cold';

export function markStartup(mark: StartupMark, atMs: number = Date.now()): void {
  if (!marks.has(mark)) marks.set(mark, atMs);
}

/** Set once recordAppSession() has classified this start. */
export function setStartupKind(kind: 'cold' | 'after_update' | 'safe_mode'): void {
  startupKind = kind;
}

function span(name: SpanName, startMs: number | undefined, endMs: number | undefined, attrs: TelAttr[] = []): ReplaySpan | null {
  if (startMs === undefined || endMs === undefined || endMs < startMs) return null;
  return { name, startMs, endMs, attrs, outcome: 'ok' };
}

/** Build the startup tree. Exported for tests. */
export function buildStartupTree(
  endMs: number,
  rendererMarks: RendererReadyMarks | undefined,
  failure?: ErrorType,
): { root: ReplaySpan; children: ReplaySpan[] } {
  const children = [
    span('clubhouse.app.startup.main_ready', PROCESS_START_MS, marks.get('ready')),
    span('clubhouse.app.startup.register_ipc', marks.get('register_ipc_start'), marks.get('register_ipc_end')),
    span('clubhouse.app.startup.create_window', marks.get('create_window_start'), marks.get('window_ready_to_show')),
    span('clubhouse.app.startup.renderer_init', rendererMarks?.initStartMs, endMs),
    span('clubhouse.app.startup.load_settings', rendererMarks?.initStartMs, rendererMarks?.settingsLoadedMs),
    span('clubhouse.app.startup.plugin_system', rendererMarks?.settingsLoadedMs, rendererMarks?.pluginsReadyMs),
  ].filter((c): c is ReplaySpan => c !== null && c.startMs >= PROCESS_START_MS && c.endMs <= endMs);
  const root: ReplaySpan = {
    name: 'clubhouse.app.startup',
    startMs: PROCESS_START_MS,
    endMs,
    attrs: [ATTR.startupKind(startupKind)],
    outcome: failure ? 'error' : 'ok',
    errorType: failure,
  };
  return { root, children };
}

/** End the startup span: called on renderer-ready, or on a failed load. */
export function completeStartup(rendererMarks?: RendererReadyMarks, failure?: ErrorType, atMs = Date.now()): void {
  if (startupRecorded || !isTelemetryActive()) return;
  startupRecorded = true;
  replaySpanTree(buildStartupTree(atMs, rendererMarks, failure));
  tel.count('clubhouse.app.startup.duration', (atMs - PROCESS_START_MS) / 1000, [ATTR.startupKind(startupKind)]);
  void recordConfigSnapshot();
}

// --- Shutdown ---------------------------------------------------------------

export type ShutdownStep = Parameters<typeof ATTR.shutdownStep>[0];

let shutdownStart: number | null = null;
const shutdownSteps: ReplaySpan[] = [];

export function shutdownStarted(atMs = Date.now()): void {
  if (shutdownStart === null) shutdownStart = atMs;
}

export function shutdownStep(step: ShutdownStep, startMs: number, endMs: number, ok: boolean): void {
  shutdownSteps.push({
    name: 'clubhouse.app.shutdown.step',
    startMs,
    endMs,
    attrs: [ATTR.shutdownStep(step)],
    outcome: ok ? 'ok' : 'error',
    errorType: ok ? undefined : 'unknown',
  });
}

/** Called after every cleanup settled and before the final telemetry flush. */
export function shutdownCompleted(atMs = Date.now()): void {
  if (shutdownStart === null || !isTelemetryActive()) return;
  const failed = shutdownSteps.some((s) => s.outcome === 'error');
  replaySpanTree({
    root: { name: 'clubhouse.app.shutdown', startMs: shutdownStart, endMs: atMs, attrs: [], outcome: failed ? 'error' : 'ok', errorType: failed ? 'unknown' : undefined },
    children: shutdownSteps.splice(0),
  });
  tel.count('clubhouse.app.shutdown.duration', (atMs - shutdownStart) / 1000);
  tel.count('clubhouse.app.session.duration', (atMs - PROCESS_START_MS) / 1000);
}

// --- Unclean exit detection -------------------------------------------------

interface SessionRecord {
  startedAt: string;
  version: string;
  clean: boolean;
}

function sessionFile(): string {
  return path.join(app.getPath('userData'), 'telemetry-session.json');
}

let sessionWritten = false;

/**
 * Compare against the previous session's record, then write this one. Only
 * runs while telemetry is on, so a disabled install never gets the file.
 * `crashLoop` comes from the safe-mode check at the same startup.
 */
export function checkPreviousSession(crashLoop: boolean): void {
  if (!isTelemetryActive() || sessionWritten) return;
  sessionWritten = true;
  const file = sessionFile();
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<SessionRecord>;
    if (prev.clean === false) {
      const previous = crashLoop ? 'crash_loop' : 'unknown_exit';
      tel.event('clubhouse.app.unclean_exit', [ATTR.previousExit(previous)]);
      tel.count('clubhouse.app.unclean_exits', 1, [ATTR.previousExit(previous)]);
    }
  } catch {
    // telemetry-exempt: no previous record (first enabled run) or an unreadable one
  }
  writeSession(false);
}

function writeSession(clean: boolean): void {
  const record: SessionRecord = { startedAt: new Date(PROCESS_START_MS).toISOString(), version: app.getVersion(), clean };
  try {
    fs.writeFileSync(sessionFile(), JSON.stringify(record), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // telemetry-exempt: best effort; a missing record only means no unclean-exit signal next time
  }
}

/** Mark this session as ended on purpose. Synchronous: runs right before exit. */
export function markCleanExit(): void {
  if (!sessionWritten) return;
  writeSession(true);
}

// --- Config snapshot (§5.4) ---------------------------------------------------

const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;

/** Gather counts and switches. Each source is optional: a failing read drops its attribute. */
async function snapshotAttrs(): Promise<TelAttr[]> {
  const attrs: TelAttr[] = [];
  const add = async (fn: () => TelAttr | Promise<TelAttr>): Promise<void> => {
    try {
      attrs.push(await fn());
    } catch {
      // telemetry-exempt: one unreadable setting just leaves its attribute out
    }
  };
  await add(async () => ATTR.installKind(await getInstallKind()));
  await add(async () => {
    const projectStore = await import('../services/project-store');
    return ATTR.projectsCount((await projectStore.list()).length);
  });
  await add(async () => {
    const theme = await import('../services/theme-service');
    return ATTR.themeKind(String(theme.getSettings().themeId).startsWith('plugin:') ? 'plugin' : 'builtin');
  });
  await add(async () => ATTR.clubhouseMode((await import('../services/clubhouse-mode-settings')).getSettings().enabled === true));
  await add(async () => {
    const annex = (await import('../services/annex-settings')).getSettings();
    return ATTR.annexServer(annex.enableServer === true);
  });
  await add(async () => ATTR.annexClient((await import('../services/annex-settings')).getSettings().enableClient === true));
  await add(async () => ATTR.loggingEnabled((await import('../services/log-settings')).getSettings().enabled !== false));
  return attrs;
}

export async function recordConfigSnapshot(): Promise<void> {
  if (!isTelemetryActive()) return;
  tel.event('clubhouse.app.config_snapshot', await snapshotAttrs());
  if (!snapshotTimer) {
    snapshotTimer = setInterval(() => void recordConfigSnapshot(), SNAPSHOT_INTERVAL_MS);
    snapshotTimer.unref?.();
  }
}

// --- Wiring -----------------------------------------------------------------

let installed = false;

export function installLifecycleTelemetry(): void {
  if (installed) return;
  installed = true;
  onIntentionalExit(markCleanExit);
  onRuntimeChange(() => {
    if (!isTelemetryActive() && snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
  });
}

/** Test-only reset. */
export function _resetLifecycleForTests(): void {
  marks.clear();
  startupRecorded = false;
  startupKind = 'cold';
  shutdownStart = null;
  shutdownSteps.length = 0;
  sessionWritten = false;
  if (snapshotTimer) clearInterval(snapshotTimer);
  snapshotTimer = null;
  installed = false;
}
