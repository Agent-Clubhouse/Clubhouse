import * as fs from 'fs';
import * as path from 'path';
import { app, dialog } from 'electron';
import type { StartupMarker } from '../../shared/plugin-types';
import { appLog } from './log-service';
import { ATTR, tel } from '../telemetry';

function getMarkerPath(): string {
  return path.join(app.getPath('home'), '.clubhouse', '.startup-marker');
}

export function readMarker(): StartupMarker | null {
  try {
    const raw = fs.readFileSync(getMarkerPath(), 'utf-8');
    return JSON.parse(raw) as StartupMarker;
  } catch {
    return null;
  }
}

export function writeMarker(enabledPlugins: string[]): void {
  const existing = readMarker();
  const marker: StartupMarker = {
    timestamp: Date.now(),
    attempt: existing ? existing.attempt + 1 : 1,
    lastEnabledPlugins: enabledPlugins,
  };
  const dir = path.dirname(getMarkerPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getMarkerPath(), JSON.stringify(marker), 'utf-8');
}

export function clearMarker(): void {
  try {
    fs.unlinkSync(getMarkerPath());
  } catch {
    // Already gone
  }
}

export function shouldShowSafeModeDialog(): boolean {
  const marker = readMarker();
  return marker !== null && marker.attempt >= 2;
}

export function incrementAttempt(enabledPlugins: string[]): void {
  writeMarker(enabledPlugins);
}

/**
 * Prompts the user after a startup crash loop. Both choices clear the marker:
 * the decision is carried by {@link isSafeModeActive}, not by the marker, so a
 * stale marker must not leak into a "Try Again Normally" launch.
 */
export function handleSafeModeDialog(): boolean {
  const marker = readMarker();
  if (marker === null) {
    return false;
  }
  const pluginList = marker.lastEnabledPlugins?.join(', ') || 'unknown';
  appLog('core:safe-mode', 'warn', 'Startup crash loop detected, prompting safe mode', {
    meta: { attempt: marker.attempt, lastEnabledPlugins: marker.lastEnabledPlugins },
  });
  const response = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'Clubhouse — Safe Mode',
    message: 'Clubhouse failed to start properly on the last attempt.',
    detail: `This may be caused by a plugin. Last enabled plugins: ${pluginList}\n\nWould you like to start in safe mode (all plugins disabled)?`,
    buttons: ['Start in Safe Mode', 'Try Again Normally'],
    defaultId: 0,
    cancelId: 1,
  });
  clearMarker();
  if (response === 0) {
    appLog('core:safe-mode', 'warn', 'User chose safe mode — disabling all plugins');
    return true;
  }
  appLog('core:safe-mode', 'info', 'User chose to try again normally');
  return false;
}

let safeModeActive = false;

/**
 * Whether this process is running in safe mode. Main is the single source of
 * truth; the renderer reads this over IPC instead of re-deriving it from the
 * startup marker.
 */
export function isSafeModeActive(): boolean {
  return safeModeActive;
}

/**
 * Decides safe mode for this launch. Must run before registerAllHandlers(),
 * which reads CLUBHOUSE_SAFE_MODE when initializing trusted manifests.
 */
export function handleSafeModeStartup(forceSafeMode = process.argv.includes('--safe-mode')): boolean {
  const dialogShown = !forceSafeMode && shouldShowSafeModeDialog();
  const userChoseSafeMode = dialogShown && handleSafeModeDialog();
  if (forceSafeMode || dialogShown) {
    tel.event('clubhouse.app.safe_mode', [
      ATTR.safeModeTrigger(forceSafeMode ? 'cli_flag' : userChoseSafeMode ? 'user_chosen' : 'user_declined'),
    ]);
  }

  if (userChoseSafeMode || forceSafeMode) {
    appLog('core:safe-mode', 'warn', 'Safe mode activated — disabling all plugins');
    if (forceSafeMode) {
      clearMarker();
    }
    process.env.CLUBHOUSE_SAFE_MODE = '1';
    safeModeActive = true;
    return true;
  }

  safeModeActive = false;
  return false;
}
