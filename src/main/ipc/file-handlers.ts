import { ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as fileService from '../services/file-service';

export function registerFileHandlers(): void {
  ipcMain.handle(IPC.FILE.READ_TREE, async (_event, dirPath: string, options?: { includeHidden?: boolean; depth?: number }) => {
    return fileService.readTree(dirPath, options);
  });

  ipcMain.handle(IPC.FILE.READ, async (_event, filePath: string) => {
    return fileService.readFile(filePath);
  });

  ipcMain.handle(IPC.FILE.WRITE, async (_event, filePath: string, content: string) => {
    await fileService.writeFile(filePath, content);
  });

  ipcMain.handle(IPC.FILE.READ_BINARY, async (_event, filePath: string) => {
    return fileService.readBinary(filePath);
  });

  ipcMain.handle(IPC.FILE.SHOW_IN_FOLDER, (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle(IPC.FILE.MKDIR, async (_event, dirPath: string) => {
    await fileService.mkdir(dirPath);
  });

  ipcMain.handle(IPC.FILE.DELETE, async (_event, filePath: string) => {
    await fileService.deleteFile(filePath);
  });

  ipcMain.handle(IPC.FILE.RENAME, async (_event, oldPath: string, newPath: string) => {
    await fileService.rename(oldPath, newPath);
  });

  ipcMain.handle(IPC.FILE.COPY, async (_event, src: string, dest: string) => {
    await fileService.copy(src, dest);
  });

  ipcMain.handle(IPC.FILE.STAT, async (_event, filePath: string) => {
    return fileService.stat(filePath);
  });
}
