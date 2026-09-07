import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const git = {
  git: {
  info: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.INFO, dirPath),
  checkout: (dirPath: string, branch: string) =>
    ipcRenderer.invoke(IPC.GIT.CHECKOUT, dirPath, branch),
  stage: (dirPath: string, filePath: string) =>
    ipcRenderer.invoke(IPC.GIT.STAGE, dirPath, filePath),
  unstage: (dirPath: string, filePath: string) =>
    ipcRenderer.invoke(IPC.GIT.UNSTAGE, dirPath, filePath),
  stageAll: (dirPath: string) =>
    ipcRenderer.invoke(IPC.GIT.STAGE_ALL, dirPath),
  unstageAll: (dirPath: string) =>
    ipcRenderer.invoke(IPC.GIT.UNSTAGE_ALL, dirPath),
  discard: (dirPath: string, filePath: string, isUntracked: boolean) =>
    ipcRenderer.invoke(IPC.GIT.DISCARD, dirPath, filePath, isUntracked),
  commit: (dirPath: string, message: string) =>
    ipcRenderer.invoke(IPC.GIT.COMMIT, dirPath, message),
  push: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.PUSH, dirPath),
  pull: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.PULL, dirPath),
  diff: (dirPath: string, filePath: string, staged: boolean) =>
    ipcRenderer.invoke(IPC.GIT.DIFF, dirPath, filePath, staged),
  createBranch: (dirPath: string, branchName: string) =>
    ipcRenderer.invoke(IPC.GIT.CREATE_BRANCH, dirPath, branchName),
  stash: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.STASH, dirPath),
  stashPop: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.STASH_POP, dirPath),
  listWorktrees: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.LIST_WORKTREES, dirPath),
  log: (dirPath: string, limit?: number, offset?: number) =>
    ipcRenderer.invoke(IPC.GIT.LOG, dirPath, limit, offset),
  showCommit: (dirPath: string, hash: string) =>
    ipcRenderer.invoke(IPC.GIT.SHOW_COMMIT, dirPath, hash),
  commitDiff: (dirPath: string, hash: string, filePath: string) =>
    ipcRenderer.invoke(IPC.GIT.COMMIT_DIFF, dirPath, hash, filePath),
  },
};
