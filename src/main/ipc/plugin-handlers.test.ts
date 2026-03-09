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
  listProjectPluginInjections: vi.fn(() => ({
    skills: [],
    agentTemplates: [],
    hasInstructions: false,
    permissionAllowCount: 0,
    permissionDenyCount: 0,
    mcpServerNames: [],
  })),
  cleanupProjectPluginInjections: vi.fn(async () => {}),
  listOrphanedPluginIds: vi.fn(() => []),
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

vi.mock('../services/plugin-manifest-registry', () => ({
  initializeTrustedManifests: vi.fn(),
  refreshManifest: vi.fn(),
  unregisterManifest: vi.fn(),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerPluginHandlers } from './plugin-handlers';
import * as pluginStorage from '../services/plugin-storage';
import * as pluginDiscovery from '../services/plugin-discovery';
import * as gitignoreManager from '../services/gitignore-manager';
import * as safeMode from '../services/safe-mode';
import * as pluginManifestRegistry from '../services/plugin-manifest-registry';

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
    expect(pluginManifestRegistry.initializeTrustedManifests).toHaveBeenCalled();

    const expectedChannels = [
      IPC.PLUGIN.DISCOVER_COMMUNITY,
      IPC.PLUGIN.STORAGE_READ, IPC.PLUGIN.STORAGE_WRITE,
      IPC.PLUGIN.STORAGE_DELETE, IPC.PLUGIN.STORAGE_LIST,
      IPC.PLUGIN.FILE_READ, IPC.PLUGIN.FILE_WRITE,
      IPC.PLUGIN.FILE_DELETE, IPC.PLUGIN.FILE_EXISTS, IPC.PLUGIN.FILE_LIST_DIR,
      IPC.PLUGIN.GITIGNORE_ADD, IPC.PLUGIN.GITIGNORE_REMOVE, IPC.PLUGIN.GITIGNORE_CHECK,
      IPC.PLUGIN.STARTUP_MARKER_READ, IPC.PLUGIN.STARTUP_MARKER_WRITE, IPC.PLUGIN.STARTUP_MARKER_CLEAR,
      IPC.PLUGIN.MKDIR, IPC.PLUGIN.UNINSTALL,
      IPC.PLUGIN.REGISTER_MANIFEST,
      IPC.PLUGIN.LIST_PROJECT_INJECTIONS,
      IPC.PLUGIN.CLEANUP_PROJECT_INJECTIONS,
      IPC.PLUGIN.LIST_ORPHANED_PLUGIN_IDS,
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
    expect(pluginManifestRegistry.unregisterManifest).toHaveBeenCalledWith('p1');
  });

  it('REGISTER_MANIFEST reloads the trusted manifest by plugin id', async () => {
    const manifest = { id: 'p1', name: 'Test', version: '1.0.0', engine: { api: 0.5 }, scope: 'project' };
    const handler = handlers.get(IPC.PLUGIN.REGISTER_MANIFEST)!;
    await handler({}, 'p1', manifest);
    expect(pluginManifestRegistry.refreshManifest).toHaveBeenCalledWith('p1');
  });

  it('LIST_PROJECT_INJECTIONS delegates to pluginDiscovery.listProjectPluginInjections', async () => {
    const handler = handlers.get(IPC.PLUGIN.LIST_PROJECT_INJECTIONS)!;
    const result = await handler({}, 'my-plugin', '/project/path');
    expect(pluginDiscovery.listProjectPluginInjections).toHaveBeenCalledWith('my-plugin', '/project/path');
    expect(result).toMatchObject({ skills: [], hasInstructions: false });
  });

  it('CLEANUP_PROJECT_INJECTIONS delegates to pluginDiscovery.cleanupProjectPluginInjections', async () => {
    const handler = handlers.get(IPC.PLUGIN.CLEANUP_PROJECT_INJECTIONS)!;
    await handler({}, 'my-plugin', '/project/path');
    expect(pluginDiscovery.cleanupProjectPluginInjections).toHaveBeenCalledWith('my-plugin', '/project/path');
  });

  it('LIST_ORPHANED_PLUGIN_IDS delegates to pluginDiscovery.listOrphanedPluginIds', async () => {
    const handler = handlers.get(IPC.PLUGIN.LIST_ORPHANED_PLUGIN_IDS)!;
    const result = await handler({}, '/project/path', ['plugin-a']);
    expect(pluginDiscovery.listOrphanedPluginIds).toHaveBeenCalledWith('/project/path', ['plugin-a']);
    expect(result).toEqual([]);
  });

  it('rejects invalid mkdir arguments before delegating', async () => {
    const handler = handlers.get(IPC.PLUGIN.MKDIR)!;
    expect(() => handler({}, 'p1', 'project', 123, '/project')).toThrow('arg3 must be a string');
    expect(pluginStorage.mkdirPlugin).not.toHaveBeenCalled();
  });
});
