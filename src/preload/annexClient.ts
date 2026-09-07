import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const annexClient = {
  annexClient: {
  getSatellites: () =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GET_SATELLITES),
  connect: (fingerprint: string, bearerToken?: string) =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.CONNECT, fingerprint, bearerToken),
  disconnect: (fingerprint: string) =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.DISCONNECT, fingerprint),
  retry: (fingerprint: string) =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.RETRY, fingerprint),
  scan: () =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.SCAN),
  ptyInput: (satelliteId: string, agentId: string, data: string) =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.PTY_INPUT, satelliteId, agentId, data),
  ptyResize: (satelliteId: string, agentId: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.PTY_RESIZE, satelliteId, agentId, cols, rows),
  agentSpawn: (satelliteId: string, params: unknown) =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.AGENT_SPAWN, satelliteId, params),
  agentKill: (satelliteId: string, agentId: string) =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.AGENT_KILL, satelliteId, agentId),
  agentWake: (satelliteId: string, agentId: string, options?: { resume?: boolean; mission?: string }) =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.AGENT_WAKE, satelliteId, agentId, options),
  ptyGetBuffer: (satelliteId: string, agentId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.PTY_GET_BUFFER, satelliteId, agentId),
  fileTree: (satelliteId: string, projectId: string, options?: { path?: string; depth?: number; includeHidden?: boolean }): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.FILE_TREE, satelliteId, projectId, options),
  fileRead: (satelliteId: string, projectId: string, path: string): Promise<string> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.FILE_READ, satelliteId, projectId, path),
  ptySpawnShell: (satelliteId: string, sessionId: string, projectId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.PTY_SPAWN_SHELL, satelliteId, sessionId, projectId),
  clipboardImage: (satelliteId: string, agentId: string, base64: string, mimeType: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.CLIPBOARD_IMAGE, satelliteId, agentId, base64, mimeType),
  gitOperation: (satelliteId: string, projectId: string, params: { operation: string; [key: string]: unknown }): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GIT_OPERATION, satelliteId, projectId, params),
  sessionList: (satelliteId: string, agentId: string, projectId: string, orchestrator?: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.SESSION_LIST, satelliteId, agentId, projectId, orchestrator),
  sessionTranscript: (satelliteId: string, agentId: string, sessionId: string, projectId: string, offset: number, limit: number, orchestrator?: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.SESSION_TRANSCRIPT, satelliteId, agentId, sessionId, projectId, offset, limit, orchestrator),
  sessionSummary: (satelliteId: string, agentId: string, sessionId: string, projectId: string, orchestrator?: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.SESSION_SUMMARY, satelliteId, agentId, sessionId, projectId, orchestrator),
  agentCreateDurable: (satelliteId: string, projectId: string, params: {
    name: string; color: string; model?: string; useWorktree?: boolean;
    orchestrator?: string; freeAgentMode?: boolean; mcpIds?: string[];
  }): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.AGENT_CREATE_DURABLE, satelliteId, projectId, params),
  agentDeleteDurable: (satelliteId: string, projectId: string, agentId: string, mode: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.AGENT_DELETE_DURABLE, satelliteId, projectId, agentId, mode),
  agentWorktreeStatus: (satelliteId: string, projectId: string, agentId: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.AGENT_WORKTREE_STATUS, satelliteId, projectId, agentId),
  agentReorder: (satelliteId: string, projectId: string, orderedIds: string[]) =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.AGENT_REORDER, satelliteId, projectId, orderedIds),
  canvasMutation: (satelliteId: string, projectId: string, canvasId: string, scope: string, mutation: unknown): Promise<void> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.CANVAS_MUTATION, satelliteId, projectId, canvasId, scope, mutation),
  gpGet: (satelliteId: string, groupProjectId: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_GET, satelliteId, groupProjectId),
  gpUpdate: (satelliteId: string, groupProjectId: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_UPDATE, satelliteId, groupProjectId, fields),
  gpBulletinDigest: (satelliteId: string, groupProjectId: string, since?: string | Record<string, string>): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_BULLETIN_DIGEST, satelliteId, groupProjectId, since),
  gpBulletinTopic: (satelliteId: string, groupProjectId: string, topic: string, since?: string, limit?: number): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_BULLETIN_TOPIC, satelliteId, groupProjectId, topic, since, limit),
  gpBulletinAll: (satelliteId: string, groupProjectId: string, since?: string, limit?: number): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_BULLETIN_ALL, satelliteId, groupProjectId, since, limit),
  gpBulletinPost: (satelliteId: string, groupProjectId: string, sender: string, topic: string, body: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_BULLETIN_POST, satelliteId, groupProjectId, sender, topic, body),
  gpShoulderTap: (satelliteId: string, groupProjectId: string, targetAgentId: string | null, message: string, sender?: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_SHOULDER_TAP, satelliteId, groupProjectId, targetAgentId, message, sender),
  gpDeleteMessage: (satelliteId: string, groupProjectId: string, topic: string, messageId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_DELETE_MESSAGE, satelliteId, groupProjectId, topic, messageId),
  gpDeleteTopic: (satelliteId: string, groupProjectId: string, topic: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_DELETE_TOPIC, satelliteId, groupProjectId, topic),
  gpSetTopicProtection: (satelliteId: string, groupProjectId: string, topic: string, isProtected: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_SET_TOPIC_PROTECTION, satelliteId, groupProjectId, topic, isProtected),
  gpInjectMessage: (satelliteId: string, agentId: string, message: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_INJECT_MESSAGE, satelliteId, agentId, message),
  gpSetPolling: (satelliteId: string, groupProjectId: string, enabled: boolean): Promise<unknown> =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GP_SET_POLLING, satelliteId, groupProjectId, enabled),
  forgetSatellite: (fingerprint: string) =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.FORGET_SATELLITE, fingerprint),
  forgetAllSatellites: () =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.FORGET_ALL_SATELLITES),
  getDiscovered: () =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.GET_DISCOVERED),
  pairWith: (fingerprint: string, pin: string) =>
    ipcRenderer.invoke(IPC.ANNEX_CLIENT.PAIR_WITH, fingerprint, pin),
  onSatellitesChanged: (callback: (satellites: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sats: Parameters<typeof callback>[0]) => callback(sats);
    ipcRenderer.on(IPC.ANNEX_CLIENT.SATELLITES_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.ANNEX_CLIENT.SATELLITES_CHANGED, listener); };
  },
  onDiscoveredChanged: (callback: (services: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on(IPC.ANNEX_CLIENT.DISCOVERED_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.ANNEX_CLIENT.DISCOVERED_CHANGED, listener); };
  },
  onSatelliteEvent: (callback: (event: { satelliteId: string; type: string; payload: unknown }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on(IPC.ANNEX_CLIENT.SATELLITE_EVENT, listener);
    return () => { ipcRenderer.removeListener(IPC.ANNEX_CLIENT.SATELLITE_EVENT, listener); };
  },
  },
};
