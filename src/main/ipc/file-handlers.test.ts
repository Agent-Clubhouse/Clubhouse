import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));

vi.mock('../services/file-service', () => ({
  readTree: vi.fn(async () => [{ name: 'file.ts', type: 'file' }]),
  readFile: vi.fn(async () => 'file content'),
  writeFile: vi.fn(),
  readBinary: vi.fn(async () => 'base64data'),
  mkdir: vi.fn(),
  deleteFile: vi.fn(),
  rename: vi.fn(),
  copy: vi.fn(),
  stat: vi.fn(async () => ({ size: 100, isFile: true })),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

import { ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerFileHandlers } from './file-handlers';
import * as fileService from '../services/file-service';
import { appLog } from '../services/log-service';

describe('file-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerFileHandlers();
  });

  it('registers all file IPC handlers', () => {
    const expectedChannels = [
      IPC.FILE.READ_TREE, IPC.FILE.READ, IPC.FILE.WRITE, IPC.FILE.READ_BINARY,
      IPC.FILE.SHOW_IN_FOLDER, IPC.FILE.MKDIR, IPC.FILE.DELETE,
      IPC.FILE.RENAME, IPC.FILE.COPY, IPC.FILE.STAT,
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('READ_TREE delegates to fileService.readTree with options', async () => {
    const handler = handlers.get(IPC.FILE.READ_TREE)!;
    const sender = { once: vi.fn(), off: vi.fn() };
    const result = await handler({ sender }, '/project', { includeHidden: true, depth: 2 });
    expect(fileService.readTree).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ includeHidden: true, depth: 2, signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual([{ name: 'file.ts', type: 'file' }]);
  });

  it('READ_TREE passes an AbortSignal that aborts when sender is destroyed', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(fileService.readTree).mockImplementation(async (_dir, opts) => {
      capturedSignal = opts?.signal;
      return [];
    });

    const handler = handlers.get(IPC.FILE.READ_TREE)!;
    let destroyedCallback: (() => void) | undefined;
    const sender = {
      once: vi.fn((event: string, cb: () => void) => {
        if (event === 'destroyed') destroyedCallback = cb;
      }),
      off: vi.fn(),
    };

    await handler({ sender }, '/project', {});

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    // Simulate sender being destroyed
    destroyedCallback?.();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('READ_TREE removes the destroyed listener after completion', async () => {
    const handler = handlers.get(IPC.FILE.READ_TREE)!;
    const sender = { once: vi.fn(), off: vi.fn() };

    await handler({ sender }, '/project', {});

    expect(sender.off).toHaveBeenCalledWith('destroyed', expect.any(Function));
  });

  it('READ delegates to fileService.readFile', async () => {
    const handler = handlers.get(IPC.FILE.READ)!;
    const result = await handler({}, '/project/file.ts');
    expect(fileService.readFile).toHaveBeenCalledWith('/project/file.ts');
    expect(result).toBe('file content');
  });

  it('WRITE delegates to fileService.writeFile', async () => {
    const handler = handlers.get(IPC.FILE.WRITE)!;
    await handler({}, '/project/file.ts', 'new content');
    expect(fileService.writeFile).toHaveBeenCalledWith('/project/file.ts', 'new content');
  });

  it('READ_BINARY delegates to fileService.readBinary', async () => {
    const handler = handlers.get(IPC.FILE.READ_BINARY)!;
    const result = await handler({}, '/project/image.png');
    expect(fileService.readBinary).toHaveBeenCalledWith('/project/image.png');
    expect(result).toBe('base64data');
  });

  it('SHOW_IN_FOLDER delegates to shell.showItemInFolder', async () => {
    const handler = handlers.get(IPC.FILE.SHOW_IN_FOLDER)!;
    await handler({}, '/project/file.ts');
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/project/file.ts');
  });

  it('MKDIR delegates to fileService.mkdir', async () => {
    const handler = handlers.get(IPC.FILE.MKDIR)!;
    await handler({}, '/project/new-dir');
    expect(fileService.mkdir).toHaveBeenCalledWith('/project/new-dir');
  });

  it('DELETE delegates to fileService.deleteFile', async () => {
    const handler = handlers.get(IPC.FILE.DELETE)!;
    await handler({}, '/project/file.ts');
    expect(fileService.deleteFile).toHaveBeenCalledWith('/project/file.ts');
  });

  it('RENAME delegates to fileService.rename', async () => {
    const handler = handlers.get(IPC.FILE.RENAME)!;
    await handler({}, '/old/path.ts', '/new/path.ts');
    expect(fileService.rename).toHaveBeenCalledWith('/old/path.ts', '/new/path.ts');
  });

  it('COPY delegates to fileService.copy', async () => {
    const handler = handlers.get(IPC.FILE.COPY)!;
    await handler({}, '/src/file.ts', '/dest/file.ts');
    expect(fileService.copy).toHaveBeenCalledWith('/src/file.ts', '/dest/file.ts');
  });

  it('STAT delegates to fileService.stat', async () => {
    const handler = handlers.get(IPC.FILE.STAT)!;
    const result = await handler({}, '/project/file.ts');
    expect(fileService.stat).toHaveBeenCalledWith('/project/file.ts');
    expect(result).toEqual({ size: 100, isFile: true });
  });

  it('READ throws descriptive error and logs when readFile fails', async () => {
    const err = Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
    vi.mocked(fileService.readFile).mockRejectedValueOnce(err);
    const handler = handlers.get(IPC.FILE.READ)!;
    await expect(handler({}, '/missing/file.ts')).rejects.toThrow(
      'Failed to read file "/missing/file.ts": ENOENT - no such file or directory',
    );
    expect(appLog).toHaveBeenCalledWith('core:file', 'error', 'Failed to read file', {
      meta: { filePath: '/missing/file.ts', code: 'ENOENT', error: 'no such file or directory' },
    });
  });

  it('READ handles permission errors with EACCES code', async () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(fileService.readFile).mockRejectedValueOnce(err);
    const handler = handlers.get(IPC.FILE.READ)!;
    await expect(handler({}, '/protected/file.ts')).rejects.toThrow(
      'Failed to read file "/protected/file.ts": EACCES - permission denied',
    );
  });

  it('READ uses UNKNOWN code when error has no code property', async () => {
    vi.mocked(fileService.readFile).mockRejectedValueOnce(new Error('unexpected'));
    const handler = handlers.get(IPC.FILE.READ)!;
    await expect(handler({}, '/some/file.ts')).rejects.toThrow(
      'Failed to read file "/some/file.ts": UNKNOWN - unexpected',
    );
  });
});
