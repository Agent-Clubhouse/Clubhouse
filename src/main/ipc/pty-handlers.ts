import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as ptyManager from '../services/pty-manager';
import { numberArg, stringArg, withValidatedArgs } from './validation';

/** Maximum bytes for a single pty:write call (64 KB — generous for paste, bounded for safety). */
const PTY_WRITE_MAX_LENGTH = 64 * 1024;

export function registerPtyHandlers(): void {
  ipcMain.handle(IPC.PTY.SPAWN_SHELL, withValidatedArgs([stringArg(), stringArg()], (_event, id: string, projectPath: string) => {
    ptyManager.spawnShell(id, projectPath);
  }));

  ipcMain.on(IPC.PTY.WRITE, withValidatedArgs([stringArg(), stringArg({ minLength: 0, maxLength: PTY_WRITE_MAX_LENGTH })], (_event, agentId: string, data: string) => {
    ptyManager.write(agentId, data);
  }));

  ipcMain.on(IPC.PTY.RESIZE, withValidatedArgs([stringArg(), numberArg({ integer: true, min: 1 }), numberArg({ integer: true, min: 1 })], (_event, agentId: string, cols: number, rows: number) => {
    ptyManager.resize(agentId, cols, rows);
  }));

  ipcMain.handle(IPC.PTY.KILL, withValidatedArgs([stringArg()], (_event, agentId: string) => {
    ptyManager.gracefulKill(agentId);
  }));

  ipcMain.handle(IPC.PTY.GET_BUFFER, withValidatedArgs([stringArg()], (_event, agentId: string) => {
    return ptyManager.getBuffer(agentId);
  }));
}
