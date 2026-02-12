import { ipcMain, dialog, BrowserWindow } from 'electron';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../../shared/ipc-channels';
import * as projectStore from '../services/project-store';

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC.PROJECT.LIST, () => {
    return projectStore.list();
  });

  ipcMain.handle(IPC.PROJECT.ADD, (_event, dirPath: string) => {
    return projectStore.add(dirPath);
  });

  ipcMain.handle(IPC.PROJECT.REMOVE, (_event, id: string) => {
    projectStore.remove(id);
  });

  ipcMain.handle(IPC.PROJECT.PICK_DIR, async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Project Directory',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.PROJECT.CHECK_GIT, (_event, dirPath: string) => {
    return fs.existsSync(path.join(dirPath, '.git'));
  });

  ipcMain.handle(IPC.PROJECT.GIT_INIT, (_event, dirPath: string) => {
    try {
      execSync('git init', { cwd: dirPath, encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC.PROJECT.UPDATE, (_event, id: string, updates: Record<string, unknown>) => {
    return projectStore.update(id, updates as any);
  });

  ipcMain.handle(IPC.PROJECT.PICK_ICON, async (_event, projectId: string) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: 'Choose Project Icon',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return projectStore.setIcon(projectId, result.filePaths[0]);
  });

  ipcMain.handle(IPC.PROJECT.REORDER, (_event, orderedIds: string[]) => {
    return projectStore.reorder(orderedIds);
  });

  ipcMain.handle(IPC.PROJECT.READ_ICON, (_event, filename: string) => {
    return projectStore.readIconData(filename);
  });
}
