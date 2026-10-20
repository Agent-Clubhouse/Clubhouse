/**
 * Starts and stops local telemetry recording (spec §6.12) from the logging
 * settings: it runs while `enabled` and `telemetryRecording` are both on,
 * whatever the export settings say. No OpenTelemetry imports.
 */
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { app } from 'electron';
import * as logSettings from '../services/log-settings';
import type { LocalTelemetryLevel, LoggingSettings } from '../../shared/types';
import { TELEMETRY_CONSENT_VERSION } from '../../shared/telemetry/settings-types';
import { getLocalSink, setLocalSink } from './facade';
import { isValidIdentity } from './ids';
import { createLocalRecorder, type LocalRecorder } from './local-recorder';
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

export function isLocalRecordingWanted(settings: LoggingSettings = logSettings.getSettings()): boolean {
  return settings.enabled !== false && settings.telemetryRecording !== false;
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

function start(level: LocalTelemetryLevel): void {
  let username: string | undefined;
  try {
    username = os.userInfo().username;
  } catch {
    username = undefined;
  }
  const now = new Date();
  recorder = createLocalRecorder({
    dir: path.join(app.getPath('home'), '.clubhouse', 'logs'),
    // Milliseconds kept, so a recorder restarted within a second gets its own file.
    fileBase: now.toISOString().replace(/:/g, '-').replace(/Z$/, ''),
    level,
    hashSalt: hashSalt(),
    scrub: createScrubber({ homeDir: os.homedir(), username, hostname: os.hostname() }),
    session: { appVersion: app.getVersion(), platform: process.platform, arch: process.arch },
  });
  setLocalSink(recorder);
}

async function stop(): Promise<void> {
  const r = recorder;
  if (!r) return;
  recorder = null;
  if (getLocalSink() === r) setLocalSink(null);
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
    const wanted = isLocalRecordingWanted(current);
    const level = localRecordingLevel(current);
    // A level change starts a new recorder (and file) at the new level.
    if (recorder && (!wanted || recorder.level !== level)) {
      stopping = stop().finally(() => {
        stopping = null;
      });
      await stopping;
    }
    if (wanted && !recorder) start(level);
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
