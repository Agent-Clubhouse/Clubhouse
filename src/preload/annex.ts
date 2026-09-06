import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const annex = {
  annex: {
  getSettings: () =>
    ipcRenderer.invoke(IPC.ANNEX.GET_SETTINGS),
  saveSettings: (settings: { enableServer: boolean; enableClient: boolean; deviceName: string; alias: string; icon: string; color: string; autoReconnect: boolean; enabled?: boolean }) =>
    ipcRenderer.invoke(IPC.ANNEX.SAVE_SETTINGS, settings),
  getStatus: () =>
    ipcRenderer.invoke(IPC.ANNEX.GET_STATUS),
  regeneratePin: () =>
    ipcRenderer.invoke(IPC.ANNEX.REGENERATE_PIN),
  onStatusChanged: (callback: (status: {
    advertising: boolean;
    port: number;
    pin: string;
    connectedCount: number;
    fingerprint: string;
    alias: string;
    icon: string;
    color: string;
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, s: Parameters<typeof callback>[0]) => callback(s);
    ipcRenderer.on(IPC.ANNEX.STATUS_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.ANNEX.STATUS_CHANGED, listener); };
  },
  onAgentSpawned: (callback: (agent: {
    id: string;
    name: string;
    kind: 'quick';
    status: string;
    prompt: string;
    model: string | null;
    orchestrator: string | null;
    freeAgentMode: boolean;
    parentAgentId: string | null;
    projectId: string;
    headless: boolean;
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agent: Parameters<typeof callback>[0]) => callback(agent);
    ipcRenderer.on(IPC.ANNEX.AGENT_SPAWNED, listener);
    return () => { ipcRenderer.removeListener(IPC.ANNEX.AGENT_SPAWNED, listener); };
  },
  listPeers: () =>
    ipcRenderer.invoke(IPC.ANNEX.LIST_PEERS),
  removePeer: (fingerprint: string) =>
    ipcRenderer.invoke(IPC.ANNEX.REMOVE_PEER, fingerprint),
  removeAllPeers: () =>
    ipcRenderer.invoke(IPC.ANNEX.REMOVE_ALL_PEERS),
  unlockPairing: () =>
    ipcRenderer.invoke(IPC.ANNEX.UNLOCK_PAIRING),
  onPeersChanged: (callback: (peers: Array<{
    fingerprint: string;
    publicKey: string;
    alias: string;
    icon: string;
    color: string;
    pairedAt: string;
    lastSeen: string;
  }>) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, peers: Parameters<typeof callback>[0]) => callback(peers);
    ipcRenderer.on(IPC.ANNEX.PEERS_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.ANNEX.PEERS_CHANGED, listener); };
  },
  onPairingLocked: (callback: (locked: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, locked: boolean) => callback(locked);
    ipcRenderer.on(IPC.ANNEX.PAIRING_LOCKED, listener);
    return () => { ipcRenderer.removeListener(IPC.ANNEX.PAIRING_LOCKED, listener); };
  },
  onLockStateChanged: (callback: (state: { locked: boolean; remainingMs: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state);
    ipcRenderer.on(IPC.ANNEX.LOCK_STATE_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.ANNEX.LOCK_STATE_CHANGED, listener); };
  },
  disconnectController: (fingerprint: string) =>
    ipcRenderer.invoke(IPC.ANNEX.DISCONNECT_CONTROLLER, fingerprint),
  disableAndDisconnect: () =>
    ipcRenderer.invoke(IPC.ANNEX.DISABLE_AND_DISCONNECT),
  notifyPause: (paused: boolean) =>
    ipcRenderer.invoke(IPC.ANNEX.NOTIFY_PAUSE, paused),
  purgeServerConfig: () =>
    ipcRenderer.invoke(IPC.ANNEX.PURGE_SERVER_CONFIG),
  },
};
