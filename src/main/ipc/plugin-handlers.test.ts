import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../services/plugin-storage', () => ({
  readKey: vi.fn(async () => 'value'),
  writeKey: vi.fn(),
  deleteKey: vi.fn(),
  listKeys: vi.fn(async () => ['key1', 'key2']),
  readPluginFile: vi.fn(async () => 'file-content'),
  writePluginFile: vi.fn(),
  deletePluginFile: vi.fn(),
  pluginFileExists: vi.fn(async () => true),
  listPluginDir: vi.fn(async () => ['file1.json']),
  mkdirPlugin: vi.fn(),
}));

vi.mock('../services/plugin-discovery', () => ({
  discoverCommunityPlugins: vi.fn(async () => []),
  uninstallPlugin: vi.fn(),
}));

vi.mock('../services/gitignore-manager', () => ({
  addEntries: vi.fn(),
  removeEntries: vi.fn(),
  isIgnored: vi.fn(async () => false),
}));

vi.mock('../services/safe-mode', () => ({
  readMarker: vi.fn(async () => null),
  writeMarker: vi.fn(),
  clearMarker: vi.fn(),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerPluginHandlers } from './plugin-handlers';
import * as pluginStorage from '../services/plugin-storage';
import * as pluginDiscovery from '../services/plugin-discovery';
import * as gitignoreManager from '../services/gitignore-manager';
import * as safeMode from '../services/safe-mode';

describe('plugin-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerPluginHandlers();
  });

  it('registers all plugin IPC handlers', () => {
    const expectedChannels = [
      IPC.PLUGIN.DISCOVER_COMMUNITY,
      IPC.PLUGIN.STORAGE_READ, IPC.PLUGIN.STORAGE_WRITE,
      IPC.PLUGIN.STORAGE_DELETE, IPC.PLUGIN.STORAGE_LIST,
      IPC.PLUGIN.FILE_READ, IPC.PLUGIN.FILE_WRITE,
      IPC.PLUGIN.FILE_DELETE, IPC.PLUGIN.FILE_EXISTS, IPC.PLUGIN.FILE_LIST_DIR,
      IPC.PLUGIN.GITIGNORE_ADD, IPC.PLUGIN.GITIGNORE_REMOVE, IPC.PLUGIN.GITIGNORE_CHECK,
      IPC.PLUGIN.STARTUP_MARKER_READ, IPC.PLUGIN.STARTUP_MARKER_WRITE, IPC.PLUGIN.STARTUP_MARKER_CLEAR,
      IPC.PLUGIN.MKDIR, IPC.PLUGIN.UNINSTALL,
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('DISCOVER_COMMUNITY delegates to pluginDiscovery', async () => {
    const handler = handlers.get(IPC.PLUGIN.DISCOVER_COMMUNITY)!;
    await handler({});
    expect(pluginDiscovery.discoverCommunityPlugins).toHaveBeenCalled();
  });

  it('STORAGE_READ delegates to pluginStorage.readKey', async () => {
    const req = { pluginId: 'p1', scope: 'global', key: 'theme' };
    const handler = handlers.get(IPC.PLUGIN.STORAGE_READ)!;
    const result = await handler({}, req);
    expect(pluginStorage.readKey).toHaveBeenCalledWith(req);
    expect(result).toBe('value');
  });

  it('STORAGE_WRITE delegates to pluginStorage.writeKey', async () => {
    const req = { pluginId: 'p1', scope: 'global', key: 'theme', value: 'dark' };
    const handler = handlers.get(IPC.PLUGIN.STORAGE_WRITE)!;
    await handler({}, req);
    expect(pluginStorage.writeKey).toHaveBeenCalledWith(req);
  });

  it('STORAGE_DELETE delegates to pluginStorage.deleteKey', async () => {
    const req = { pluginId: 'p1', scope: 'global', key: 'theme' };
    const handler = handlers.get(IPC.PLUGIN.STORAGE_DELETE)!;
    await handler({}, req);
    expect(pluginStorage.deleteKey).toHaveBeenCalledWith(req);
  });

  it('STORAGE_LIST delegates to pluginStorage.listKeys', async () => {
    const req = { pluginId: 'p1', scope: 'global' };
    const handler = handlers.get(IPC.PLUGIN.STORAGE_LIST)!;
    const result = await handler({}, req);
    expect(pluginStorage.listKeys).toHaveBeenCalledWith(req);
    expect(result).toEqual(['key1', 'key2']);
  });

  it('FILE_READ delegates to pluginStorage.readPluginFile', async () => {
    const req = { pluginId: 'p1', scope: 'global', relativePath: 'data.json' };
    const handler = handlers.get(IPC.PLUGIN.FILE_READ)!;
    const result = await handler({}, req);
    expect(pluginStorage.readPluginFile).toHaveBeenCalledWith(req);
    expect(result).toBe('file-content');
  });

  it('FILE_WRITE delegates to pluginStorage.writePluginFile', async () => {
    const req = { pluginId: 'p1', scope: 'global', relativePath: 'data.json', content: '{}' };
    const handler = handlers.get(IPC.PLUGIN.FILE_WRITE)!;
    await handler({}, req);
    expect(pluginStorage.writePluginFile).toHaveBeenCalledWith(req);
  });

  it('FILE_DELETE delegates to pluginStorage.deletePluginFile', async () => {
    const req = { pluginId: 'p1', scope: 'global', relativePath: 'data.json' };
    const handler = handlers.get(IPC.PLUGIN.FILE_DELETE)!;
    await handler({}, req);
    expect(pluginStorage.deletePluginFile).toHaveBeenCalledWith(req);
  });

  it('FILE_EXISTS delegates to pluginStorage.pluginFileExists', async () => {
    const req = { pluginId: 'p1', scope: 'global', relativePath: 'data.json' };
    const handler = handlers.get(IPC.PLUGIN.FILE_EXISTS)!;
    const result = await handler({}, req);
    expect(pluginStorage.pluginFileExists).toHaveBeenCalledWith(req);
    expect(result).toBe(true);
  });

  it('FILE_LIST_DIR delegates to pluginStorage.listPluginDir', async () => {
    const req = { pluginId: 'p1', scope: 'global', relativePath: '.' };
    const handler = handlers.get(IPC.PLUGIN.FILE_LIST_DIR)!;
    const result = await handler({}, req);
    expect(pluginStorage.listPluginDir).toHaveBeenCalledWith(req);
    expect(result).toEqual(['file1.json']);
  });

  it('GITIGNORE_ADD delegates to gitignoreManager.addEntries', async () => {
    const handler = handlers.get(IPC.PLUGIN.GITIGNORE_ADD)!;
    await handler({}, '/project', 'p1', ['*.log']);
    expect(gitignoreManager.addEntries).toHaveBeenCalledWith('/project', 'p1', ['*.log']);
  });

  it('GITIGNORE_REMOVE delegates to gitignoreManager.removeEntries', async () => {
    const handler = handlers.get(IPC.PLUGIN.GITIGNORE_REMOVE)!;
    await handler({}, '/project', 'p1');
    expect(gitignoreManager.removeEntries).toHaveBeenCalledWith('/project', 'p1');
  });

  it('GITIGNORE_CHECK delegates to gitignoreManager.isIgnored', async () => {
    const handler = handlers.get(IPC.PLUGIN.GITIGNORE_CHECK)!;
    const result = await handler({}, '/project', '*.log');
    expect(gitignoreManager.isIgnored).toHaveBeenCalledWith('/project', '*.log');
    expect(result).toBe(false);
  });

  it('STARTUP_MARKER_READ delegates to safeMode.readMarker', async () => {
    const handler = handlers.get(IPC.PLUGIN.STARTUP_MARKER_READ)!;
    const result = await handler({});
    expect(safeMode.readMarker).toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('STARTUP_MARKER_WRITE delegates to safeMode.writeMarker', async () => {
    const handler = handlers.get(IPC.PLUGIN.STARTUP_MARKER_WRITE)!;
    await handler({}, ['plugin-a', 'plugin-b']);
    expect(safeMode.writeMarker).toHaveBeenCalledWith(['plugin-a', 'plugin-b']);
  });

  it('STARTUP_MARKER_CLEAR delegates to safeMode.clearMarker', async () => {
    const handler = handlers.get(IPC.PLUGIN.STARTUP_MARKER_CLEAR)!;
    await handler({});
    expect(safeMode.clearMarker).toHaveBeenCalled();
  });

  it('MKDIR delegates to pluginStorage.mkdirPlugin', async () => {
    const handler = handlers.get(IPC.PLUGIN.MKDIR)!;
    await handler({}, 'p1', 'project', 'data', '/project');
    expect(pluginStorage.mkdirPlugin).toHaveBeenCalledWith('p1', 'project', 'data', '/project');
  });

  it('UNINSTALL delegates to pluginDiscovery.uninstallPlugin', async () => {
    const handler = handlers.get(IPC.PLUGIN.UNINSTALL)!;
    await handler({}, 'p1');
    expect(pluginDiscovery.uninstallPlugin).toHaveBeenCalledWith('p1');
  });
});
