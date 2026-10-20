import { ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as gitService from '../services/git-service';
import { getGithubRef } from '../services/github-ref-service';
import type { GithubRefKind } from '../../shared/github-ref';
import { booleanArg, numberArg, stringArg, withValidatedArgs } from './validation';

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

  ipcMain.handle(IPC.GIT.DIFF, withValidatedArgs([stringArg(), stringArg(), booleanArg(), stringArg({ optional: true })], (_event, dirPath: string, filePath: string, staged: boolean, base?: string) => {
    return gitService.getFileDiff(dirPath, filePath, staged, base);
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

  ipcMain.handle(IPC.GIT.LOG, withValidatedArgs(
    [stringArg(), numberArg({ integer: true, min: 1, optional: true }), numberArg({ integer: true, min: 0, optional: true })],
    async (_event, dirPath: string, limit?: number, offset?: number) => {
      return deferInvocation(() => gitService.getLog(dirPath, limit, offset));
    },
  ));

  ipcMain.handle(IPC.GIT.SHOW_COMMIT, withValidatedArgs([stringArg(), stringArg()], async (_event, dirPath: string, hash: string) => {
    return deferInvocation(() => gitService.showCommit(dirPath, hash));
  }));

  ipcMain.handle(IPC.GIT.COMMIT_DIFF, withValidatedArgs([stringArg(), stringArg(), stringArg()], async (_event, dirPath: string, hash: string, filePath: string) => {
    return deferInvocation(() => gitService.getCommitFileDiff(dirPath, hash, filePath));
  }));

  ipcMain.handle(IPC.GIT.HEAD_SHA, withValidatedArgs([stringArg()], async (_event, dirPath: string) => {
    return deferInvocation(() => gitService.getHeadSha(dirPath));
  }));

  ipcMain.handle(IPC.GIT.DIFF_NUMSTAT, withValidatedArgs(
    [stringArg(), stringArg({ optional: true, maxLength: 256 })],
    async (_event, dirPath: string, base?: string) => {
      return deferInvocation(() => gitService.getDiffNumstat(dirPath, base));
    },
  ));
  ipcMain.handle(IPC.GIT.BRANCH_CHANGES, withValidatedArgs([stringArg(), stringArg({ optional: true, maxLength: 256 }), booleanArg({ optional: true })], async (_event, dirPath: string, base?: string, counts?: boolean) => {
    return deferInvocation(() => gitService.getBranchChanges(dirPath, base, !!counts));
  }));

  ipcMain.handle(IPC.GIT.BRANCH_LOG, withValidatedArgs([stringArg(), stringArg({ optional: true, maxLength: 256 })], async (_event, dirPath: string, base?: string) => {
    return deferInvocation(() => gitService.getBranchLog(dirPath, base));
  }));

  ipcMain.handle(IPC.GIT.BRANCH_FILE_PATCH, withValidatedArgs([stringArg(), stringArg(), stringArg({ optional: true, maxLength: 256 })], async (_event, dirPath: string, filePath: string, base?: string) => {
    return deferInvocation(() => gitService.getBranchFilePatch(dirPath, filePath, base));
  }));

  ipcMain.handle(IPC.GIT.PULL_REQUEST_INFO, withValidatedArgs([stringArg()], async (_event, dirPath: string) => {
    return deferInvocation(() => gitService.getPullRequestInfo(dirPath));
  }));

  ipcMain.handle(IPC.GIT.PUSH_BRANCH, withValidatedArgs([stringArg()], (_event, dirPath: string) => {
    return gitService.pushUpstream(dirPath);
  }));

  // Opens only this repo's GitHub pull request or compare page (checked in openPullRequest).
  ipcMain.handle(IPC.GIT.OPEN_PULL_REQUEST, withValidatedArgs([stringArg(), stringArg({ maxLength: 2048 })], (_event, dirPath: string, url: string) => {
    return gitService.openPullRequest(dirPath, url, (u) => shell.openExternal(u));
  }));

  ipcMain.handle(IPC.GIT.GITHUB_REPO, withValidatedArgs([stringArg()], async (_event, dirPath: string) => {
    return deferInvocation(() => gitService.getGithubRepo(dirPath));
  }));

  // The service validates repo, kind and id before anything reaches gh.
  ipcMain.handle(IPC.GIT.GITHUB_REF, withValidatedArgs(
    [stringArg({ maxLength: 201 }), stringArg({ maxLength: 16 }), stringArg({ maxLength: 40 })],
    (_event, repo: string, kind: string, id: string) => getGithubRef(repo, kind as GithubRefKind, id),
  ));
}
