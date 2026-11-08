import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { removePluginTools } from '../services/clubhouse-mcp/plugin-tool-registry';
import { revokePluginTokens } from '../services/clubhouse-mcp/plugin-mcp-tokens';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { IPC } from '../../shared/ipc-channels';
import type {
  PluginFileRequest,
  PluginStorageDeleteRequest,
  PluginStorageListRequest,
  PluginStorageReadRequest,
  PluginStorageWriteRequest,
} from '../../shared/plugin-types';
import * as pluginStorage from '../services/plugin-storage';
import * as pluginDiscovery from '../services/plugin-discovery';
import * as gitignoreManager from '../services/gitignore-manager';
import * as safeMode from '../services/safe-mode';
import * as pluginManifestRegistry from '../services/plugin-manifest-registry';
import * as projectStore from '../services/project-store';
import { buildRetiredPluginExport, findRetiredPluginData, type RetiredPluginDataOptions } from '../services/retired-plugin-data';
import { isRetiredPlugin } from '../../shared/retired-plugins';
import { appLog } from '../services/log-service';
import { arrayArg, objectArg, optional, stringArg, withValidatedArgs } from './validation';

type PluginScope = 'project' | 'project-local' | 'global';

function retiredPluginArg(value: unknown, argName: string): string {
  const pluginId = stringArg()(value, argName);
  if (!isRetiredPlugin(pluginId)) throw new Error(`${argName} must be a retired plugin`);
  return pluginId;
}

async function retiredDataOptions(): Promise<RetiredPluginDataOptions> {
  return {
    globalPluginDataDir: pluginStorage.getGlobalPluginDataDir(),
    communityPluginsDir: pluginDiscovery.getCommunityPluginsDir(),
    projects: await projectStore.list(),
  };
}

function pluginScopeArg(value: unknown, argName: string): PluginScope {
  const scope = stringArg()(value, argName);
  if (scope !== 'project' && scope !== 'project-local' && scope !== 'global') {
    throw new Error(`${argName} must be one of: project, project-local, global`);
  }
  return scope;
}

export function registerPluginHandlers(): void {
  pluginManifestRegistry.initializeTrustedManifests();

  // ── Discovery ────────────────────────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.DISCOVER_COMMUNITY, async () => {
    return pluginDiscovery.discoverCommunityPlugins();
  });

  // ── KV Storage ───────────────────────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.STORAGE_READ, withValidatedArgs([objectArg<PluginStorageReadRequest>({
    validate: (req, argName) => {
      stringArg()(req.pluginId, `${argName}.pluginId`);
      pluginScopeArg(req.scope, `${argName}.scope`);
      stringArg()(req.key, `${argName}.key`);
      optional(stringArg())(req.projectPath, `${argName}.projectPath`);
    },
  })], async (_event, req) => {
    return pluginStorage.readKey(req);
  }));

  ipcMain.handle(IPC.PLUGIN.STORAGE_WRITE, withValidatedArgs([objectArg<PluginStorageWriteRequest>({
    validate: (req, argName) => {
      stringArg()(req.pluginId, `${argName}.pluginId`);
      pluginScopeArg(req.scope, `${argName}.scope`);
      stringArg()(req.key, `${argName}.key`);
      optional(stringArg())(req.projectPath, `${argName}.projectPath`);
    },
  })], async (_event, req) => {
    await pluginStorage.writeKey(req);
  }));

  ipcMain.handle(IPC.PLUGIN.STORAGE_DELETE, withValidatedArgs([objectArg<PluginStorageDeleteRequest>({
    validate: (req, argName) => {
      stringArg()(req.pluginId, `${argName}.pluginId`);
      pluginScopeArg(req.scope, `${argName}.scope`);
      stringArg()(req.key, `${argName}.key`);
      optional(stringArg())(req.projectPath, `${argName}.projectPath`);
    },
  })], async (_event, req) => {
    await pluginStorage.deleteKey(req);
  }));

  ipcMain.handle(IPC.PLUGIN.STORAGE_LIST, withValidatedArgs([objectArg<PluginStorageListRequest>({
    validate: (req, argName) => {
      stringArg()(req.pluginId, `${argName}.pluginId`);
      pluginScopeArg(req.scope, `${argName}.scope`);
      optional(stringArg())(req.projectPath, `${argName}.projectPath`);
    },
  })], async (_event, req) => {
    return pluginStorage.listKeys(req);
  }));

  // ── File Storage ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.FILE_READ, withValidatedArgs([objectArg<PluginFileRequest>({
    validate: (req, argName) => {
      stringArg()(req.pluginId, `${argName}.pluginId`);
      pluginScopeArg(req.scope, `${argName}.scope`);
      stringArg()(req.relativePath, `${argName}.relativePath`);
      optional(stringArg())(req.projectPath, `${argName}.projectPath`);
    },
  })], async (_event, req) => {
    return pluginStorage.readPluginFile(req);
  }));

  ipcMain.handle(IPC.PLUGIN.FILE_WRITE, withValidatedArgs([objectArg<PluginFileRequest & { content: string }>({
    validate: (req, argName) => {
      stringArg()(req.pluginId, `${argName}.pluginId`);
      pluginScopeArg(req.scope, `${argName}.scope`);
      stringArg()(req.relativePath, `${argName}.relativePath`);
      stringArg({ minLength: 0 })(req.content, `${argName}.content`);
      optional(stringArg())(req.projectPath, `${argName}.projectPath`);
    },
  })], async (_event, req) => {
    await pluginStorage.writePluginFile(req);
  }));

  ipcMain.handle(IPC.PLUGIN.FILE_DELETE, withValidatedArgs([objectArg<PluginFileRequest>({
    validate: (req, argName) => {
      stringArg()(req.pluginId, `${argName}.pluginId`);
      pluginScopeArg(req.scope, `${argName}.scope`);
      stringArg()(req.relativePath, `${argName}.relativePath`);
      optional(stringArg())(req.projectPath, `${argName}.projectPath`);
    },
  })], async (_event, req) => {
    await pluginStorage.deletePluginFile(req);
  }));

  ipcMain.handle(IPC.PLUGIN.FILE_EXISTS, withValidatedArgs([objectArg<PluginFileRequest>({
    validate: (req, argName) => {
      stringArg()(req.pluginId, `${argName}.pluginId`);
      pluginScopeArg(req.scope, `${argName}.scope`);
      stringArg()(req.relativePath, `${argName}.relativePath`);
      optional(stringArg())(req.projectPath, `${argName}.projectPath`);
    },
  })], async (_event, req) => {
    return pluginStorage.pluginFileExists(req);
  }));

  ipcMain.handle(IPC.PLUGIN.FILE_LIST_DIR, withValidatedArgs([objectArg<PluginFileRequest>({
    validate: (req, argName) => {
      stringArg()(req.pluginId, `${argName}.pluginId`);
      pluginScopeArg(req.scope, `${argName}.scope`);
      stringArg()(req.relativePath, `${argName}.relativePath`);
      optional(stringArg())(req.projectPath, `${argName}.projectPath`);
    },
  })], async (_event, req) => {
    return pluginStorage.listPluginDir(req);
  }));

  // ── Gitignore ────────────────────────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.GITIGNORE_ADD, withValidatedArgs([stringArg(), stringArg(), arrayArg(stringArg())], async (_event, projectPath: string, pluginId: string, patterns: string[]) => {
    return gitignoreManager.addEntries(projectPath, pluginId, patterns);
  }));

  ipcMain.handle(IPC.PLUGIN.GITIGNORE_REMOVE, withValidatedArgs([stringArg(), stringArg()], async (_event, projectPath: string, pluginId: string) => {
    return gitignoreManager.removeEntries(projectPath, pluginId);
  }));

  ipcMain.handle(IPC.PLUGIN.GITIGNORE_CHECK, withValidatedArgs([stringArg(), stringArg()], async (_event, projectPath: string, pattern: string) => {
    return gitignoreManager.isIgnored(projectPath, pattern);
  }));

  // ── Safe Mode / Startup Marker ───────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.STARTUP_MARKER_READ, () => {
    return safeMode.readMarker();
  });

  ipcMain.handle(IPC.PLUGIN.STARTUP_MARKER_WRITE, withValidatedArgs([arrayArg(stringArg())], (_event, enabledPlugins: string[]) => {
    safeMode.writeMarker(enabledPlugins);
  }));

  ipcMain.handle(IPC.PLUGIN.STARTUP_MARKER_CLEAR, () => {
    safeMode.clearMarker();
  });

  ipcMain.handle(IPC.PLUGIN.SAFE_MODE_ACTIVE, () => {
    return safeMode.isSafeModeActive();
  });

  // ── Misc ─────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.MKDIR, withValidatedArgs([stringArg(), stringArg(), stringArg(), stringArg({ optional: true })], async (_event, pluginId: string, scope: string, relativePath: string, projectPath?: string) => {
    await pluginStorage.mkdirPlugin(pluginId, scope as 'project' | 'global', relativePath, projectPath);
  }));

  ipcMain.handle(IPC.PLUGIN.UNINSTALL, withValidatedArgs([stringArg()], async (_event, pluginId: string) => {
    // First, so a failed uninstall can't leave the plugin's MCP tools listed
    // for agents with no handler left to answer them.
    revokePluginTokens(pluginId);
    removePluginTools(pluginId);
    await pluginDiscovery.uninstallPlugin(pluginId);
    pluginManifestRegistry.unregisterManifest(pluginId);
  }));

  // ── Retired Workshop plugins (#2756): find, export and show their data; never delete it ──
  ipcMain.handle(IPC.PLUGIN.RETIRED_DATA_FIND, withValidatedArgs([retiredPluginArg], async (_event, pluginId: string) => {
    return findRetiredPluginData(pluginId, await retiredDataOptions());
  }));

  ipcMain.handle(IPC.PLUGIN.RETIRED_DATA_EXPORT, withValidatedArgs([retiredPluginArg], async (event, pluginId: string): Promise<{
    canceled: boolean;
    filePath?: string;
    error?: string;
  }> => {
    // The dialog belongs to the window that asked.
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { canceled: true };
    const picked = await dialog.showSaveDialog(win, {
      title: 'Export plugin data',
      defaultPath: `${pluginId}-data.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    try {
      const data = await buildRetiredPluginExport(pluginId, await retiredDataOptions());
      await fsp.writeFile(picked.filePath, JSON.stringify(data, null, 2), 'utf-8');
      appLog('core:plugins', 'info', 'Exported data for a retired plugin', { meta: { pluginId, locations: data.locations.length } });
      return { canceled: false, filePath: picked.filePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appLog('core:plugins', 'error', 'Failed to export data for a retired plugin', { meta: { pluginId, error: message } });
      return { canceled: false, filePath: picked.filePath, error: message };
    }
  }));

  ipcMain.handle(IPC.PLUGIN.RETIRED_DATA_REVEAL, withValidatedArgs([retiredPluginArg], async (_event, pluginId: string) => {
    const { locations } = await findRetiredPluginData(pluginId, await retiredDataOptions());
    if (locations[0]) shell.showItemInFolder(locations[0].dir);
  }));

  ipcMain.handle(IPC.PLUGIN.LIST_PROJECT_INJECTIONS, withValidatedArgs([stringArg(), stringArg()], async (_event, pluginId: string, projectPath: string) => {
    return pluginDiscovery.listProjectPluginInjections(pluginId, projectPath);
  }));

  ipcMain.handle(IPC.PLUGIN.CLEANUP_PROJECT_INJECTIONS, withValidatedArgs([stringArg(), stringArg()], async (_event, pluginId: string, projectPath: string) => {
    await pluginDiscovery.cleanupProjectPluginInjections(pluginId, projectPath);
  }));

  ipcMain.handle(IPC.PLUGIN.LIST_ORPHANED_PLUGIN_IDS, withValidatedArgs([stringArg(), arrayArg(stringArg())], async (_event, projectPath: string, knownPluginIds: string[]) => {
    return pluginDiscovery.listOrphanedPluginIds(projectPath, knownPluginIds);
  }));

  // ── Module source loader (dev mode) ──────────────────────────────────
  // In dev mode the renderer can't import() file:// URLs cross-origin.
  // This handler reads plugin source files so the renderer can import via blob URL.
  ipcMain.handle(IPC.PLUGIN.LOAD_MODULE_SOURCE, withValidatedArgs([stringArg()], async (_event, filePath: string) => {
    const pluginsDir = path.join(app.getPath('home'), '.clubhouse', 'plugins');
    const resolved = path.resolve(filePath);
    // Follow symlinks before checking — prevents symlink escape from plugins dir
    const realPath = await fsp.realpath(resolved);
    if (!realPath.startsWith(pluginsDir)) {
      throw new Error(`Access denied: path "${filePath}" is outside the plugins directory`);
    }
    return fsp.readFile(realPath, 'utf-8');
  }));

  // ── Manifest Registry ─────────────────────────────────────────────────
  // Re-read a plugin's manifest from disk and register it as trusted.
  // The main process is the sole authority for plugin security policy —
  // no manifest payload is accepted from the renderer.
  ipcMain.handle(IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK, withValidatedArgs([stringArg()], async (_event, pluginId: string) => {
    return pluginDiscovery.refreshManifestFromDisk(pluginId);
  }));
}
