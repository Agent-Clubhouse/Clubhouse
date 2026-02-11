import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as ptyManager from '../services/pty-manager';

export function registerPtyHandlers(): void {
  ipcMain.handle(IPC.PTY.SPAWN, (_event, { agentId, projectPath, claudeArgs }) => {
    ptyManager.spawn(agentId, projectPath, claudeArgs);
  });

  ipcMain.on(IPC.PTY.WRITE, (_event, agentId: string, data: string) => {
    ptyManager.write(agentId, data);
  });

  ipcMain.on(IPC.PTY.RESIZE, (_event, agentId: string, cols: number, rows: number) => {
    ptyManager.resize(agentId, cols, rows);
  });

  ipcMain.handle(IPC.PTY.KILL, (_event, agentId: string) => {
    ptyManager.kill(agentId);
  });
}
