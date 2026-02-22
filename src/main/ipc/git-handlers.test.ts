import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../services/git-service', () => ({
  getGitInfo: vi.fn(async () => ({ branch: 'main' })),
  checkout: vi.fn(async () => {}),
  stage: vi.fn(async () => {}),
  unstage: vi.fn(async () => {}),
  stageAll: vi.fn(async () => {}),
  unstageAll: vi.fn(async () => {}),
  discardFile: vi.fn(async () => {}),
  commit: vi.fn(async () => {}),
  push: vi.fn(async () => {}),
  pull: vi.fn(async () => {}),
  getFileDiff: vi.fn(async () => 'diff --git a/file'),
  createBranch: vi.fn(async () => {}),
  stash: vi.fn(async () => {}),
  stashPop: vi.fn(async () => {}),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerGitHandlers } from './git-handlers';
import * as gitService from '../services/git-service';

describe('git-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerGitHandlers();
  });

  it('registers all git IPC handlers', () => {
    const expectedChannels = [
      IPC.GIT.INFO, IPC.GIT.CHECKOUT, IPC.GIT.STAGE, IPC.GIT.UNSTAGE,
      IPC.GIT.STAGE_ALL, IPC.GIT.UNSTAGE_ALL, IPC.GIT.DISCARD,
      IPC.GIT.COMMIT, IPC.GIT.PUSH, IPC.GIT.PULL,
      IPC.GIT.DIFF, IPC.GIT.CREATE_BRANCH, IPC.GIT.STASH, IPC.GIT.STASH_POP,
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('INFO delegates to gitService.getGitInfo', async () => {
    const handler = handlers.get(IPC.GIT.INFO)!;
    const result = await handler({}, '/project');
    expect(gitService.getGitInfo).toHaveBeenCalledWith('/project');
    expect(result).toEqual({ branch: 'main' });
  });

  it('CHECKOUT delegates to gitService.checkout', async () => {
    const handler = handlers.get(IPC.GIT.CHECKOUT)!;
    await handler({}, '/project', 'feature');
    expect(gitService.checkout).toHaveBeenCalledWith('/project', 'feature');
  });

  it('STAGE delegates to gitService.stage', async () => {
    const handler = handlers.get(IPC.GIT.STAGE)!;
    await handler({}, '/project', 'file.ts');
    expect(gitService.stage).toHaveBeenCalledWith('/project', 'file.ts');
  });

  it('UNSTAGE delegates to gitService.unstage', async () => {
    const handler = handlers.get(IPC.GIT.UNSTAGE)!;
    await handler({}, '/project', 'file.ts');
    expect(gitService.unstage).toHaveBeenCalledWith('/project', 'file.ts');
  });

  it('STAGE_ALL delegates to gitService.stageAll', async () => {
    const handler = handlers.get(IPC.GIT.STAGE_ALL)!;
    await handler({}, '/project');
    expect(gitService.stageAll).toHaveBeenCalledWith('/project');
  });

  it('UNSTAGE_ALL delegates to gitService.unstageAll', async () => {
    const handler = handlers.get(IPC.GIT.UNSTAGE_ALL)!;
    await handler({}, '/project');
    expect(gitService.unstageAll).toHaveBeenCalledWith('/project');
  });

  it('DISCARD delegates to gitService.discardFile with isUntracked flag', async () => {
    const handler = handlers.get(IPC.GIT.DISCARD)!;
    await handler({}, '/project', 'file.ts', true);
    expect(gitService.discardFile).toHaveBeenCalledWith('/project', 'file.ts', true);
  });

  it('COMMIT delegates to gitService.commit', async () => {
    const handler = handlers.get(IPC.GIT.COMMIT)!;
    await handler({}, '/project', 'fix: bug');
    expect(gitService.commit).toHaveBeenCalledWith('/project', 'fix: bug');
  });

  it('PUSH delegates to gitService.push', async () => {
    const handler = handlers.get(IPC.GIT.PUSH)!;
    await handler({}, '/project');
    expect(gitService.push).toHaveBeenCalledWith('/project');
  });

  it('PULL delegates to gitService.pull', async () => {
    const handler = handlers.get(IPC.GIT.PULL)!;
    await handler({}, '/project');
    expect(gitService.pull).toHaveBeenCalledWith('/project');
  });

  it('DIFF delegates to gitService.getFileDiff', async () => {
    const handler = handlers.get(IPC.GIT.DIFF)!;
    const result = await handler({}, '/project', 'file.ts', true);
    expect(gitService.getFileDiff).toHaveBeenCalledWith('/project', 'file.ts', true);
    expect(result).toBe('diff --git a/file');
  });

  it('CREATE_BRANCH delegates to gitService.createBranch', async () => {
    const handler = handlers.get(IPC.GIT.CREATE_BRANCH)!;
    await handler({}, '/project', 'new-branch');
    expect(gitService.createBranch).toHaveBeenCalledWith('/project', 'new-branch');
  });

  it('STASH delegates to gitService.stash', async () => {
    const handler = handlers.get(IPC.GIT.STASH)!;
    await handler({}, '/project');
    expect(gitService.stash).toHaveBeenCalledWith('/project');
  });

  it('STASH_POP delegates to gitService.stashPop', async () => {
    const handler = handlers.get(IPC.GIT.STASH_POP)!;
    await handler({}, '/project');
    expect(gitService.stashPop).toHaveBeenCalledWith('/project');
  });
});
