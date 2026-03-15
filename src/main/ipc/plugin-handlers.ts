import { app, ipcMain } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { IPC } from '../../shared/ipc-channels';
import type {
  PluginFileRequest,
  PluginManifest,
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
import { arrayArg, objectArg, optional, stringArg, withValidatedArgs } from './validation';

type PluginScope = 'project' | 'project-local' | 'global';

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

  // ── Misc ─────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.MKDIR, withValidatedArgs([stringArg(), stringArg(), stringArg(), stringArg({ optional: true })], async (_event, pluginId: string, scope: string, relativePath: string, projectPath?: string) => {
    await pluginStorage.mkdirPlugin(pluginId, scope as 'project' | 'global', relativePath, projectPath);
  }));

  ipcMain.handle(IPC.PLUGIN.UNINSTALL, withValidatedArgs([stringArg()], async (_event, pluginId: string) => {
    await pluginDiscovery.uninstallPlugin(pluginId);
    pluginManifestRegistry.unregisterManifest(pluginId);
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
    if (!resolved.startsWith(pluginsDir)) {
      throw new Error(`Access denied: path "${filePath}" is outside the plugins directory`);
    }
    return fsp.readFile(resolved, 'utf-8');
  }));

  // ── Manifest Registry ─────────────────────────────────────────────────
  // NOTE: REGISTER_MANIFEST from the renderer triggers a trusted disk re-read
  // rather than accepting the renderer-supplied manifest payload, preventing
  // self-escalation attacks (e.g., injecting allowedCommands).
  ipcMain.handle(IPC.PLUGIN.REGISTER_MANIFEST, withValidatedArgs([stringArg(), objectArg<PluginManifest>()], (_event, pluginId: string, _manifest: PluginManifest) => {
    pluginManifestRegistry.refreshManifest(pluginId);
  }));

  // Re-read a plugin's manifest from disk and register it as trusted.
  // Used during hot-reload so the renderer doesn't need to send the manifest.
  ipcMain.handle(IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK, withValidatedArgs([stringArg()], async (_event, pluginId: string) => {
    return pluginDiscovery.refreshManifestFromDisk(pluginId);
  }));
}
