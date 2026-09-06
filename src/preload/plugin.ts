import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const plugin = {
  plugin: {
  discoverCommunity: () =>
    ipcRenderer.invoke(IPC.PLUGIN.DISCOVER_COMMUNITY),
  loadModuleSource: (filePath: string) =>
    ipcRenderer.invoke(IPC.PLUGIN.LOAD_MODULE_SOURCE, filePath) as Promise<string>,
  storageRead: (req: { pluginId: string; scope: string; key: string; projectPath?: string }) =>
    ipcRenderer.invoke(IPC.PLUGIN.STORAGE_READ, req),
  storageWrite: (req: { pluginId: string; scope: string; key: string; value: unknown; projectPath?: string }) =>
    ipcRenderer.invoke(IPC.PLUGIN.STORAGE_WRITE, req),
  storageDelete: (req: { pluginId: string; scope: string; key: string; projectPath?: string }) =>
    ipcRenderer.invoke(IPC.PLUGIN.STORAGE_DELETE, req),
  storageList: (req: { pluginId: string; scope: string; projectPath?: string }) =>
    ipcRenderer.invoke(IPC.PLUGIN.STORAGE_LIST, req),
  fileRead: (req: { pluginId: string; scope: string; relativePath: string; projectPath?: string }) =>
    ipcRenderer.invoke(IPC.PLUGIN.FILE_READ, req),
  fileWrite: (req: { pluginId: string; scope: string; relativePath: string; content: string; projectPath?: string }) =>
    ipcRenderer.invoke(IPC.PLUGIN.FILE_WRITE, req),
  fileDelete: (req: { pluginId: string; scope: string; relativePath: string; projectPath?: string }) =>
    ipcRenderer.invoke(IPC.PLUGIN.FILE_DELETE, req),
  fileExists: (req: { pluginId: string; scope: string; relativePath: string; projectPath?: string }) =>
    ipcRenderer.invoke(IPC.PLUGIN.FILE_EXISTS, req),
  fileListDir: (req: { pluginId: string; scope: string; relativePath: string; projectPath?: string }) =>
    ipcRenderer.invoke(IPC.PLUGIN.FILE_LIST_DIR, req),
  gitignoreAdd: (projectPath: string, pluginId: string, patterns: string[]) =>
    ipcRenderer.invoke(IPC.PLUGIN.GITIGNORE_ADD, projectPath, pluginId, patterns),
  gitignoreRemove: (projectPath: string, pluginId: string) =>
    ipcRenderer.invoke(IPC.PLUGIN.GITIGNORE_REMOVE, projectPath, pluginId),
  gitignoreCheck: (projectPath: string, pattern: string) =>
    ipcRenderer.invoke(IPC.PLUGIN.GITIGNORE_CHECK, projectPath, pattern),
  startupMarkerRead: () =>
    ipcRenderer.invoke(IPC.PLUGIN.STARTUP_MARKER_READ),
  startupMarkerWrite: (enabledPlugins: string[]) =>
    ipcRenderer.invoke(IPC.PLUGIN.STARTUP_MARKER_WRITE, enabledPlugins),
  startupMarkerClear: () =>
    ipcRenderer.invoke(IPC.PLUGIN.STARTUP_MARKER_CLEAR),
  mkdir: (pluginId: string, scope: string, relativePath: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.PLUGIN.MKDIR, pluginId, scope, relativePath, projectPath),
  uninstall: (pluginId: string) =>
    ipcRenderer.invoke(IPC.PLUGIN.UNINSTALL, pluginId),
  listProjectInjections: (pluginId: string, projectPath: string): Promise<{
    skills: string[];
    agentTemplates: string[];
    hasInstructions: boolean;
    permissionAllowCount: number;
    permissionDenyCount: number;
    mcpServerNames: string[];
  }> =>
    ipcRenderer.invoke(IPC.PLUGIN.LIST_PROJECT_INJECTIONS, pluginId, projectPath),
  cleanupProjectInjections: (pluginId: string, projectPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PLUGIN.CLEANUP_PROJECT_INJECTIONS, pluginId, projectPath),
  listOrphanedPluginIds: (projectPath: string, knownPluginIds: string[]): Promise<string[]> =>
    ipcRenderer.invoke(IPC.PLUGIN.LIST_ORPHANED_PLUGIN_IDS, projectPath, knownPluginIds),
  refreshManifestFromDisk: (pluginId: string) =>
    ipcRenderer.invoke(IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK, pluginId),
  },
};
