import { create } from 'zustand';
import { NotificationSettings } from '../../shared/types';
import { useAgentStore } from './agentStore';
import { useUIStore } from './uiStore';
import { useProjectStore } from './projectStore';
import { useSoundStore, mapNotificationToSoundEvent, hasAnyCustomPack } from './soundStore';

export function isAgentVisible(agentId: string, projectId: string): boolean {
  if (!document.hasFocus()) return false;

  const { explorerTab } = useUIStore.getState();
  const { activeProjectId } = useProjectStore.getState();

  // Agent is selected in the agents panel
  if (explorerTab === 'agents' && activeProjectId === projectId) {
    const { activeAgentId } = useAgentStore.getState();
    if (activeAgentId === agentId) return true;
  }

  return false;
}

interface NotificationState {
  settings: NotificationSettings | null;
  loadSettings: () => Promise<void>;
  saveSettings: (partial: Partial<NotificationSettings>) => Promise<void>;
  checkAndNotify: (
    agentName: string,
    eventKind: string,
    detail?: string,
    agentId?: string,
    projectId?: string,
    attention?: { message: string; title?: string },
  ) => void;
  clearNotification: (agentId: string, projectId: string) => void;
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

  checkAndNotify: (agentName, eventKind, detail, agentId, projectId, attention) => {
    const s = get().settings;
    if (!s || !s.enabled) return;

    // Suppress notifications for agents currently visible on screen
    if (agentId && projectId && isAgentVisible(agentId, projectId)) return;

    const silent = !s.playSound;
    let title = '';
    let body = '';

    if (eventKind === 'permission_request' && s.permissionNeeded) {
      title = `${agentName} needs permission`;
      body = detail ? `Wants to use ${detail}` : 'Agent is waiting for approval';
    } else if (eventKind === 'stop' && s.agentStopped) {
      title = `${agentName} finished`;
      body = 'Agent has stopped';
    } else if (eventKind === 'stop' && s.agentIdle) {
      title = `${agentName} is idle`;
      body = 'Agent is waiting for input';
    } else if (eventKind === 'tool_error' && s.agentError) {
      title = `${agentName} hit an error`;
      body = detail ? `${detail} failed` : 'A tool call failed';
    } else if (eventKind === 'attention' && s.agentRequestedAttention) {
      // Agent deliberately requested attention via the notify_user tool.
      title = attention?.title?.trim() || `${agentName} needs you`;
      body = attention?.message?.trim() || 'Agent requested your attention';
    } else {
      return;
    }

    // When a custom sound is assigned for this event, silence the OS notification
    // sound and play our custom sound instead
    const soundEvent = mapNotificationToSoundEvent(eventKind);
    const soundSettings = useSoundStore.getState().settings;
    const hasCustom = soundSettings ? hasAnyCustomPack(soundSettings, projectId) : false;

    const effectiveSilent = hasCustom ? true : silent;
    window.clubhouse.app.sendNotification(title, body, effectiveSilent, agentId, projectId);

    // Play custom sound
    if (soundEvent && s.playSound) {
      useSoundStore.getState().playSound(soundEvent, projectId);
    }
  },

  clearNotification: (agentId, projectId) => {
    window.clubhouse.app.closeNotification(agentId, projectId);
  },
}));
