import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { NotificationSettings, BadgeSettings, ResolvedProtocolAction } from '../shared/types';

export const app = {
  app: {
  openExternalUrl: (url: string) =>
    ipcRenderer.invoke(IPC.APP.OPEN_EXTERNAL_URL, url),
  getNotificationSettings: () =>
    ipcRenderer.invoke(IPC.APP.GET_NOTIFICATION_SETTINGS),
  saveNotificationSettings: (settings: NotificationSettings) =>
    ipcRenderer.invoke(IPC.APP.SAVE_NOTIFICATION_SETTINGS, settings),
  sendNotification: (title: string, body: string, silent: boolean, agentId?: string, projectId?: string) =>
    ipcRenderer.invoke(IPC.APP.SEND_NOTIFICATION, title, body, silent, agentId, projectId),
  closeNotification: (agentId: string, projectId: string) =>
    ipcRenderer.invoke(IPC.APP.CLOSE_NOTIFICATION, agentId, projectId),
  onNotificationClicked: (callback: (agentId: string, projectId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, projectId: string) =>
      callback(agentId, projectId);
    ipcRenderer.on(IPC.APP.NOTIFICATION_CLICKED, listener);
    return () => { ipcRenderer.removeListener(IPC.APP.NOTIFICATION_CLICKED, listener); };
  },
  onAgentAttention: (callback: (agentId: string, payload: { message: string; title?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, payload: { message: string; title?: string }) =>
      callback(agentId, payload);
    ipcRenderer.on(IPC.APP.AGENT_ATTENTION, listener);
    return () => { ipcRenderer.removeListener(IPC.APP.AGENT_ATTENTION, listener); };
  },
  onOpenSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.APP.OPEN_SETTINGS, listener);
    return () => { ipcRenderer.removeListener(IPC.APP.OPEN_SETTINGS, listener); };
  },
  onOpenAbout: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.APP.OPEN_ABOUT, listener);
    return () => { ipcRenderer.removeListener(IPC.APP.OPEN_ABOUT, listener); };
  },

  getTheme: () =>
    ipcRenderer.invoke(IPC.APP.GET_THEME),
  saveTheme: (settings: { themeId: string }) =>
    ipcRenderer.invoke(IPC.APP.SAVE_THEME, settings),
  onThemeChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.APP.THEME_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.APP.THEME_CHANGED, listener); };
  },
  syncPluginThemes: (themes: Array<{ id: string; name: string; type: 'dark' | 'light' }>) =>
    ipcRenderer.invoke(IPC.APP.SYNC_PLUGIN_THEMES, themes),
  updateTitleBarOverlay: (colors: { color: string; symbolColor: string }) =>
    ipcRenderer.invoke(IPC.APP.UPDATE_TITLE_BAR_OVERLAY, colors),
  getOrchestratorSettings: (): Promise<{ enabled: string[]; hookServerEnabled?: Record<string, boolean> }> =>
    ipcRenderer.invoke(IPC.APP.GET_ORCHESTRATOR_SETTINGS),
  saveOrchestratorSettings: (settings: { enabled?: string[]; hookServerEnabled?: Record<string, boolean> }) =>
    ipcRenderer.invoke(IPC.APP.SAVE_ORCHESTRATOR_SETTINGS, settings),
  setOrchestratorHookServer: (orchestratorId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.APP.SET_ORCHESTRATOR_HOOK_SERVER, orchestratorId, enabled),
  getVersion: (): Promise<string> =>
    ipcRenderer.invoke(IPC.APP.GET_VERSION),
  isPreviewEligible: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.APP.IS_PREVIEW_ELIGIBLE),
  getArchInfo: (): Promise<{ arch: string; platform: string; rosetta: boolean }> =>
    ipcRenderer.invoke(IPC.APP.GET_ARCH_INFO),
  getHeadlessSettings: () =>
    ipcRenderer.invoke(IPC.APP.GET_HEADLESS_SETTINGS),
  saveHeadlessSettings: (settings: { enabled?: boolean; defaultMode?: string; projectOverrides?: Record<string, string> }) =>
    ipcRenderer.invoke(IPC.APP.SAVE_HEADLESS_SETTINGS, settings),
  getFreeAgentSettings: () =>
    ipcRenderer.invoke(IPC.APP.GET_FREE_AGENT_SETTINGS),
  saveFreeAgentSettings: (settings: { defaultMode: string; projectOverrides?: Record<string, string> }) =>
    ipcRenderer.invoke(IPC.APP.SAVE_FREE_AGENT_SETTINGS, settings),
  setDockBadge: (count: number) =>
    ipcRenderer.invoke(IPC.APP.SET_DOCK_BADGE, count),
  getBadgeSettings: () =>
    ipcRenderer.invoke(IPC.APP.GET_BADGE_SETTINGS),
  saveBadgeSettings: (settings: BadgeSettings) =>
    ipcRenderer.invoke(IPC.APP.SAVE_BADGE_SETTINGS, settings),
  getUpdateSettings: () =>
    ipcRenderer.invoke(IPC.APP.GET_UPDATE_SETTINGS),
  saveUpdateSettings: (settings: { autoUpdate: boolean; previewChannel: boolean; lastCheck: string | null; dismissedVersion: string | null; lastSeenVersion: string | null }) =>
    ipcRenderer.invoke(IPC.APP.SAVE_UPDATE_SETTINGS, settings),
  checkForUpdates: () =>
    ipcRenderer.invoke(IPC.APP.CHECK_FOR_UPDATES),
  getUpdateStatus: () =>
    ipcRenderer.invoke(IPC.APP.GET_UPDATE_STATUS),
  applyUpdate: () =>
    ipcRenderer.invoke(IPC.APP.APPLY_UPDATE),
  getLiveAgentsForUpdate: () =>
    ipcRenderer.invoke(IPC.APP.GET_LIVE_AGENTS_FOR_UPDATE),
  getPendingResumes: () =>
    ipcRenderer.invoke(IPC.APP.GET_PENDING_RESUMES),
  getPendingProtocolAction: (): Promise<ResolvedProtocolAction | null> =>
    ipcRenderer.invoke(IPC.APP.GET_PENDING_PROTOCOL_ACTION),
  onProtocolAction: (callback: (action: ResolvedProtocolAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: ResolvedProtocolAction) =>
      callback(action);
    ipcRenderer.on(IPC.APP.PROTOCOL_ACTION, listener);
    return () => { ipcRenderer.removeListener(IPC.APP.PROTOCOL_ACTION, listener); };
  },
  resumeManualAgent: (agentId: string, projectPath: string, sessionId?: string) =>
    ipcRenderer.invoke(IPC.APP.RESUME_MANUAL_AGENT, agentId, projectPath, sessionId),
  resolveWorkingAgent: (agentId: string, action: string) =>
    ipcRenderer.invoke(IPC.APP.RESOLVE_WORKING_AGENT, agentId, action),
  confirmUpdateRestart: (data: { agentNames: Record<string, string>; agentMeta?: Record<string, unknown> }) =>
    ipcRenderer.invoke(IPC.APP.CONFIRM_UPDATE_RESTART, data),
  devSimulateUpdateRestart: (data: { agentNames: Record<string, string>; agentMeta?: Record<string, unknown> }) => {
    if (process.env.NODE_ENV !== 'development') return Promise.reject(new Error('dev-only API'));
    return ipcRenderer.invoke(IPC.APP.DEV_SIMULATE_UPDATE_RESTART, data);
  },
  onDevSimulateUpdateRestart: (callback: () => void) => {
    if (process.env.NODE_ENV !== 'development') return () => {};
    const listener = () => callback();
    ipcRenderer.on(IPC.APP.DEV_SIMULATE_UPDATE_RESTART, listener);
    return () => { ipcRenderer.removeListener(IPC.APP.DEV_SIMULATE_UPDATE_RESTART, listener); };
  },
  onResumeStatusUpdate: (callback: (data: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on(IPC.APP.RESUME_STATUS_UPDATE, listener);
    return () => { ipcRenderer.removeListener(IPC.APP.RESUME_STATUS_UPDATE, listener); };
  },
  getPendingReleaseNotes: () =>
    ipcRenderer.invoke(IPC.APP.GET_PENDING_RELEASE_NOTES),
  clearPendingReleaseNotes: () =>
    ipcRenderer.invoke(IPC.APP.CLEAR_PENDING_RELEASE_NOTES),
  getVersionHistory: () =>
    ipcRenderer.invoke(IPC.APP.GET_VERSION_HISTORY),
  getClipboardSettings: () =>
    ipcRenderer.invoke(IPC.APP.GET_CLIPBOARD_SETTINGS),
  saveClipboardSettings: (settings: { clipboardCompat: boolean }) =>
    ipcRenderer.invoke(IPC.APP.SAVE_CLIPBOARD_SETTINGS, settings),
  readClipboardText: (): Promise<string> =>
    ipcRenderer.invoke(IPC.APP.READ_CLIPBOARD_TEXT),
  readClipboardImage: (): Promise<{ base64: string; mimeType: string } | null> =>
    ipcRenderer.invoke(IPC.APP.READ_CLIPBOARD_IMAGE),
  getSessionSettings: () =>
    ipcRenderer.invoke(IPC.APP.GET_SESSION_SETTINGS),
  saveSessionSettings: (settings: { promptForName: boolean; projectOverrides?: Record<string, boolean> }) =>
    ipcRenderer.invoke(IPC.APP.SAVE_SESSION_SETTINGS, settings),
  getClubhouseModeSettings: () =>
    ipcRenderer.invoke(IPC.APP.GET_CLUBHOUSE_MODE_SETTINGS),
  saveClubhouseModeSettings: (settings: { enabled: boolean; projectOverrides?: Record<string, boolean>; sourceControlProvider?: 'github' | 'azure-devops' }, projectPath?: string) =>
    ipcRenderer.invoke(IPC.APP.SAVE_CLUBHOUSE_MODE_SETTINGS, settings, projectPath),
  getSoundSettings: () =>
    ipcRenderer.invoke(IPC.APP.GET_SOUND_SETTINGS),
  saveSoundSettings: (settings: {
    activePack?: string | null;
    slotAssignments: Partial<Record<string, { packId: string }>>;
    eventSettings: Record<string, { enabled: boolean; volume: number }>;
    projectOverrides?: Record<string, {
      activePack?: string | null;
      slotAssignments?: Partial<Record<string, { packId: string }>>;
    }>;
  }) =>
    ipcRenderer.invoke(IPC.APP.SAVE_SOUND_SETTINGS, settings),
  listSoundPacks: (): Promise<Array<{
    id: string;
    name: string;
    description?: string;
    author?: string;
    sounds: Record<string, string>;
    source: 'user' | 'plugin';
    pluginId?: string;
  }>> =>
    ipcRenderer.invoke(IPC.APP.LIST_SOUND_PACKS),
  importSoundPack: () =>
    ipcRenderer.invoke(IPC.APP.IMPORT_SOUND_PACK),
  deleteSoundPack: (packId: string) =>
    ipcRenderer.invoke(IPC.APP.DELETE_SOUND_PACK, packId),
  getSoundData: (packId: string, event: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.APP.GET_SOUND_DATA, packId, event),
  onUpdateStatusChanged: (callback: (status: {
    state: string;
    availableVersion: string | null;
    releaseNotes: string | null;
    releaseMessage: string | null;
    downloadProgress: number;
    error: string | null;
    downloadPath: string | null;
    artifactUrl: string | null;
    applyAttempted: boolean;
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, s: Parameters<typeof callback>[0]) => callback(s);
    ipcRenderer.on(IPC.APP.UPDATE_STATUS_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.APP.UPDATE_STATUS_CHANGED, listener); };
  },
  restart: () =>
    ipcRenderer.invoke(IPC.APP.RESTART),
  getExperimentalSettings: (): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke(IPC.APP.GET_EXPERIMENTAL_SETTINGS),
  saveExperimentalSettings: (settings: Record<string, boolean>) =>
    ipcRenderer.invoke(IPC.APP.SAVE_EXPERIMENTAL_SETTINGS, settings),
  },
};
