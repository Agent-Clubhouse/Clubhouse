import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../services/marketplace-service', () => ({
  fetchRegistry: vi.fn(async () => ({ version: 1, plugins: [] })),
  installPlugin: vi.fn(async () => ({ success: true })),
}));

vi.mock('../services/plugin-update-service', () => ({
  checkForPluginUpdates: vi.fn(async () => []),
  updatePlugin: vi.fn(async () => ({ success: true })),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerMarketplaceHandlers } from './marketplace-handlers';
import * as marketplaceService from '../services/marketplace-service';
import * as pluginUpdateService from '../services/plugin-update-service';

describe('marketplace-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerMarketplaceHandlers();
  });

  it('registers all marketplace IPC handlers', () => {
    expect(handlers.has(IPC.MARKETPLACE.FETCH_REGISTRY)).toBe(true);
    expect(handlers.has(IPC.MARKETPLACE.INSTALL_PLUGIN)).toBe(true);
    expect(handlers.has(IPC.MARKETPLACE.CHECK_PLUGIN_UPDATES)).toBe(true);
    expect(handlers.has(IPC.MARKETPLACE.UPDATE_PLUGIN)).toBe(true);
  });

  it('FETCH_REGISTRY delegates to marketplaceService.fetchRegistry', async () => {
    const handler = handlers.get(IPC.MARKETPLACE.FETCH_REGISTRY)!;
    const result = await handler({});
    expect(marketplaceService.fetchRegistry).toHaveBeenCalled();
    expect(result).toEqual({ version: 1, plugins: [] });
  });

  it('INSTALL_PLUGIN delegates to marketplaceService.installPlugin', async () => {
    const req = { pluginId: 'p1', version: '1.0', assetUrl: 'https://example.com/p1.zip', sha256: 'abc' };
    const handler = handlers.get(IPC.MARKETPLACE.INSTALL_PLUGIN)!;
    const result = await handler({}, req);
    expect(marketplaceService.installPlugin).toHaveBeenCalledWith(req);
    expect(result).toEqual({ success: true });
  });

  it('CHECK_PLUGIN_UPDATES delegates to pluginUpdateService', async () => {
    const handler = handlers.get(IPC.MARKETPLACE.CHECK_PLUGIN_UPDATES)!;
    const result = await handler({});
    expect(pluginUpdateService.checkForPluginUpdates).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('UPDATE_PLUGIN delegates to pluginUpdateService.updatePlugin', async () => {
    const req = { pluginId: 'p1' };
    const handler = handlers.get(IPC.MARKETPLACE.UPDATE_PLUGIN)!;
    const result = await handler({}, req);
    expect(pluginUpdateService.updatePlugin).toHaveBeenCalledWith('p1');
    expect(result).toEqual({ success: true });
  });
});
