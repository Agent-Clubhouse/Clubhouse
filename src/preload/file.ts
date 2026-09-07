import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const file = {
  file: {
  readTree: (dirPath: string, options?: { includeHidden?: boolean; depth?: number }) => ipcRenderer.invoke(IPC.FILE.READ_TREE, dirPath, options),
  read: (filePath: string) => ipcRenderer.invoke(IPC.FILE.READ, filePath),
  readBinary: (filePath: string) => ipcRenderer.invoke(IPC.FILE.READ_BINARY, filePath),
  write: (filePath: string, content: string) =>
    ipcRenderer.invoke(IPC.FILE.WRITE, filePath, content),
  showInFolder: (filePath: string) =>
    ipcRenderer.invoke(IPC.FILE.SHOW_IN_FOLDER, filePath),
  openInEditor: (filePath: string) =>
    ipcRenderer.invoke(IPC.FILE.OPEN_IN_EDITOR, filePath),
  mkdir: (dirPath: string) =>
    ipcRenderer.invoke(IPC.FILE.MKDIR, dirPath),
  delete: (filePath: string) =>
    ipcRenderer.invoke(IPC.FILE.DELETE, filePath),
  rename: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke(IPC.FILE.RENAME, oldPath, newPath),
  copy: (src: string, dest: string) =>
    ipcRenderer.invoke(IPC.FILE.COPY, src, dest),
  stat: (filePath: string) =>
    ipcRenderer.invoke(IPC.FILE.STAT, filePath),
  watchStart: (watchId: string, glob: string) =>
    ipcRenderer.invoke(IPC.FILE.WATCH_START, watchId, glob),
  watchStop: (watchId: string) =>
    ipcRenderer.invoke(IPC.FILE.WATCH_STOP, watchId),
  onWatchEvent: (callback: (...args: unknown[]) => void) =>
    ipcRenderer.on(IPC.FILE.WATCH_EVENT, callback),
  offWatchEvent: (callback: (...args: unknown[]) => void) =>
    ipcRenderer.removeListener(IPC.FILE.WATCH_EVENT, callback),
  search: (rootPath: string, query: string, options?: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regex?: boolean;
    includeGlobs?: string[];
    excludeGlobs?: string[];
    maxResults?: number;
    contextLines?: number;
  }) => ipcRenderer.invoke(IPC.FILE.SEARCH, rootPath, query, options),
  },
};
