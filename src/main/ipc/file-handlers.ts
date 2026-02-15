import { ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as fileService from '../services/file-service';

export function registerFileHandlers(): void {
  ipcMain.handle(IPC.FILE.READ_TREE, (_event, dirPath: string, options?: { includeHidden?: boolean; depth?: number }) => {
    return fileService.readTree(dirPath, options);
  });

  ipcMain.handle(IPC.FILE.READ, (_event, filePath: string) => {
    return fileService.readFile(filePath);
  });

  ipcMain.handle(IPC.FILE.WRITE, (_event, filePath: string, content: string) => {
    fileService.writeFile(filePath, content);
  });

  ipcMain.handle(IPC.FILE.READ_BINARY, (_event, filePath: string) => {
    return fileService.readBinary(filePath);
  });

  ipcMain.handle(IPC.FILE.SHOW_IN_FOLDER, (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle(IPC.FILE.MKDIR, (_event, dirPath: string) => {
    fileService.mkdir(dirPath);
  });

  ipcMain.handle(IPC.FILE.DELETE, (_event, filePath: string) => {
    fileService.deleteFile(filePath);
  });

  ipcMain.handle(IPC.FILE.RENAME, (_event, oldPath: string, newPath: string) => {
    fileService.rename(oldPath, newPath);
  });

  ipcMain.handle(IPC.FILE.COPY, (_event, src: string, dest: string) => {
    fileService.copy(src, dest);
  });

  ipcMain.handle(IPC.FILE.STAT, (_event, filePath: string) => {
    return fileService.stat(filePath);
  });
}
