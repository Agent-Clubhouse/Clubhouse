import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC } from '../../shared/ipc-channels';
import { Project } from '../../shared/types';

vi.mock('electron', () => ({
  app: {
    setAsDefaultProtocolClient: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn(),
  },
  BrowserWindow: {},
}));

vi.mock('../protocol-handler', async (importOriginal) => {
  // Use the real pure logic — we only mock electron/log.
  return await importOriginal();
});

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import {
  dispatchProtocolUrl,
  consumePendingProtocolAction,
  _resetPendingProtocolActionForTests,
} from './protocol-service';

const PROJECTS: Project[] = [
  { id: 'p1', name: 'alpha', path: '/Users/me/projects/alpha' },
];

function makeWindow(overrides: Record<string, unknown> = {}) {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isLoading: () => false,
      send: vi.fn(),
    },
    ...overrides,
  };
}

describe('dispatchProtocolUrl', () => {
  beforeEach(() => {
    _resetPendingProtocolActionForTests();
  });

  it('pushes a resolved open-file action to a ready window and focuses it', async () => {
    const win = makeWindow();
    await dispatchProtocolUrl(
      'clubhouse://open-file?path=/Users/me/projects/alpha/src/a.ts',
      { getWindow: () => win as never, listProjects: async () => PROJECTS },
    );

    expect(win.webContents.send).toHaveBeenCalledWith(IPC.APP.PROTOCOL_ACTION, {
      kind: 'open-file',
      projectId: 'p1',
      relativePath: 'src/a.ts',
    });
    expect(win.focus).toHaveBeenCalled();
    // Nothing queued when delivered live.
    expect(consumePendingProtocolAction()).toBeNull();
  });

  it('pushes an open-folder action to a ready window', async () => {
    const win = makeWindow();
    await dispatchProtocolUrl(
      'clubhouse://open-folder?path=/tmp/new-proj',
      { getWindow: () => win as never, listProjects: async () => PROJECTS },
    );

    expect(win.webContents.send).toHaveBeenCalledWith(IPC.APP.PROTOCOL_ACTION, {
      kind: 'open-folder',
      folderPath: '/tmp/new-proj',
    });
  });

  it('pushes open-file-not-found when no project owns the file', async () => {
    const win = makeWindow();
    await dispatchProtocolUrl(
      'clubhouse://open-file?path=/elsewhere/x.ts',
      { getWindow: () => win as never, listProjects: async () => PROJECTS },
    );

    expect(win.webContents.send).toHaveBeenCalledWith(IPC.APP.PROTOCOL_ACTION, {
      kind: 'open-file-not-found',
      filePath: '/elsewhere/x.ts',
    });
  });

  it('queues the action when no window exists yet (cold start)', async () => {
    await dispatchProtocolUrl(
      'clubhouse://open-folder?path=/tmp/new-proj',
      { getWindow: () => null, listProjects: async () => PROJECTS },
    );

    const pending = consumePendingProtocolAction();
    expect(pending).toEqual({ kind: 'open-folder', folderPath: '/tmp/new-proj' });
    // consume clears it
    expect(consumePendingProtocolAction()).toBeNull();
  });

  it('queues the action when the window is still loading', async () => {
    const win = makeWindow({ webContents: { isLoading: () => true, send: vi.fn() } });
    await dispatchProtocolUrl(
      'clubhouse://open-folder?path=/tmp/new-proj',
      { getWindow: () => win as never, listProjects: async () => PROJECTS },
    );

    expect((win.webContents.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // Window still focused so the user lands on the app after load.
    expect(win.focus).toHaveBeenCalled();
    expect(consumePendingProtocolAction()).toEqual({ kind: 'open-folder', folderPath: '/tmp/new-proj' });
  });

  it('ignores an unrecognized URL without sending or queuing', async () => {
    const win = makeWindow();
    await dispatchProtocolUrl(
      'clubhouse://bogus?path=/tmp/x',
      { getWindow: () => win as never, listProjects: async () => PROJECTS },
    );

    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(consumePendingProtocolAction()).toBeNull();
  });

  it('treats a failing project list as empty (open-file-not-found)', async () => {
    const win = makeWindow();
    await dispatchProtocolUrl(
      'clubhouse://open-file?path=/Users/me/projects/alpha/src/a.ts',
      {
        getWindow: () => win as never,
        listProjects: async () => {
          throw new Error('disk error');
        },
      },
    );

    expect(win.webContents.send).toHaveBeenCalledWith(IPC.APP.PROTOCOL_ACTION, {
      kind: 'open-file-not-found',
      filePath: '/Users/me/projects/alpha/src/a.ts',
    });
  });
});
