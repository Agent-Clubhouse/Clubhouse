import { ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as githubService from '../services/github-service';

export function registerGithubHandlers(): void {
  ipcMain.handle(
    IPC.GITHUB.LIST_ISSUES,
    (_event, dirPath: string, opts?: { page?: number; perPage?: number; state?: string }) => {
      return githubService.listIssues(dirPath, opts ?? {});
    }
  );

  ipcMain.handle(
    IPC.GITHUB.VIEW_ISSUE,
    (_event, dirPath: string, issueNumber: number) => {
      return githubService.viewIssue(dirPath, issueNumber);
    }
  );

  ipcMain.handle(
    IPC.GITHUB.CREATE_ISSUE,
    (_event, dirPath: string, title: string, body: string) => {
      return githubService.createIssue(dirPath, title, body);
    }
  );

  ipcMain.handle(
    IPC.GITHUB.GET_REPO_URL,
    (_event, dirPath: string) => {
      return githubService.getRepoUrl(dirPath);
    }
  );

  ipcMain.handle(IPC.APP.OPEN_EXTERNAL_URL, (_event, url: string) => {
    return shell.openExternal(url);
  });
}
