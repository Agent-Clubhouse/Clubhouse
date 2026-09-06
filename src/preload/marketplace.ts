import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { PluginUpdatesStatus } from '../shared/marketplace-types';

export const marketplace = {
  marketplace: {
  fetchRegistry: () =>
    ipcRenderer.invoke(IPC.MARKETPLACE.FETCH_REGISTRY),
  installPlugin: (req: { pluginId: string; version: string; assetUrl: string; sha256: string }) =>
    ipcRenderer.invoke(IPC.MARKETPLACE.INSTALL_PLUGIN, req),
  checkPluginUpdates: () =>
    ipcRenderer.invoke(IPC.MARKETPLACE.CHECK_PLUGIN_UPDATES),
  updatePlugin: (req: { pluginId: string }) =>
    ipcRenderer.invoke(IPC.MARKETPLACE.UPDATE_PLUGIN, req),
  getPluginUpdatesStatus: (): PluginUpdatesStatus => ({
    updates: [],
    incompatibleUpdates: [],
    checking: false,
    lastCheck: null,
    updating: {},
    error: null,
  }),
  onPluginUpdatesChanged: (callback: (status: PluginUpdatesStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, s: PluginUpdatesStatus) => callback(s);
    ipcRenderer.on(IPC.MARKETPLACE.PLUGIN_UPDATES_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.MARKETPLACE.PLUGIN_UPDATES_CHANGED, listener); };
  },
  listCustomMarketplaces: () =>
    ipcRenderer.invoke(IPC.MARKETPLACE.LIST_CUSTOM),
  addCustomMarketplace: (req: { name: string; url: string }) =>
    ipcRenderer.invoke(IPC.MARKETPLACE.ADD_CUSTOM, req),
  removeCustomMarketplace: (req: { id: string }) =>
    ipcRenderer.invoke(IPC.MARKETPLACE.REMOVE_CUSTOM, req),
  toggleCustomMarketplace: (req: { id: string; enabled: boolean }) =>
    ipcRenderer.invoke(IPC.MARKETPLACE.TOGGLE_CUSTOM, req),
  fetchCustomRegistries: () =>
    ipcRenderer.invoke(IPC.MARKETPLACE.FETCH_CUSTOM_REGISTRIES),
  getMarketplaceSettings: () =>
    ipcRenderer.invoke(IPC.MARKETPLACE.GET_SETTINGS),
  saveMarketplaceSettings: (settings: { showBetaPlugins: boolean }) =>
    ipcRenderer.invoke(IPC.MARKETPLACE.SAVE_SETTINGS, settings),
  },
};
