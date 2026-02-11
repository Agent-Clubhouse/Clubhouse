import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

const api = {
  pty: {
    spawn: (agentId: string, projectPath: string, claudeArgs?: string[]) =>
      ipcRenderer.invoke(IPC.PTY.SPAWN, { agentId, projectPath, claudeArgs }),
    write: (agentId: string, data: string) =>
      ipcRenderer.send(IPC.PTY.WRITE, agentId, data),
    resize: (agentId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.PTY.RESIZE, agentId, cols, rows),
    kill: (agentId: string) =>
      ipcRenderer.invoke(IPC.PTY.KILL, agentId),
    onData: (callback: (agentId: string, data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, agentId: string, data: string) =>
        callback(agentId, data);
      ipcRenderer.on(IPC.PTY.DATA, listener);
      return () => { ipcRenderer.removeListener(IPC.PTY.DATA, listener); };
    },
    onExit: (callback: (agentId: string, exitCode: number) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, agentId: string, exitCode: number) =>
        callback(agentId, exitCode);
      ipcRenderer.on(IPC.PTY.EXIT, listener);
      return () => { ipcRenderer.removeListener(IPC.PTY.EXIT, listener); };
    },
  },
  project: {
    list: () => ipcRenderer.invoke(IPC.PROJECT.LIST),
    add: (path: string) => ipcRenderer.invoke(IPC.PROJECT.ADD, path),
    remove: (id: string) => ipcRenderer.invoke(IPC.PROJECT.REMOVE, id),
    pickDirectory: () => ipcRenderer.invoke(IPC.PROJECT.PICK_DIR),
    checkGit: (dirPath: string) => ipcRenderer.invoke(IPC.PROJECT.CHECK_GIT, dirPath),
    gitInit: (dirPath: string) => ipcRenderer.invoke(IPC.PROJECT.GIT_INIT, dirPath),
  },
  agent: {
    listDurable: (projectPath: string) =>
      ipcRenderer.invoke(IPC.AGENT.LIST_DURABLE, projectPath),
    createDurable: (projectPath: string, name: string, color: string, localOnly: boolean) =>
      ipcRenderer.invoke(IPC.AGENT.CREATE_DURABLE, projectPath, name, color, localOnly),
    deleteDurable: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.DELETE_DURABLE, projectPath, agentId),
    getSettings: (projectPath: string) =>
      ipcRenderer.invoke(IPC.AGENT.GET_SETTINGS, projectPath),
    saveSettings: (projectPath: string, settings: any) =>
      ipcRenderer.invoke(IPC.AGENT.SAVE_SETTINGS, projectPath, settings),
  },
  git: {
    info: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.INFO, dirPath),
    checkout: (dirPath: string, branch: string) =>
      ipcRenderer.invoke(IPC.GIT.CHECKOUT, dirPath, branch),
    stage: (dirPath: string, filePath: string) =>
      ipcRenderer.invoke(IPC.GIT.STAGE, dirPath, filePath),
    unstage: (dirPath: string, filePath: string) =>
      ipcRenderer.invoke(IPC.GIT.UNSTAGE, dirPath, filePath),
    commit: (dirPath: string, message: string) =>
      ipcRenderer.invoke(IPC.GIT.COMMIT, dirPath, message),
    push: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.PUSH, dirPath),
    pull: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.PULL, dirPath),
  },
  file: {
    readTree: (dirPath: string) => ipcRenderer.invoke(IPC.FILE.READ_TREE, dirPath),
    read: (filePath: string) => ipcRenderer.invoke(IPC.FILE.READ, filePath),
    write: (filePath: string, content: string) =>
      ipcRenderer.invoke(IPC.FILE.WRITE, filePath, content),
  },
};

export type ClubhouseAPI = typeof api;

contextBridge.exposeInMainWorld('clubhouse', api);
