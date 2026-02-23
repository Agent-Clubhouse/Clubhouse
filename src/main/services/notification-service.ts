import { BrowserWindow, Notification } from 'electron';
import { NotificationSettings } from '../../shared/types';
import { IPC } from '../../shared/ipc-channels';
import { createSettingsStore } from './settings-store';
import { broadcastToAllWindows } from '../util/ipc-broadcast';

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

/** Auto-dismiss timeout in milliseconds */
const DISMISS_TIMEOUT_MS = 5_000;

/**
 * Active notifications keyed by `agentId:projectId`.
 * Each entry holds the Notification instance and its auto-dismiss timer.
 */
const activeNotifications = new Map<string, { notification: Notification; timer: ReturnType<typeof setTimeout> }>();

function notificationKey(agentId: string, projectId: string): string {
  return `${agentId}:${projectId}`;
}

function clearEntry(key: string): void {
  const entry = activeNotifications.get(key);
  if (entry) {
    clearTimeout(entry.timer);
    entry.notification.close();
    activeNotifications.delete(key);
  }
}

export function sendNotification(
  title: string,
  body: string,
  silent: boolean,
  agentId?: string,
  projectId?: string,
): void {
  if (!Notification.isSupported()) return;

  // If there's already a notification for this agent, close it first
  if (agentId && projectId) {
    const key = notificationKey(agentId, projectId);
    clearEntry(key);
  }

  const n = new Notification({ title, body, silent });
  n.on('click', () => {
    // Focus the first available window to bring the app to the foreground
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // Broadcast navigation event to ALL windows so pop-outs stay in sync
    if (agentId && projectId) {
      broadcastToAllWindows(IPC.APP.NOTIFICATION_CLICKED, agentId, projectId);
    }
    // Clean up tracking on click
    if (agentId && projectId) {
      const key = notificationKey(agentId, projectId);
      const entry = activeNotifications.get(key);
      if (entry) {
        clearTimeout(entry.timer);
        activeNotifications.delete(key);
      }
    }
  });

  n.on('close', () => {
    // Clean up tracking when OS dismisses the notification
    if (agentId && projectId) {
      const key = notificationKey(agentId, projectId);
      const entry = activeNotifications.get(key);
      if (entry) {
        clearTimeout(entry.timer);
        activeNotifications.delete(key);
      }
    }
  });

  n.show();

  // Track and auto-dismiss
  if (agentId && projectId) {
    const key = notificationKey(agentId, projectId);
    const timer = setTimeout(() => {
      const entry = activeNotifications.get(key);
      if (entry) {
        entry.notification.close();
        activeNotifications.delete(key);
      }
    }, DISMISS_TIMEOUT_MS);

    activeNotifications.set(key, { notification: n, timer });
  } else {
    // Notifications without agent context still auto-dismiss
    setTimeout(() => n.close(), DISMISS_TIMEOUT_MS);
  }
}

/**
 * Programmatically close any active notification for a given agent.
 * Called from the renderer when the user navigates to the agent view.
 */
export function closeNotification(agentId: string, projectId: string): void {
  const key = notificationKey(agentId, projectId);
  clearEntry(key);
}
