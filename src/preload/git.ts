import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { BranchChanges, BranchFilePatch } from '../shared/git-branch';
import type { GitLogEntry, GitNumstatEntry } from '../shared/types';

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
  /** `base` (a sha) replaces HEAD as the original side. */
  diff: (dirPath: string, filePath: string, staged: boolean, base?: string) =>
    ipcRenderer.invoke(IPC.GIT.DIFF, dirPath, filePath, staged, base),
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
  /** HEAD sha of the repo containing `dirPath`, or null. */
  headSha: (dirPath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.GIT.HEAD_SHA, dirPath),
  /** Working tree vs `base` (default HEAD) line counts, plus untracked files. */
  diffNumstat: (dirPath: string, base?: string): Promise<GitNumstatEntry[]> =>
    ipcRenderer.invoke(IPC.GIT.DIFF_NUMSTAT, dirPath, base ?? undefined),
  /** The branch against its merge base with main, uncommitted work included (#2032). */
  branchChanges: (dirPath: string, base?: string): Promise<BranchChanges> =>
    ipcRenderer.invoke(IPC.GIT.BRANCH_CHANGES, dirPath, base),
  branchFilePatch: (dirPath: string, filePath: string, base?: string): Promise<BranchFilePatch> =>
    ipcRenderer.invoke(IPC.GIT.BRANCH_FILE_PATCH, dirPath, filePath, base),
  branchLog: (dirPath: string, base?: string): Promise<GitLogEntry[]> =>
    ipcRenderer.invoke(IPC.GIT.BRANCH_LOG, dirPath, base),
  },
};
