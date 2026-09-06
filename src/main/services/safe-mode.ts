import * as fs from 'fs';
import * as path from 'path';
import { app, dialog } from 'electron';
import type { StartupMarker } from '../../shared/plugin-types';
import { appLog } from './log-service';

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
  if (response === 0) {
    appLog('core:safe-mode', 'warn', 'User chose safe mode — disabling all plugins');
    clearMarker();
    return true;
  }
  return false;
}
