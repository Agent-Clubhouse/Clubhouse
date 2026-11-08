import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { AnnexAgentUpdate } from '../shared/mobile-control';
import type { AnnexDevice, AnnexPeerListing } from '../shared/types';

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
  onAgentUpdated: (callback: (update: AnnexAgentUpdate) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: AnnexAgentUpdate) => callback(update);
    ipcRenderer.on(IPC.ANNEX.AGENT_UPDATED, listener);
    return () => { ipcRenderer.removeListener(IPC.ANNEX.AGENT_UPDATED, listener); };
  },
  /** Every paired device, whichever way it's paired, with where it stands (#3057). */
  listDevices: (): Promise<AnnexDevice[]> =>
    ipcRenderer.invoke(IPC.ANNEX.LIST_DEVICES),
  /** Removes a device and ends its connections, whichever way it's paired. */
  removeDevice: (fingerprint: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.ANNEX.REMOVE_DEVICE, fingerprint),
  onDevicesChanged: (callback: (devices: AnnexDevice[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, devices: AnnexDevice[]) => callback(devices);
    ipcRenderer.on(IPC.ANNEX.DEVICES_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.ANNEX.DEVICES_CHANGED, listener); };
  },
  listPeers: (): Promise<AnnexPeerListing[]> =>
    ipcRenderer.invoke(IPC.ANNEX.LIST_PEERS),
  removePeer: (fingerprint: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.ANNEX.REMOVE_PEER, fingerprint),
  removeAllPeers: () =>
    ipcRenderer.invoke(IPC.ANNEX.REMOVE_ALL_PEERS),
  unlockPairing: () =>
    ipcRenderer.invoke(IPC.ANNEX.UNLOCK_PAIRING),
  onPeersChanged: (callback: (peers: AnnexPeerListing[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, peers: Parameters<typeof callback>[0]) => callback(peers);
    ipcRenderer.on(IPC.ANNEX.PEERS_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.ANNEX.PEERS_CHANGED, listener); };
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
