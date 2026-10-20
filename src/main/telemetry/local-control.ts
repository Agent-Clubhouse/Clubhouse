/**
 * Starts and stops local telemetry recording (spec §6.12) from the logging
 * settings, whatever the export settings say. The recorder runs while
 * `enabled` is on and always takes diag lines (#2299); it records the
 * telemetry signals, and is installed in the facade, only while
 * `telemetryRecording` is on too. No OpenTelemetry imports.
 */
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { app } from 'electron';
import * as logSettings from '../services/log-settings';
import { LOG_RETENTION_TIERS, type LocalTelemetryLevel, type LoggingSettings } from '../../shared/types';
import { TELEMETRY_CONSENT_VERSION } from '../../shared/telemetry/settings-types';
import { getDiagSink, setDiagSink } from './diag-sink';
import { getLocalSink, setLocalSink } from './facade';
import { isValidIdentity } from './ids';
import { createLocalRecorder, type LocalRecorder } from './local-recorder';
import { pruneLogDir, RETENTION_INTERVAL_MS } from './local-retention';
import { createScrubber } from './scrubber';
import { enabledDestinations, getTelemetrySettings, isExperimentEnabled } from './settings';

/** The default level: flows and errors; Detailed-only signals (per-IPC spans, tool calls) stay off. */
export const LOCAL_RECORDING_LEVEL: LocalTelemetryLevel = 'standard';

/** The configured local level, which every producer and every exporter follows (spec §6.12). */
export function localRecordingLevel(settings: LoggingSettings = logSettings.getSettings()): LocalTelemetryLevel {
  return settings.telemetryLevel === 'detailed' ? 'detailed' : LOCAL_RECORDING_LEVEL;
}

/** True when export was set up to send Detailed data before the local level existed. */
function exportWasDetailed(): boolean {
  try {
    const t = getTelemetrySettings();
    return (
      isExperimentEnabled() &&
      t.consentVersion >= TELEMETRY_CONSENT_VERSION &&
      enabledDestinations(t).some((d) => d.level === 'detailed')
    );
  } catch {
    return false;
  }
}

/**
 * One-time migration (#2289): export now sends at most the local level, so
 * an install already exporting at Detailed starts at local Detailed and
 * loses nothing. Runs once per install (persisted marker), whatever the
 * outcome, so a later change by the user is never overridden. Returns the
 * settings to use now; the save is best effort.
 */
export function migrateLocalLevel(settings: LoggingSettings): LoggingSettings {
  if (settings.telemetryLevelMigrated) return settings;
  const patch: Partial<LoggingSettings> = { telemetryLevelMigrated: true };
  if (exportWasDetailed()) patch.telemetryLevel = 'detailed';
  try {
    logSettings.updateSettings((current) => ({ ...current, ...patch })).catch(() => {});
  } catch {
    // Not saved: the migration runs again next start, with the same result.
  }
  return { ...settings, ...patch };
}

let recorder: LocalRecorder | null = null;
let stopping: Promise<void> | null = null;
let retentionTimer: ReturnType<typeof setInterval> | null = null;
let pruning: Promise<unknown> | null = null;

/** The local log folder: telemetry recordings, and session logs from before v0.42 until retention prunes them. */
export function getLogDir(): string {
  return path.join(app.getPath('home'), '.clubhouse', 'logs');
}

/**
 * Apply the logging retention tier to the log folder (#2298), never touching
 * the files being written. One pass at a time; never throws.
 */
export function runRetention(): Promise<unknown> {
  if (pruning) return pruning;
  const protect = recorder?.files().slice(-1) ?? [];
  let tier = LOG_RETENTION_TIERS.medium;
  try {
    tier = LOG_RETENTION_TIERS[logSettings.getSettings().retention] ?? tier;
  } catch {
    // Unreadable settings: the default tier.
  }
  pruning = pruneLogDir(getLogDir(), tier, { protect })
    .catch((): undefined => undefined)
    .finally(() => {
      pruning = null;
    });
  return pruning;
}

export function isLocalRecordingWanted(settings: LoggingSettings = logSettings.getSettings()): boolean {
  return settings.enabled !== false && settings.telemetryRecording !== false;
}

/** Diag lines follow `enabled` only (#2299). */
export function isDiagRecordingWanted(settings: LoggingSettings = logSettings.getSettings()): boolean {
  return settings.enabled !== false;
}

/**
 * The install's hash salt when one exists, so local hashes match exported
 * ones. Otherwise a salt for this run only: local recording never creates
 * an install id or writes telemetry-settings.json.
 */
function hashSalt(): Buffer {
  try {
    const s = getTelemetrySettings();
    if (isValidIdentity(s)) return Buffer.from(s.hashSalt, 'base64');
  } catch {
    // Unreadable settings: fall through to a per-run salt.
  }
  return randomBytes(32);
}

function start(level: LocalTelemetryLevel, signals: boolean): void {
  let username: string | undefined;
  try {
    username = os.userInfo().username;
  } catch {
    username = undefined;
  }
  const now = new Date();
  recorder = createLocalRecorder({
    dir: getLogDir(),
    // Milliseconds kept, so a recorder restarted within a second gets its own file.
    fileBase: now.toISOString().replace(/:/g, '-').replace(/Z$/, ''),
    level,
    signals,
    hashSalt: hashSalt(),
    scrub: createScrubber({ homeDir: os.homedir(), username, hostname: os.hostname() }),
    session: { appVersion: app.getVersion(), platform: process.platform, arch: process.arch },
    onRotate: () => void runRetention(),
  });
  if (signals) setLocalSink(recorder);
  setDiagSink(recorder);
  // Once when recording starts, then hourly while recording, so a run that lasts days is pruned as it goes.
  retentionTimer = setInterval(() => void runRetention(), RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();
  void runRetention();
}

async function stop(): Promise<void> {
  const r = recorder;
  if (!r) return;
  recorder = null;
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
  if (getLocalSink() === r) setLocalSink(null);
  if (getDiagSink() === r) setDiagSink(null);
  await r.stop().catch(() => {});
}

/**
 * Bring recording in line with the logging settings. Safe to call at any
 * time, before `ready` included; never throws.
 */
export async function syncLocalRecording(settings?: LoggingSettings): Promise<void> {
  try {
    if (stopping) await stopping;
    const current = migrateLocalLevel(settings ?? logSettings.getSettings());
    const wanted = isDiagRecordingWanted(current);
    const signals = isLocalRecordingWanted(current);
    const level = localRecordingLevel(current);
    // Signals turning on or off, or a level change while recording them, starts a new recorder (and file).
    if (recorder && (!wanted || recorder.signals !== signals || (signals && recorder.level !== level))) {
      stopping = stop().finally(() => {
        stopping = null;
      });
      await stopping;
    }
    if (wanted && !recorder) start(level, signals);
  } catch {
    // Local recording must never break startup or a settings save.
  }
}

/**
 * Start a fresh recorder (new file, current hash salt) if one is running.
 * Used after "Delete local telemetry data" removed the salt.
 */
export async function restartLocalRecording(): Promise<void> {
  try {
    if (stopping) await stopping;
    if (!recorder) return;
    stopping = stop().finally(() => {
      stopping = null;
    });
    await stopping;
    await syncLocalRecording();
  } catch {
    // Never break the settings action.
  }
}

/** Test-only reset. */
export async function _resetLocalRecordingForTests(): Promise<void> {
  await stop();
  stopping = null;
}
