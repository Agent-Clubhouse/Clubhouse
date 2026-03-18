import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as gitService from '../services/git-service';
import { booleanArg, stringArg, withValidatedArgs } from './validation';

function deferInvocation<Result>(operation: () => Promise<Result> | Result): Promise<Result> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      void Promise.resolve()
        .then(operation)
        .then(resolve, reject);
    });
  });
}

export function registerGitHandlers(): void {
  ipcMain.handle(IPC.GIT.INFO, withValidatedArgs([stringArg()], async (_event, dirPath: string) => {
    return deferInvocation(() => gitService.getGitInfo(dirPath));
  }));

  ipcMain.handle(IPC.GIT.CHECKOUT, withValidatedArgs([stringArg(), stringArg()], (_event, dirPath: string, branch: string) => {
    return gitService.checkout(dirPath, branch);
  }));

  ipcMain.handle(IPC.GIT.STAGE, withValidatedArgs([stringArg(), stringArg()], (_event, dirPath: string, filePath: string) => {
    return gitService.stage(dirPath, filePath);
  }));

  ipcMain.handle(IPC.GIT.UNSTAGE, withValidatedArgs([stringArg(), stringArg()], (_event, dirPath: string, filePath: string) => {
    return gitService.unstage(dirPath, filePath);
  }));

  ipcMain.handle(IPC.GIT.STAGE_ALL, withValidatedArgs([stringArg()], (_event, dirPath: string) => {
    return gitService.stageAll(dirPath);
  }));

  ipcMain.handle(IPC.GIT.UNSTAGE_ALL, withValidatedArgs([stringArg()], (_event, dirPath: string) => {
    return gitService.unstageAll(dirPath);
  }));

  ipcMain.handle(IPC.GIT.DISCARD, withValidatedArgs([stringArg(), stringArg(), booleanArg()], (_event, dirPath: string, filePath: string, isUntracked: boolean) => {
    return gitService.discardFile(dirPath, filePath, isUntracked);
  }));

  ipcMain.handle(IPC.GIT.COMMIT, withValidatedArgs([stringArg(), stringArg({ minLength: 0 })], (_event, dirPath: string, message: string) => {
    return gitService.commit(dirPath, message);
  }));

  ipcMain.handle(IPC.GIT.PUSH, withValidatedArgs([stringArg()], (_event, dirPath: string) => {
    return gitService.push(dirPath);
  }));

  ipcMain.handle(IPC.GIT.PULL, withValidatedArgs([stringArg()], (_event, dirPath: string) => {
    return gitService.pull(dirPath);
  }));

  ipcMain.handle(IPC.GIT.DIFF, withValidatedArgs([stringArg(), stringArg(), booleanArg()], (_event, dirPath: string, filePath: string, staged: boolean) => {
    return gitService.getFileDiff(dirPath, filePath, staged);
  }));

  ipcMain.handle(IPC.GIT.CREATE_BRANCH, withValidatedArgs([stringArg(), stringArg()], (_event, dirPath: string, branchName: string) => {
    return gitService.createBranch(dirPath, branchName);
  }));

  ipcMain.handle(IPC.GIT.STASH, withValidatedArgs([stringArg()], (_event, dirPath: string) => {
    return gitService.stash(dirPath);
  }));

  ipcMain.handle(IPC.GIT.STASH_POP, withValidatedArgs([stringArg()], (_event, dirPath: string) => {
    return gitService.stashPop(dirPath);
  }));

  ipcMain.handle(IPC.GIT.LIST_WORKTREES, withValidatedArgs([stringArg()], async (_event, dirPath: string) => {
    return deferInvocation(() => gitService.listWorktrees(dirPath));
  }));
}
