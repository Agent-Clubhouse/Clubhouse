import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as pluginStorage from '../services/plugin-storage';
import * as pluginDiscovery from '../services/plugin-discovery';
import * as gitignoreManager from '../services/gitignore-manager';
import * as safeMode from '../services/safe-mode';

export function registerPluginHandlers(): void {
  // ── Discovery ────────────────────────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.DISCOVER_COMMUNITY, () => {
    return pluginDiscovery.discoverCommunityPlugins();
  });

  // ── KV Storage ───────────────────────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.STORAGE_READ, async (_event, req) => {
    return pluginStorage.readKey(req);
  });

  ipcMain.handle(IPC.PLUGIN.STORAGE_WRITE, async (_event, req) => {
    await pluginStorage.writeKey(req);
  });

  ipcMain.handle(IPC.PLUGIN.STORAGE_DELETE, async (_event, req) => {
    await pluginStorage.deleteKey(req);
  });

  ipcMain.handle(IPC.PLUGIN.STORAGE_LIST, async (_event, req) => {
    return pluginStorage.listKeys(req);
  });

  // ── File Storage ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.FILE_READ, async (_event, req) => {
    return pluginStorage.readPluginFile(req);
  });

  ipcMain.handle(IPC.PLUGIN.FILE_WRITE, async (_event, req) => {
    await pluginStorage.writePluginFile(req);
  });

  ipcMain.handle(IPC.PLUGIN.FILE_DELETE, async (_event, req) => {
    await pluginStorage.deletePluginFile(req);
  });

  ipcMain.handle(IPC.PLUGIN.FILE_EXISTS, async (_event, req) => {
    return pluginStorage.pluginFileExists(req);
  });

  ipcMain.handle(IPC.PLUGIN.FILE_LIST_DIR, async (_event, req) => {
    return pluginStorage.listPluginDir(req);
  });

  // ── Gitignore ────────────────────────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.GITIGNORE_ADD, (_event, projectPath: string, pluginId: string, patterns: string[]) => {
    gitignoreManager.addEntries(projectPath, pluginId, patterns);
  });

  ipcMain.handle(IPC.PLUGIN.GITIGNORE_REMOVE, (_event, projectPath: string, pluginId: string) => {
    gitignoreManager.removeEntries(projectPath, pluginId);
  });

  ipcMain.handle(IPC.PLUGIN.GITIGNORE_CHECK, (_event, projectPath: string, pattern: string) => {
    return gitignoreManager.isIgnored(projectPath, pattern);
  });

  // ── Safe Mode / Startup Marker ───────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.STARTUP_MARKER_READ, () => {
    return safeMode.readMarker();
  });

  ipcMain.handle(IPC.PLUGIN.STARTUP_MARKER_WRITE, (_event, enabledPlugins: string[]) => {
    safeMode.writeMarker(enabledPlugins);
  });

  ipcMain.handle(IPC.PLUGIN.STARTUP_MARKER_CLEAR, () => {
    safeMode.clearMarker();
  });

  // ── Misc ─────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.PLUGIN.MKDIR, async (_event, pluginId: string, scope: string, relativePath: string, projectPath?: string) => {
    await pluginStorage.mkdirPlugin(pluginId, scope as 'project' | 'global', relativePath, projectPath);
  });

  ipcMain.handle(IPC.PLUGIN.UNINSTALL, async (_event, pluginId: string) => {
    await pluginDiscovery.uninstallPlugin(pluginId);
  });
}
