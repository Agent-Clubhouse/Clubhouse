import { Notification } from 'electron';
import { NotificationSettings } from '../../shared/types';
import { createSettingsStore } from './settings-store';

const store = createSettingsStore<NotificationSettings>('notification-settings.json', {
  enabled: true,
  permissionNeeded: true,
  agentIdle: false,
  agentStopped: false,
  agentError: false,
  playSound: true,
});

export const getSettings = store.get;
export const saveSettings = store.save;

export function sendNotification(title: string, body: string, silent: boolean): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent }).show();
}
