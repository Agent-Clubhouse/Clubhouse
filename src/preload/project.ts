import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { LaunchWrapperConfig, McpCatalogEntry, WrapperCatalogSnapshot } from '../shared/types';
import { typedInvoke } from '../shared/ipc-types';
import type { ProjectState, ProjectStateChange, ProjectStateOp } from '../shared/project-state';

export const project = {
  project: {
  list: () => ipcRenderer.invoke(IPC.PROJECT.LIST),
  add: (path: string) => ipcRenderer.invoke(IPC.PROJECT.ADD, path),
  remove: (id: string) => ipcRenderer.invoke(IPC.PROJECT.REMOVE, id),
  pickDirectory: () =>
    typedInvoke(
      (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      IPC.PROJECT.PICK_DIR,
    ),
  checkGit: (dirPath: string) => ipcRenderer.invoke(IPC.PROJECT.CHECK_GIT, dirPath),
  gitInit: (dirPath: string) => ipcRenderer.invoke(IPC.PROJECT.GIT_INIT, dirPath),
  update: (id: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC.PROJECT.UPDATE, id, updates),
  pickIcon: (projectId: string) =>
    ipcRenderer.invoke(IPC.PROJECT.PICK_ICON, projectId),
  reorder: (orderedIds: string[]) =>
    ipcRenderer.invoke(IPC.PROJECT.REORDER, orderedIds),
  readIcon: (filename: string) =>
    ipcRenderer.invoke(IPC.PROJECT.READ_ICON, filename),
  pickImage: () =>
    ipcRenderer.invoke(IPC.PROJECT.PICK_IMAGE),
  saveCroppedIcon: (projectId: string, dataUrl: string) =>
    ipcRenderer.invoke(IPC.PROJECT.SAVE_CROPPED_ICON, projectId, dataUrl),
  listClubhouseFiles: (projectPath: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.PROJECT.LIST_CLUBHOUSE_FILES, projectPath),
  resetProject: (projectPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.PROJECT.RESET_PROJECT, projectPath),
  readLaunchWrapper: (projectPath: string) =>
    ipcRenderer.invoke(IPC.PROJECT.READ_LAUNCH_WRAPPER, projectPath),
  writeLaunchWrapper: (projectPath: string, wrapper: LaunchWrapperConfig) =>
    ipcRenderer.invoke(IPC.PROJECT.WRITE_LAUNCH_WRAPPER, projectPath, wrapper),
  readMcpCatalog: (projectPath: string) =>
    ipcRenderer.invoke(IPC.PROJECT.READ_MCP_CATALOG, projectPath),
  writeMcpCatalog: (projectPath: string, catalog: McpCatalogEntry[]) =>
    ipcRenderer.invoke(IPC.PROJECT.WRITE_MCP_CATALOG, projectPath, catalog),
  readDefaultMcps: (projectPath: string) =>
    ipcRenderer.invoke(IPC.PROJECT.READ_DEFAULT_MCPS, projectPath),
  writeDefaultMcps: (projectPath: string, mcpIds: string[]) =>
    ipcRenderer.invoke(IPC.PROJECT.WRITE_DEFAULT_MCPS, projectPath, mcpIds),
  readMcpConfigs: (projectPath: string) =>
    ipcRenderer.invoke(IPC.PROJECT.READ_MCP_CONFIGS, projectPath),
  writeMcpConfigs: (projectPath: string, configs: Record<string, Record<string, string>>) =>
    ipcRenderer.invoke(IPC.PROJECT.WRITE_MCP_CONFIGS, projectPath, configs),
  readWrapperCatalogSnapshot: (projectPath: string): Promise<WrapperCatalogSnapshot | undefined> =>
    ipcRenderer.invoke(IPC.PROJECT.READ_WRAPPER_CATALOG_SNAPSHOT, projectPath),
  writeWrapperCatalogSnapshot: (projectPath: string, snapshot: WrapperCatalogSnapshot | undefined): Promise<void> =>
    ipcRenderer.invoke(IPC.PROJECT.WRITE_WRAPPER_CATALOG_SNAPSHOT, projectPath, snapshot),
  /** The stored pins, inactive marks and activity; the first window ever hands over `legacy`, its localStorage copy (#2458). */
  hydrateState: (legacy: ProjectState): Promise<ProjectState> =>
    ipcRenderer.invoke(IPC.PROJECT.STATE_HYDRATE, legacy),
  /** Apply one op in main. `seq` counts up per window; broadcasts acknowledge it. */
  applyStateOp: (clientId: string, seq: number, op: ProjectStateOp): Promise<void> =>
    ipcRenderer.invoke(IPC.PROJECT.STATE_APPLY, clientId, seq, op),
  onStateChanged: (callback: (change: ProjectStateChange) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, change: ProjectStateChange) => callback(change);
    ipcRenderer.on(IPC.PROJECT.STATE_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.PROJECT.STATE_CHANGED, listener); };
  },
  },
};
