import { ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as fileService from '../services/file-service';
import * as searchService from '../services/search-service';
import { startWatch, stopWatch } from '../services/file-watch-service';
import { appLog } from '../services/log-service';
import type { FileSearchOptions } from '../../shared/types';
import { booleanArg, numberArg, objectArg, stringArg, withValidatedArgs } from './validation';

export function registerFileHandlers(): void {
  ipcMain.handle(IPC.FILE.READ_TREE, withValidatedArgs(
    [
      stringArg(),
      objectArg<{ includeHidden?: boolean; depth?: number }>({
        optional: true,
        validate: (value, argName) => {
          if (value.includeHidden !== undefined) booleanArg()(value.includeHidden, `${argName}.includeHidden`);
          if (value.depth !== undefined) numberArg({ integer: true, min: 0 })(value.depth, `${argName}.depth`);
        },
      }),
    ],
    async (event, dirPath: string, options?: { includeHidden?: boolean; depth?: number }) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    event.sender.once('destroyed', abort);
    try {
      return await fileService.readTree(dirPath, { ...options, signal: controller.signal });
    } finally {
      event.sender.off('destroyed', abort);
    }
    },
  ));

  ipcMain.handle(IPC.FILE.READ, withValidatedArgs([stringArg()], async (_event, filePath: string) => {
    try {
      return await fileService.readFile(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      appLog('core:file', 'error', 'Failed to read file', {
        meta: { filePath, code, error: message },
      });
      throw new Error(`Failed to read file "${filePath}": ${code} - ${message}`);
    }
  }));

  ipcMain.handle(IPC.FILE.WRITE, withValidatedArgs([stringArg(), stringArg({ minLength: 0 })], async (_event, filePath: string, content: string) => {
    await fileService.writeFile(filePath, content);
  }));

  ipcMain.handle(IPC.FILE.READ_BINARY, withValidatedArgs([stringArg()], async (_event, filePath: string) => {
    return fileService.readBinary(filePath);
  }));

  ipcMain.handle(IPC.FILE.SHOW_IN_FOLDER, withValidatedArgs([stringArg()], (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  }));

  ipcMain.handle(IPC.FILE.MKDIR, withValidatedArgs([stringArg()], async (_event, dirPath: string) => {
    await fileService.mkdir(dirPath);
  }));

  ipcMain.handle(IPC.FILE.DELETE, withValidatedArgs([stringArg()], async (_event, filePath: string) => {
    await fileService.deleteFile(filePath);
  }));

  ipcMain.handle(IPC.FILE.RENAME, withValidatedArgs([stringArg(), stringArg()], async (_event, oldPath: string, newPath: string) => {
    await fileService.rename(oldPath, newPath);
  }));

  ipcMain.handle(IPC.FILE.COPY, withValidatedArgs([stringArg(), stringArg()], async (_event, src: string, dest: string) => {
    await fileService.copy(src, dest);
  }));

  ipcMain.handle(IPC.FILE.STAT, withValidatedArgs([stringArg()], async (_event, filePath: string) => {
    return fileService.stat(filePath);
  }));

  ipcMain.handle(IPC.FILE.WATCH_START, withValidatedArgs([stringArg(), stringArg()], (event, watchId: string, glob: string) => {
    startWatch(watchId, glob, event.sender);
  }));

  ipcMain.handle(IPC.FILE.WATCH_STOP, withValidatedArgs([stringArg()], (_event, watchId: string) => {
    stopWatch(watchId);
  }));

  ipcMain.handle(IPC.FILE.SEARCH, withValidatedArgs([
    stringArg(),
    stringArg({ minLength: 0 }),
    objectArg<FileSearchOptions>({ optional: true }),
  ], async (_event, rootPath: string, query: string, options?: FileSearchOptions) => {
    return searchService.searchFiles(rootPath, query, options);
  }));
}
