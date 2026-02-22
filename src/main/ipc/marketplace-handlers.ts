import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as marketplaceService from '../services/marketplace-service';
import * as pluginUpdateService from '../services/plugin-update-service';
import type { MarketplaceInstallRequest, PluginUpdateRequest } from '../../shared/marketplace-types';

export function registerMarketplaceHandlers(): void {
  ipcMain.handle(IPC.MARKETPLACE.FETCH_REGISTRY, () => {
    return marketplaceService.fetchRegistry();
  });

  ipcMain.handle(IPC.MARKETPLACE.INSTALL_PLUGIN, (_event, req: MarketplaceInstallRequest) => {
    return marketplaceService.installPlugin(req);
  });

  ipcMain.handle(IPC.MARKETPLACE.CHECK_PLUGIN_UPDATES, () => {
    return pluginUpdateService.checkForPluginUpdates();
  });

  ipcMain.handle(IPC.MARKETPLACE.UPDATE_PLUGIN, (_event, req: PluginUpdateRequest) => {
    return pluginUpdateService.updatePlugin(req.pluginId);
  });
}
