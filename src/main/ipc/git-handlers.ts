import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as gitService from '../services/git-service';

export function registerGitHandlers(): void {
  ipcMain.handle(IPC.GIT.INFO, (_event, dirPath: string) => {
    return gitService.getGitInfo(dirPath);
  });

  ipcMain.handle(IPC.GIT.CHECKOUT, (_event, dirPath: string, branch: string) => {
    return gitService.checkout(dirPath, branch);
  });

  ipcMain.handle(IPC.GIT.STAGE, (_event, dirPath: string, filePath: string) => {
    return gitService.stage(dirPath, filePath);
  });

  ipcMain.handle(IPC.GIT.UNSTAGE, (_event, dirPath: string, filePath: string) => {
    return gitService.unstage(dirPath, filePath);
  });

  ipcMain.handle(IPC.GIT.COMMIT, (_event, dirPath: string, message: string) => {
    return gitService.commit(dirPath, message);
  });

  ipcMain.handle(IPC.GIT.PUSH, (_event, dirPath: string) => {
    return gitService.push(dirPath);
  });

  ipcMain.handle(IPC.GIT.PULL, (_event, dirPath: string) => {
    return gitService.pull(dirPath);
  });

  ipcMain.handle(IPC.GIT.DIFF, (_event, dirPath: string, filePath: string, staged: boolean) => {
    return gitService.getFileDiff(dirPath, filePath, staged);
  });
}
