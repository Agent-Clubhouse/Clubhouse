import { create } from 'zustand';
import { NotificationSettings } from '../../shared/types';

interface NotificationState {
  settings: NotificationSettings | null;
  loadSettings: () => Promise<void>;
  saveSettings: (partial: Partial<NotificationSettings>) => Promise<void>;
  checkAndNotify: (agentName: string, eventName: string, detail?: string) => void;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  settings: null,

  loadSettings: async () => {
    const settings = await window.clubhouse.app.getNotificationSettings();
    set({ settings });
  },

  saveSettings: async (partial) => {
    const current = get().settings;
    if (!current) return;
    const merged = { ...current, ...partial };
    set({ settings: merged });
    await window.clubhouse.app.saveNotificationSettings(merged);
  },

  checkAndNotify: (agentName, eventName, detail) => {
    const s = get().settings;
    if (!s || !s.enabled) return;

    const silent = !s.playSound;
    let title = '';
    let body = '';

    if (eventName === 'Notification' && s.permissionNeeded) {
      title = `${agentName} needs permission`;
      body = 'Agent is waiting for approval';
    } else if (eventName === 'Stop' && s.agentStopped) {
      title = `${agentName} finished`;
      body = 'Agent has stopped';
    } else if (eventName === 'Stop' && s.agentIdle) {
      title = `${agentName} is idle`;
      body = 'Agent is waiting for input';
    } else if (eventName === 'PostToolUseFailure' && s.agentError) {
      title = `${agentName} hit an error`;
      body = detail ? `${detail} failed` : 'A tool call failed';
    } else {
      return;
    }

    window.clubhouse.app.sendNotification(title, body, silent);
  },
}));
