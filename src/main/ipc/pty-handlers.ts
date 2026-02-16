import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as ptyManager from '../services/pty-manager';

export function registerPtyHandlers(): void {
  ipcMain.handle(IPC.PTY.SPAWN_SHELL, (_event, id: string, projectPath: string) => {
    ptyManager.spawnShell(id, projectPath);
  });

  ipcMain.on(IPC.PTY.WRITE, (_event, agentId: string, data: string) => {
    ptyManager.write(agentId, data);
  });

  ipcMain.on(IPC.PTY.RESIZE, (_event, agentId: string, cols: number, rows: number) => {
    ptyManager.resize(agentId, cols, rows);
  });

  ipcMain.handle(IPC.PTY.KILL, (_event, agentId: string) => {
    ptyManager.gracefulKill(agentId);
  });

  ipcMain.handle(IPC.PTY.GET_BUFFER, (_event, agentId: string) => {
    return ptyManager.getBuffer(agentId);
  });
}
