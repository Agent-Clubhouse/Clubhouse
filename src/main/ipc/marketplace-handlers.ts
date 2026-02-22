import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as marketplaceService from '../services/marketplace-service';
import type { MarketplaceInstallRequest } from '../../shared/marketplace-types';

export function registerMarketplaceHandlers(): void {
  ipcMain.handle(IPC.MARKETPLACE.FETCH_REGISTRY, () => {
    return marketplaceService.fetchRegistry();
  });

  ipcMain.handle(IPC.MARKETPLACE.INSTALL_PLUGIN, (_event, req: MarketplaceInstallRequest) => {
    return marketplaceService.installPlugin(req);
  });
}
