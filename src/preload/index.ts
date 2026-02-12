import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

const api = {
  pty: {
    spawn: (agentId: string, projectPath: string, claudeArgs?: string[]) =>
      ipcRenderer.invoke(IPC.PTY.SPAWN, { agentId, projectPath, claudeArgs }),
    spawnShell: (id: string, projectPath: string) =>
      ipcRenderer.invoke(IPC.PTY.SPAWN_SHELL, id, projectPath),
    write: (agentId: string, data: string) =>
      ipcRenderer.send(IPC.PTY.WRITE, agentId, data),
    resize: (agentId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.PTY.RESIZE, agentId, cols, rows),
    kill: (agentId: string) =>
      ipcRenderer.invoke(IPC.PTY.KILL, agentId),
    getBuffer: (agentId: string): Promise<string> =>
      ipcRenderer.invoke(IPC.PTY.GET_BUFFER, agentId),
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
    update: (id: string, updates: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.PROJECT.UPDATE, id, updates),
    pickIcon: (projectId: string) =>
      ipcRenderer.invoke(IPC.PROJECT.PICK_ICON, projectId),
    reorder: (orderedIds: string[]) =>
      ipcRenderer.invoke(IPC.PROJECT.REORDER, orderedIds),
    readIcon: (filename: string) =>
      ipcRenderer.invoke(IPC.PROJECT.READ_ICON, filename),
  },
  agent: {
    listDurable: (projectPath: string) =>
      ipcRenderer.invoke(IPC.AGENT.LIST_DURABLE, projectPath),
    createDurable: (projectPath: string, name: string, color: string, localOnly: boolean, model?: string) =>
      ipcRenderer.invoke(IPC.AGENT.CREATE_DURABLE, projectPath, name, color, localOnly, model),
    deleteDurable: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.DELETE_DURABLE, projectPath, agentId),
    getWorktreeStatus: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.GET_WORKTREE_STATUS, projectPath, agentId),
    deleteCommitPush: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.DELETE_COMMIT_PUSH, projectPath, agentId),
    deleteCleanupBranch: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.DELETE_CLEANUP_BRANCH, projectPath, agentId),
    deleteSavePatch: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.DELETE_SAVE_PATCH, projectPath, agentId),
    deleteForce: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.DELETE_FORCE, projectPath, agentId),
    deleteUnregister: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.DELETE_UNREGISTER, projectPath, agentId),
    readQuickSummary: (agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.READ_QUICK_SUMMARY, agentId),
    getSettings: (projectPath: string) =>
      ipcRenderer.invoke(IPC.AGENT.GET_SETTINGS, projectPath),
    saveSettings: (projectPath: string, settings: any) =>
      ipcRenderer.invoke(IPC.AGENT.SAVE_SETTINGS, projectPath, settings),
    setupHooks: (worktreePath: string, agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.SETUP_HOOKS, worktreePath, agentId),
    onHookEvent: (callback: (agentId: string, event: { eventName: string; toolName?: string; toolInput?: Record<string, unknown>; timestamp: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, agentId: string, hookEvent: { eventName: string; toolName?: string; toolInput?: Record<string, unknown>; timestamp: number }) =>
        callback(agentId, hookEvent);
      ipcRenderer.on(IPC.AGENT.HOOK_EVENT, listener);
      return () => { ipcRenderer.removeListener(IPC.AGENT.HOOK_EVENT, listener); };
    },
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
    diff: (dirPath: string, filePath: string, staged: boolean) =>
      ipcRenderer.invoke(IPC.GIT.DIFF, dirPath, filePath, staged),
  },
  agentSettings: {
    readClaudeMd: (worktreePath: string) =>
      ipcRenderer.invoke(IPC.AGENT.READ_CLAUDE_MD, worktreePath),
    saveClaudeMd: (worktreePath: string, content: string) =>
      ipcRenderer.invoke(IPC.AGENT.SAVE_CLAUDE_MD, worktreePath, content),
    readMcpConfig: (worktreePath: string) =>
      ipcRenderer.invoke(IPC.AGENT.READ_MCP_CONFIG, worktreePath),
    listSkills: (worktreePath: string) =>
      ipcRenderer.invoke(IPC.AGENT.LIST_SKILLS, worktreePath),
  },
  file: {
    readTree: (dirPath: string) => ipcRenderer.invoke(IPC.FILE.READ_TREE, dirPath),
    read: (filePath: string) => ipcRenderer.invoke(IPC.FILE.READ, filePath),
    readBinary: (filePath: string) => ipcRenderer.invoke(IPC.FILE.READ_BINARY, filePath),
    write: (filePath: string, content: string) =>
      ipcRenderer.invoke(IPC.FILE.WRITE, filePath, content),
    showInFolder: (filePath: string) =>
      ipcRenderer.invoke(IPC.FILE.SHOW_IN_FOLDER, filePath),
  },
  app: {
    getNotificationSettings: () =>
      ipcRenderer.invoke(IPC.APP.GET_NOTIFICATION_SETTINGS),
    saveNotificationSettings: (settings: any) =>
      ipcRenderer.invoke(IPC.APP.SAVE_NOTIFICATION_SETTINGS, settings),
    sendNotification: (title: string, body: string, silent: boolean) =>
      ipcRenderer.invoke(IPC.APP.SEND_NOTIFICATION, title, body, silent),
    onOpenSettings: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC.APP.OPEN_SETTINGS, listener);
      return () => { ipcRenderer.removeListener(IPC.APP.OPEN_SETTINGS, listener); };
    },
  },
};

export type ClubhouseAPI = typeof api;

contextBridge.exposeInMainWorld('clubhouse', api);
