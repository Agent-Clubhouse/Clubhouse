import { app, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { NotificationSettings } from '../../shared/types';

const DEFAULTS: NotificationSettings = {
  enabled: true,
  permissionNeeded: true,
  agentIdle: false,
  agentStopped: false,
  agentError: false,
  playSound: true,
};

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'notification-settings.json');
}

export function getSettings(): NotificationSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: NotificationSettings): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf-8');
}

export function sendNotification(title: string, body: string, silent: boolean): void {
  new Notification({ title, body, silent }).show();
}
