import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../services/clubhouse-mcp/plugin-tool-registry', () => ({
  removePluginTools: vi.fn(),
}));
vi.mock('../services/clubhouse-mcp/plugin-mcp-tokens', () => ({
  revokePluginTokens: vi.fn(),
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
  refreshManifestFromDisk: vi.fn(async () => null),
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
  isSafeModeActive: vi.fn(() => false),
}));

vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));

vi.mock('../services/plugin-manifest-registry', () => ({
  initializeTrustedManifests: vi.fn(),
  unregisterManifest: vi.fn(),
  getManifest: vi.fn(),
}));

import { removePluginTools } from '../services/clubhouse-mcp/plugin-tool-registry';
import { revokePluginTokens } from '../services/clubhouse-mcp/plugin-mcp-tokens';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerPluginHandlers } from './plugin-handlers';
import * as pluginStorage from '../services/plugin-storage';
import * as pluginDiscovery from '../services/plugin-discovery';
import * as gitignoreManager from '../services/gitignore-manager';
import * as safeMode from '../services/safe-mode';
import * as pluginManifestRegistry from '../services/plugin-manifest-registry';
import { appLog } from '../services/log-service';
import type { PluginManifest } from '../../shared/plugin-types';

describe('plugin-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pluginManifestRegistry.getManifest).mockReturnValue({
      id: 'p1', permissions: ['storage', 'files'],
    } as PluginManifest);
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
      IPC.PLUGIN.SAFE_MODE_ACTIVE,
      IPC.PLUGIN.MKDIR, IPC.PLUGIN.UNINSTALL,
      IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK,
      IPC.PLUGIN.LIST_PROJECT_INJECTIONS,
      IPC.PLUGIN.CLEANUP_PROJECT_INJECTIONS,
      IPC.PLUGIN.LIST_ORPHANED_PLUGIN_IDS,
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('waits for trusted manifest discovery before authorizing startup data calls', async () => {
    let ready!: () => void;
    vi.mocked(pluginManifestRegistry.initializeTrustedManifests).mockReturnValue(new Promise<void>((resolve) => { ready = resolve; }));
    registerPluginHandlers();
    const pending = handlers.get(IPC.PLUGIN.STORAGE_READ)!({}, { pluginId: 'p1', scope: 'global', key: 'theme' });
    expect(pluginStorage.readKey).not.toHaveBeenCalled();
    ready();
    await expect(pending).resolves.toBe('value');
  });

  const dataOperations = [
    [IPC.PLUGIN.STORAGE_READ, 'readKey', 'storage'],
    [IPC.PLUGIN.STORAGE_WRITE, 'writeKey', 'storage'],
    [IPC.PLUGIN.STORAGE_DELETE, 'deleteKey', 'storage'],
    [IPC.PLUGIN.STORAGE_LIST, 'listKeys', 'storage'],
    [IPC.PLUGIN.FILE_READ, 'readPluginFile', 'files'],
    [IPC.PLUGIN.FILE_WRITE, 'writePluginFile', 'files'],
    [IPC.PLUGIN.FILE_DELETE, 'deletePluginFile', 'files'],
    [IPC.PLUGIN.FILE_EXISTS, 'pluginFileExists', 'files'],
    [IPC.PLUGIN.FILE_LIST_DIR, 'listPluginDir', 'files'],
    [IPC.PLUGIN.MKDIR, 'mkdirPlugin', 'files'],
  ] as const;

  function invokeData(channel: string, pluginId: string) {
    const handler = handlers.get(channel)!;
    return channel === IPC.PLUGIN.MKDIR
      ? handler({}, pluginId, 'global', 'private/path')
      : handler({}, { pluginId, scope: 'global', key: 'secret-key', value: 'secret-value', relativePath: 'private/path', content: 'secret-content' });
  }

  describe.each(dataOperations)('%s access checks', (channel, method, permission) => {
    it.each(['unknown', 'excluded-by-safe-mode-or-external-support-off'])('refuses %s IDs absent from the main registry', async (pluginId) => {
      vi.mocked(pluginManifestRegistry.getManifest).mockReturnValue(undefined);
      await expect(invokeData(channel, pluginId)).rejects.toThrow('Plugin data access refused');
      expect(pluginStorage[method]).not.toHaveBeenCalled();
      expect(appLog).toHaveBeenCalledWith('core:plugins', 'warn', 'Plugin data access refused', {
        meta: expect.objectContaining({ permission, reason: 'unregistered or disabled' }),
      });
      const logged = JSON.stringify(vi.mocked(appLog).mock.calls);
      for (const privateValue of [pluginId, 'secret-key', 'secret-value', 'private/path', 'secret-content']) {
        expect(logged).not.toContain(privateValue);
      }
    });

    it('refuses a built-in disabled by the real main registry in safe mode', async () => {
      const registry = await vi.importActual<typeof pluginManifestRegistry>('../services/plugin-manifest-registry');
      const previous = process.env.CLUBHOUSE_SAFE_MODE;
      process.env.CLUBHOUSE_SAFE_MODE = '1';
      try {
        await registry.initializeTrustedManifests();
        vi.mocked(pluginManifestRegistry.getManifest).mockImplementation(registry.getManifest);
        await expect(invokeData(channel, 'files')).rejects.toThrow('Plugin data access refused');
        expect(pluginStorage[method]).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env.CLUBHOUSE_SAFE_MODE;
        else process.env.CLUBHOUSE_SAFE_MODE = previous;
        registry.clear();
      }
    });

    it('refuses a registered plugin without the required permission', async () => {
      vi.mocked(pluginManifestRegistry.getManifest).mockReturnValue({
        id: 'p1', permissions: [permission === 'files' ? 'storage' : 'files'],
      } as PluginManifest);
      await expect(invokeData(channel, 'p1')).rejects.toThrow('Plugin data access refused');
      expect(pluginStorage[method]).not.toHaveBeenCalled();
      expect(appLog).toHaveBeenCalledWith('core:plugins', 'warn', 'Plugin data access refused', {
        meta: expect.objectContaining({ permission, reason: 'permission denied' }),
      });
    });

    it.each([0.7, 0.8, 0.9])('allows a registered, permitted plugin on API %s', async (api) => {
      vi.mocked(pluginManifestRegistry.getManifest).mockReturnValue({
        id: 'p1', engine: { api }, permissions: [permission],
      } as PluginManifest);
      await invokeData(channel, 'p1');
      expect(pluginStorage[method]).toHaveBeenCalledOnce();
      expect(appLog).not.toHaveBeenCalled();
    });

    it('KNOWN LIMITATION #2080: direct shared-bridge calls can forge another registered, permitted plugin ID', async () => {
      // IPC carries no authenticated plugin caller. A can send B's ID; the
      // registry/permission checks authorize B. This test documents the gap.
      vi.mocked(pluginManifestRegistry.getManifest).mockImplementation((pluginId) => pluginId === 'victim'
        ? { id: 'victim', permissions: [permission] } as PluginManifest : undefined);
      await invokeData(channel, 'victim');
      expect(pluginStorage[method]).toHaveBeenCalledOnce();
    });

    it('keeps real storage path traversal checks after authorization', async () => {
      const actual = await vi.importActual<typeof pluginStorage>('../services/plugin-storage');
      vi.mocked(pluginStorage[method]).mockImplementation(actual[method] as typeof pluginStorage[typeof method]);
      const handler = handlers.get(channel)!;
      const result = channel === IPC.PLUGIN.MKDIR
        ? handler({}, 'p1', 'project', '../../../../../escape', '/project')
        : handler({}, {
          pluginId: 'p1', scope: 'project', projectPath: '/project',
          key: '../../../../../escape', relativePath: '../../../../../escape', content: 'x', value: 'x',
        });
      // STORAGE_LIST has no caller-provided subpath; its plugin ID is checked instead.
      if (channel === IPC.PLUGIN.STORAGE_LIST) {
        await result;
        await expect(handler({}, { pluginId: '../escape', scope: 'project', projectPath: '/project' })).rejects.toThrow('Invalid plugin ID');
      } else {
        await expect(result).rejects.toThrow('Path traversal');
      }
    });
  });

  it.each(['external-plugins-enabled', 'app-enabled', 'project-enabled-project-1', 'settings-app-p1'])('preserves host bootstrap/config KV reads and writes for %s', async (key) => {
    vi.mocked(pluginManifestRegistry.getManifest).mockReturnValue(undefined);
    const req = { pluginId: '_system', scope: 'global', key, value: [] };
    await handlers.get(IPC.PLUGIN.STORAGE_READ)!({}, req);
    await handlers.get(IPC.PLUGIN.STORAGE_WRITE)!({}, req);
    expect(pluginStorage.readKey).toHaveBeenCalledWith(req);
    expect(pluginStorage.writeKey).toHaveBeenCalledWith(req);
  });

  it.each(dataOperations)('does not exempt arbitrary host namespace requests on %s', async (channel, method) => {
    vi.mocked(pluginManifestRegistry.getManifest).mockReturnValue(undefined);
    await expect(invokeData(channel, '_system')).rejects.toThrow('Plugin data access refused');
    expect(pluginStorage[method]).not.toHaveBeenCalled();
  });

  it('keeps agent-config bookkeeping at its existing path with its owning manifest permission', async () => {
    vi.mocked(pluginManifestRegistry.getManifest).mockImplementation((id) => id === 'p1'
      ? { id, permissions: ['agent-config'] } as PluginManifest : undefined);
    const req = { pluginId: '_agentconfig:p1', scope: 'project', projectPath: '/project', key: 'injected-skills', value: [] };
    for (const channel of [IPC.PLUGIN.STORAGE_READ, IPC.PLUGIN.STORAGE_WRITE, IPC.PLUGIN.STORAGE_DELETE, IPC.PLUGIN.STORAGE_LIST]) {
      await handlers.get(channel)!({}, req);
    }
    expect(pluginStorage.writeKey).toHaveBeenCalledWith(req);
    await expect(handlers.get(IPC.PLUGIN.STORAGE_READ)!({}, { ...req, pluginId: '_agentconfig:unknown' })).rejects.toThrow('Plugin data access refused');
    vi.mocked(pluginManifestRegistry.getManifest).mockReturnValue({ id: 'p1', permissions: ['storage'] } as PluginManifest);
    await expect(handlers.get(IPC.PLUGIN.STORAGE_READ)!({}, req)).rejects.toThrow('Plugin data access refused');
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

  it('SAFE_MODE_ACTIVE returns the main-process safe-mode decision', async () => {
    const handler = handlers.get(IPC.PLUGIN.SAFE_MODE_ACTIVE)!;
    vi.mocked(safeMode.isSafeModeActive).mockReturnValue(true);
    expect(await handler({})).toBe(true);
    vi.mocked(safeMode.isSafeModeActive).mockReturnValue(false);
    expect(await handler({})).toBe(false);
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
    // Its MCP tools go too, or agents keep calling a tool nobody answers,
    // and so do its MCP tokens.
    expect(removePluginTools).toHaveBeenCalledWith('p1');
    expect(revokePluginTokens).toHaveBeenCalledWith('p1');
  });

  it('REFRESH_MANIFEST_FROM_DISK delegates to pluginDiscovery.refreshManifestFromDisk', async () => {
    const handler = handlers.get(IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK)!;
    await handler({}, 'p1');
    expect(pluginDiscovery.refreshManifestFromDisk).toHaveBeenCalledWith('p1');
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
