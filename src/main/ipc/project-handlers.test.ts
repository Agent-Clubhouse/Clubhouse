import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('electron', () => {
  const mockWin = {
    id: 1,
    isDestroyed: () => false,
    webContents: { getURL: () => 'http://localhost:3000' },
  };

  return {
    BrowserWindow: {
      getFocusedWindow: vi.fn(() => mockWin),
      getAllWindows: () => [mockWin],
    },
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    },
    ipcMain: {
      handle: vi.fn(),
    },
  };
});

vi.mock('../services/project-store', () => ({
  list: vi.fn(() => []),
  add: vi.fn((dirPath: string) => ({ id: 'proj_1', name: 'test', path: dirPath })),
  remove: vi.fn(),
  update: vi.fn(() => []),
  reorder: vi.fn(() => []),
  setIcon: vi.fn(() => 'icon_proj_1.png'),
  readIconData: vi.fn(() => 'data:image/png;base64,abc123'),
  saveCroppedIcon: vi.fn(() => 'icon_proj_1.png'),
}));

vi.mock('../services/agent-config', () => ({
  ensureGitignore: vi.fn(),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.from('fake-image-data')),
  };
});

import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as projectStore from '../services/project-store';
import { ensureGitignore } from '../services/agent-config';
import { appLog } from '../services/log-service';
import { registerProjectHandlers } from './project-handlers';

describe('project-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerProjectHandlers();
  });

  // --- Registration ---

  it('registers all expected IPC handlers', () => {
    const expectedChannels = [
      IPC.PROJECT.LIST,
      IPC.PROJECT.ADD,
      IPC.PROJECT.REMOVE,
      IPC.PROJECT.PICK_DIR,
      IPC.PROJECT.CHECK_GIT,
      IPC.PROJECT.GIT_INIT,
      IPC.PROJECT.UPDATE,
      IPC.PROJECT.PICK_ICON,
      IPC.PROJECT.REORDER,
      IPC.PROJECT.READ_ICON,
      IPC.PROJECT.PICK_IMAGE,
      IPC.PROJECT.SAVE_CROPPED_ICON,
      IPC.PROJECT.LIST_CLUBHOUSE_FILES,
      IPC.PROJECT.RESET_PROJECT,
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  // --- LIST ---

  it('LIST delegates to projectStore.list', async () => {
    const mockProjects = [{ id: 'proj_1', name: 'Test', path: '/tmp/test' }];
    vi.mocked(projectStore.list).mockReturnValueOnce(mockProjects as any);

    const handler = handlers.get(IPC.PROJECT.LIST)!;
    const result = await handler({});

    expect(projectStore.list).toHaveBeenCalled();
    expect(result).toEqual(mockProjects);
  });

  // --- ADD ---

  it('ADD delegates to projectStore.add and calls ensureGitignore', async () => {
    const handler = handlers.get(IPC.PROJECT.ADD)!;
    const result = await handler({}, '/tmp/my-project');

    expect(projectStore.add).toHaveBeenCalledWith('/tmp/my-project');
    expect(ensureGitignore).toHaveBeenCalledWith('/tmp/my-project');
    expect(result).toEqual({ id: 'proj_1', name: 'test', path: '/tmp/my-project' });
  });

  it('ADD returns project even when ensureGitignore throws', async () => {
    vi.mocked(ensureGitignore).mockImplementationOnce(() => {
      throw new Error('permission denied');
    });

    const handler = handlers.get(IPC.PROJECT.ADD)!;
    const result = await handler({}, '/tmp/readonly-project');

    expect(projectStore.add).toHaveBeenCalledWith('/tmp/readonly-project');
    expect(result).toEqual({ id: 'proj_1', name: 'test', path: '/tmp/readonly-project' });
  });

  it('rejects invalid project paths before delegating', async () => {
    const handler = handlers.get(IPC.PROJECT.ADD)!;
    expect(() => handler({}, { bad: true })).toThrow('arg1 must be a string');
    expect(projectStore.add).not.toHaveBeenCalled();
  });

  // --- REMOVE ---

  it('REMOVE delegates to projectStore.remove', async () => {
    const handler = handlers.get(IPC.PROJECT.REMOVE)!;
    await handler({}, 'proj_42');

    expect(projectStore.remove).toHaveBeenCalledWith('proj_42');
  });

  // --- PICK_DIR ---

  it('PICK_DIR opens dialog with createDirectory property', async () => {
    const handler = handlers.get(IPC.PROJECT.PICK_DIR)!;
    await handler({});

    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        properties: expect.arrayContaining(['openDirectory', 'createDirectory']),
      }),
    );
  });

  it('PICK_DIR returns null when no focused window', async () => {
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValueOnce(null);
    const handler = handlers.get(IPC.PROJECT.PICK_DIR)!;
    const result = await handler({});
    expect(result).toBeNull();
  });

  it('PICK_DIR returns null when dialog is canceled', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    const handler = handlers.get(IPC.PROJECT.PICK_DIR)!;
    const result = await handler({});
    expect(result).toBeNull();
  });

  it('PICK_DIR returns selected path on success', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Users/me/new-project'],
    });
    const handler = handlers.get(IPC.PROJECT.PICK_DIR)!;
    const result = await handler({});
    expect(result).toBe('/Users/me/new-project');
  });

  // --- CHECK_GIT ---

  it('CHECK_GIT returns true when .git directory exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(true);

    const handler = handlers.get(IPC.PROJECT.CHECK_GIT)!;
    const result = await handler({}, '/tmp/my-project');

    expect(fs.existsSync).toHaveBeenCalledWith(path.join('/tmp/my-project', '.git'));
    expect(result).toBe(true);
  });

  it('CHECK_GIT returns false when .git directory does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);

    const handler = handlers.get(IPC.PROJECT.CHECK_GIT)!;
    const result = await handler({}, '/tmp/no-git-project');

    expect(fs.existsSync).toHaveBeenCalledWith(path.join('/tmp/no-git-project', '.git'));
    expect(result).toBe(false);
  });

  // --- GIT_INIT ---

  it('GIT_INIT runs git init and returns true on success', async () => {
    const handler = handlers.get(IPC.PROJECT.GIT_INIT)!;
    const result = await handler({}, '/tmp/new-project');

    expect(execSync).toHaveBeenCalledWith('git init', {
      cwd: '/tmp/new-project',
      encoding: 'utf-8',
    });
    expect(result).toBe(true);
  });

  it('GIT_INIT returns false when execSync throws', async () => {
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error('git not found');
    });

    const handler = handlers.get(IPC.PROJECT.GIT_INIT)!;
    const result = await handler({}, '/tmp/bad-project');

    expect(result).toBe(false);
  });

  // --- UPDATE ---

  it('UPDATE delegates to projectStore.update with id and updates', async () => {
    const mockUpdated = [{ id: 'proj_1', name: 'Renamed', path: '/tmp/test' }];
    vi.mocked(projectStore.update).mockReturnValueOnce(mockUpdated as any);

    const handler = handlers.get(IPC.PROJECT.UPDATE)!;
    const result = await handler({}, 'proj_1', { displayName: 'Renamed' });

    expect(projectStore.update).toHaveBeenCalledWith('proj_1', { displayName: 'Renamed' });
    expect(result).toEqual(mockUpdated);
  });

  // --- PICK_ICON ---

  it('PICK_ICON returns null when no focused window', async () => {
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValueOnce(null);

    const handler = handlers.get(IPC.PROJECT.PICK_ICON)!;
    const result = await handler({}, 'proj_1');

    expect(result).toBeNull();
  });

  it('PICK_ICON returns null when dialog is canceled', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });

    const handler = handlers.get(IPC.PROJECT.PICK_ICON)!;
    const result = await handler({}, 'proj_1');

    expect(result).toBeNull();
  });

  it('PICK_ICON calls setIcon and returns filename on success', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Users/me/icon.png'],
    });

    const handler = handlers.get(IPC.PROJECT.PICK_ICON)!;
    const result = await handler({}, 'proj_1');

    expect(projectStore.setIcon).toHaveBeenCalledWith('proj_1', '/Users/me/icon.png');
    expect(result).toBe('icon_proj_1.png');
  });

  it('PICK_ICON shows dialog with image file filters', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });

    const handler = handlers.get(IPC.PROJECT.PICK_ICON)!;
    await handler({}, 'proj_1');

    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        properties: ['openFile'],
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'],
          },
        ],
      }),
    );
  });

  // --- REORDER ---

  it('REORDER delegates to projectStore.reorder', async () => {
    const ordered = ['proj_2', 'proj_1', 'proj_3'];
    const mockResult = [{ id: 'proj_2' }, { id: 'proj_1' }, { id: 'proj_3' }];
    vi.mocked(projectStore.reorder).mockReturnValueOnce(mockResult as any);

    const handler = handlers.get(IPC.PROJECT.REORDER)!;
    const result = await handler({}, ordered);

    expect(projectStore.reorder).toHaveBeenCalledWith(ordered);
    expect(result).toEqual(mockResult);
  });

  // --- READ_ICON ---

  it('READ_ICON delegates to projectStore.readIconData', async () => {
    const handler = handlers.get(IPC.PROJECT.READ_ICON)!;
    const result = await handler({}, 'icon_proj_1.png');

    expect(projectStore.readIconData).toHaveBeenCalledWith('icon_proj_1.png');
    expect(result).toBe('data:image/png;base64,abc123');
  });

  // --- PICK_IMAGE ---

  it('PICK_IMAGE returns null when no focused window', async () => {
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValueOnce(null);

    const handler = handlers.get(IPC.PROJECT.PICK_IMAGE)!;
    const result = await handler({});

    expect(result).toBeNull();
  });

  it('PICK_IMAGE returns null when dialog is canceled', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });

    const handler = handlers.get(IPC.PROJECT.PICK_IMAGE)!;
    const result = await handler({});

    expect(result).toBeNull();
  });

  it('PICK_IMAGE returns base64 data URL for PNG', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Users/me/photo.png'],
    });
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('png-data'));

    const handler = handlers.get(IPC.PROJECT.PICK_IMAGE)!;
    const result = await handler({});

    expect(fs.readFileSync).toHaveBeenCalledWith('/Users/me/photo.png');
    const expected = `data:image/png;base64,${Buffer.from('png-data').toString('base64')}`;
    expect(result).toBe(expected);
  });

  it('PICK_IMAGE returns correct MIME for JPEG', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Users/me/photo.jpg'],
    });
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('jpg-data'));

    const handler = handlers.get(IPC.PROJECT.PICK_IMAGE)!;
    const result = await handler({});

    expect(result).toContain('data:image/jpeg;base64,');
  });

  it('PICK_IMAGE returns correct MIME for GIF', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Users/me/anim.gif'],
    });
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('gif-data'));

    const handler = handlers.get(IPC.PROJECT.PICK_IMAGE)!;
    const result = await handler({});

    expect(result).toContain('data:image/gif;base64,');
  });

  it('PICK_IMAGE returns correct MIME for WebP', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Users/me/image.webp'],
    });
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('webp-data'));

    const handler = handlers.get(IPC.PROJECT.PICK_IMAGE)!;
    const result = await handler({});

    expect(result).toContain('data:image/webp;base64,');
  });

  it('PICK_IMAGE returns correct MIME for SVG', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Users/me/logo.svg'],
    });
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('<svg></svg>'));

    const handler = handlers.get(IPC.PROJECT.PICK_IMAGE)!;
    const result = await handler({});

    expect(result).toContain('data:image/svg+xml;base64,');
  });

  it('PICK_IMAGE falls back to image/png for unknown extension', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Users/me/image.bmp'],
    });
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('bmp-data'));

    const handler = handlers.get(IPC.PROJECT.PICK_IMAGE)!;
    const result = await handler({});

    expect(result).toContain('data:image/png;base64,');
  });

  it('PICK_IMAGE shows dialog with image file filters', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });

    const handler = handlers.get(IPC.PROJECT.PICK_IMAGE)!;
    await handler({});

    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
          },
        ],
      }),
    );
  });

  // --- SAVE_CROPPED_ICON ---

  it('SAVE_CROPPED_ICON delegates to projectStore.saveCroppedIcon', async () => {
    const handler = handlers.get(IPC.PROJECT.SAVE_CROPPED_ICON)!;
    const dataUrl = 'data:image/png;base64,abc123';
    const result = await handler({}, 'proj_1', dataUrl);

    expect(projectStore.saveCroppedIcon).toHaveBeenCalledWith('proj_1', dataUrl);
    expect(result).toBe('icon_proj_1.png');
  });

  // --- LIST_CLUBHOUSE_FILES ---

  it('LIST_CLUBHOUSE_FILES returns empty array when .clubhouse does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);

    const handler = handlers.get(IPC.PROJECT.LIST_CLUBHOUSE_FILES)!;
    const result = await handler({}, '/tmp/project');

    expect(fs.existsSync).toHaveBeenCalledWith(path.join('/tmp/project', '.clubhouse'));
    expect(result).toEqual([]);
  });

  it('LIST_CLUBHOUSE_FILES walks directory tree and returns files and dirs', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(true);

    // First call: root .clubhouse dir
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      { name: 'settings.json', isDirectory: () => false, isFile: () => true },
      { name: 'agents', isDirectory: () => true, isFile: () => false },
    ] as any);
    // Second call: agents/ subdirectory
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      { name: 'agent1.json', isDirectory: () => false, isFile: () => true },
    ] as any);

    const handler = handlers.get(IPC.PROJECT.LIST_CLUBHOUSE_FILES)!;
    const result = await handler({}, '/tmp/project');

    expect(result).toEqual([
      'settings.json',
      'agents/',
      'agents/agent1.json',
    ]);
  });

  it('LIST_CLUBHOUSE_FILES returns empty array on readdirSync error', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(true);
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    const handler = handlers.get(IPC.PROJECT.LIST_CLUBHOUSE_FILES)!;
    const result = await handler({}, '/tmp/project');

    expect(result).toEqual([]);
  });

  // --- RESET_PROJECT ---

  it('RESET_PROJECT returns true when .clubhouse does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);

    const handler = handlers.get(IPC.PROJECT.RESET_PROJECT)!;
    const result = await handler({}, '/tmp/project');

    expect(fs.existsSync).toHaveBeenCalledWith(path.join('/tmp/project', '.clubhouse'));
    expect(result).toBe(true);
  });

  it('RESET_PROJECT removes .clubhouse directory and returns true', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(true);

    const handler = handlers.get(IPC.PROJECT.RESET_PROJECT)!;
    const result = await handler({}, '/tmp/project');

    expect(appLog).toHaveBeenCalledWith(
      'core:project',
      'warn',
      'Resetting project .clubhouse directory',
      { meta: { projectPath: '/tmp/project' } },
    );
    expect(fs.rmSync).toHaveBeenCalledWith(path.join('/tmp/project', '.clubhouse'), {
      recursive: true,
      force: true,
    });
    expect(result).toBe(true);
  });

  it('RESET_PROJECT returns false and logs error when rmSync fails', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(true);
    vi.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted');
    });

    const handler = handlers.get(IPC.PROJECT.RESET_PROJECT)!;
    const result = await handler({}, '/tmp/project');

    expect(appLog).toHaveBeenCalledWith(
      'core:project',
      'error',
      'Failed to reset project directory',
      {
        meta: {
          projectPath: '/tmp/project',
          error: 'EPERM: operation not permitted',
        },
      },
    );
    expect(result).toBe(false);
  });

  it('RESET_PROJECT logs non-Error thrown values as strings', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(true);
    vi.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw 'string-error';
    });

    const handler = handlers.get(IPC.PROJECT.RESET_PROJECT)!;
    const result = await handler({}, '/tmp/project');

    expect(appLog).toHaveBeenCalledWith(
      'core:project',
      'error',
      'Failed to reset project directory',
      {
        meta: {
          projectPath: '/tmp/project',
          error: 'string-error',
        },
      },
    );
    expect(result).toBe(false);
  });
});
