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

vi.mock('../services/custom-marketplace-service', () => ({
  listCustomMarketplaces: vi.fn(() => []),
  addCustomMarketplace: vi.fn((req: any) => ({ id: 'cm-1', name: req.name, url: req.url, enabled: true })),
  removeCustomMarketplace: vi.fn(),
  toggleCustomMarketplace: vi.fn((req: any) => ({ id: req.id, name: 'Test', url: 'https://test.com', enabled: req.enabled })),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerMarketplaceHandlers } from './marketplace-handlers';
import * as marketplaceService from '../services/marketplace-service';
import * as pluginUpdateService from '../services/plugin-update-service';
import * as customMarketplaceService from '../services/custom-marketplace-service';

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
    expect(handlers.has(IPC.MARKETPLACE.LIST_CUSTOM)).toBe(true);
    expect(handlers.has(IPC.MARKETPLACE.ADD_CUSTOM)).toBe(true);
    expect(handlers.has(IPC.MARKETPLACE.REMOVE_CUSTOM)).toBe(true);
    expect(handlers.has(IPC.MARKETPLACE.TOGGLE_CUSTOM)).toBe(true);
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

  // Custom marketplace handler tests

  it('LIST_CUSTOM delegates to customMarketplaceService.listCustomMarketplaces', async () => {
    const handler = handlers.get(IPC.MARKETPLACE.LIST_CUSTOM)!;
    const result = await handler({});
    expect(customMarketplaceService.listCustomMarketplaces).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('ADD_CUSTOM delegates to customMarketplaceService.addCustomMarketplace', async () => {
    const req = { name: 'My Store', url: 'https://store.example.com/registry.json' };
    const handler = handlers.get(IPC.MARKETPLACE.ADD_CUSTOM)!;
    const result = await handler({}, req);
    expect(customMarketplaceService.addCustomMarketplace).toHaveBeenCalledWith(req);
    expect(result.name).toBe('My Store');
    expect(result.enabled).toBe(true);
  });

  it('REMOVE_CUSTOM delegates to customMarketplaceService.removeCustomMarketplace', async () => {
    const req = { id: 'cm-1' };
    const handler = handlers.get(IPC.MARKETPLACE.REMOVE_CUSTOM)!;
    await handler({}, req);
    expect(customMarketplaceService.removeCustomMarketplace).toHaveBeenCalledWith(req);
  });

  it('TOGGLE_CUSTOM delegates to customMarketplaceService.toggleCustomMarketplace', async () => {
    const req = { id: 'cm-1', enabled: false };
    const handler = handlers.get(IPC.MARKETPLACE.TOGGLE_CUSTOM)!;
    const result = await handler({}, req);
    expect(customMarketplaceService.toggleCustomMarketplace).toHaveBeenCalledWith(req);
    expect(result.enabled).toBe(false);
  });
});
