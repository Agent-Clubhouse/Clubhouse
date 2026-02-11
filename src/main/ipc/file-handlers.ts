import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as fileService from '../services/file-service';

export function registerFileHandlers(): void {
  ipcMain.handle(IPC.FILE.READ_TREE, (_event, dirPath: string) => {
    return fileService.readTree(dirPath);
  });

  ipcMain.handle(IPC.FILE.READ, (_event, filePath: string) => {
    return fileService.readFile(filePath);
  });

  ipcMain.handle(IPC.FILE.WRITE, (_event, filePath: string, content: string) => {
    fileService.writeFile(filePath, content);
  });
}
