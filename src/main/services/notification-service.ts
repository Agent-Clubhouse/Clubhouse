import { BrowserWindow, Notification } from 'electron';
import { NotificationSettings } from '../../shared/types';
import { IPC } from '../../shared/ipc-channels';
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

export function sendNotification(
  title: string,
  body: string,
  silent: boolean,
  agentId?: string,
  projectId?: string,
): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent });
  n.on('click', () => {
    // Focus the app window
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      // Tell renderer to navigate to the agent
      if (agentId && projectId) {
        win.webContents.send(IPC.APP.NOTIFICATION_CLICKED, agentId, projectId);
      }
    }
  });
  n.show();
}
