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
import { withValidatedArgs, objectArg } from './validation';

export function registerMarketplaceHandlers(): void {
  ipcMain.handle(IPC.MARKETPLACE.FETCH_REGISTRY, async () => {
    return marketplaceService.fetchRegistry();
  });

  ipcMain.handle(IPC.MARKETPLACE.INSTALL_PLUGIN, withValidatedArgs(
    [objectArg<MarketplaceInstallRequest>({
      validate: (v, name) => {
        if (typeof v.pluginId !== 'string' || !v.pluginId) throw new Error(`${name}.pluginId must be a non-empty string`);
        if (typeof v.version !== 'string' || !v.version) throw new Error(`${name}.version must be a non-empty string`);
        if (typeof v.assetUrl !== 'string' || !v.assetUrl) throw new Error(`${name}.assetUrl must be a non-empty string`);
        if (typeof v.sha256 !== 'string' || !v.sha256) throw new Error(`${name}.sha256 must be a non-empty string`);
      },
    })],
    async (_event, req) => {
      return marketplaceService.installPlugin(req);
    },
  ));

  ipcMain.handle(IPC.MARKETPLACE.CHECK_PLUGIN_UPDATES, async () => {
    return pluginUpdateService.checkForPluginUpdates();
  });

  ipcMain.handle(IPC.MARKETPLACE.UPDATE_PLUGIN, withValidatedArgs(
    [objectArg<PluginUpdateRequest>({
      validate: (v, name) => {
        if (typeof v.pluginId !== 'string' || !v.pluginId) throw new Error(`${name}.pluginId must be a non-empty string`);
      },
    })],
    async (_event, req) => {
      return pluginUpdateService.updatePlugin(req.pluginId);
    },
  ));

  // Custom marketplace CRUD
  ipcMain.handle(IPC.MARKETPLACE.LIST_CUSTOM, async () => {
    return customMarketplaceService.listCustomMarketplaces();
  });

  ipcMain.handle(IPC.MARKETPLACE.ADD_CUSTOM, withValidatedArgs(
    [objectArg<CustomMarketplaceAddRequest>({
      validate: (v, name) => {
        if (typeof v.name !== 'string' || !v.name) throw new Error(`${name}.name must be a non-empty string`);
        if (typeof v.url !== 'string' || !v.url) throw new Error(`${name}.url must be a non-empty string`);
      },
    })],
    async (_event, req) => {
      return customMarketplaceService.addCustomMarketplace(req);
    },
  ));

  ipcMain.handle(IPC.MARKETPLACE.REMOVE_CUSTOM, withValidatedArgs(
    [objectArg<CustomMarketplaceRemoveRequest>({
      validate: (v, name) => {
        if (typeof v.id !== 'string' || !v.id) throw new Error(`${name}.id must be a non-empty string`);
      },
    })],
    async (_event, req) => {
      return customMarketplaceService.removeCustomMarketplace(req);
    },
  ));

  ipcMain.handle(IPC.MARKETPLACE.TOGGLE_CUSTOM, withValidatedArgs(
    [objectArg<CustomMarketplaceToggleRequest>({
      validate: (v, name) => {
        if (typeof v.id !== 'string' || !v.id) throw new Error(`${name}.id must be a non-empty string`);
        if (typeof v.enabled !== 'boolean') throw new Error(`${name}.enabled must be a boolean`);
      },
    })],
    async (_event, req) => {
      return customMarketplaceService.toggleCustomMarketplace(req);
    },
  ));
}
