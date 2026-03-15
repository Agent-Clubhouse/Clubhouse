import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as marketplaceService from '../services/marketplace-service';
import * as pluginUpdateService from '../services/plugin-update-service';
import * as customMarketplaceService from '../services/custom-marketplace-service';
import type {
  MarketplaceInstallRequest,
  PluginUpdateRequest,
  CustomMarketplaceAddRequest,
  CustomMarketplaceRemoveRequest,
  CustomMarketplaceToggleRequest,
} from '../../shared/marketplace-types';

export function registerMarketplaceHandlers(): void {
  ipcMain.handle(IPC.MARKETPLACE.FETCH_REGISTRY, async () => {
    return marketplaceService.fetchRegistry();
  });

  ipcMain.handle(IPC.MARKETPLACE.INSTALL_PLUGIN, async (_event, req: MarketplaceInstallRequest) => {
    return marketplaceService.installPlugin(req);
  });

  ipcMain.handle(IPC.MARKETPLACE.CHECK_PLUGIN_UPDATES, async () => {
    return pluginUpdateService.checkForPluginUpdates();
  });

  ipcMain.handle(IPC.MARKETPLACE.UPDATE_PLUGIN, async (_event, req: PluginUpdateRequest) => {
    return pluginUpdateService.updatePlugin(req.pluginId);
  });

  // Custom marketplace CRUD
  ipcMain.handle(IPC.MARKETPLACE.LIST_CUSTOM, async () => {
    return customMarketplaceService.listCustomMarketplaces();
  });

  ipcMain.handle(IPC.MARKETPLACE.ADD_CUSTOM, async (_event, req: CustomMarketplaceAddRequest) => {
    return customMarketplaceService.addCustomMarketplace(req);
  });

  ipcMain.handle(IPC.MARKETPLACE.REMOVE_CUSTOM, async (_event, req: CustomMarketplaceRemoveRequest) => {
    return customMarketplaceService.removeCustomMarketplace(req);
  });

  ipcMain.handle(IPC.MARKETPLACE.TOGGLE_CUSTOM, async (_event, req: CustomMarketplaceToggleRequest) => {
    return customMarketplaceService.toggleCustomMarketplace(req);
  });
}
