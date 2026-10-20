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
import type { LoggingSettings } from '../../shared/types';
import type { TelemetryLevel } from '../../shared/telemetry/attributes';
import { getLocalSink, setLocalSink } from './facade';
import { isValidIdentity } from './ids';
import { createLocalRecorder, type LocalRecorder } from './local-recorder';
import { createScrubber } from './scrubber';
import { getTelemetrySettings } from './settings';

/** Local recording keeps flows and errors; Detailed-only signals (per-IPC spans, tool calls) stay off. */
export const LOCAL_RECORDING_LEVEL: TelemetryLevel = 'standard';

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

function start(): void {
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
    level: LOCAL_RECORDING_LEVEL,
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
    const wanted = isLocalRecordingWanted(settings);
    if (wanted && !recorder) start();
    else if (!wanted && recorder) {
      stopping = stop().finally(() => {
        stopping = null;
      });
      await stopping;
    }
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
