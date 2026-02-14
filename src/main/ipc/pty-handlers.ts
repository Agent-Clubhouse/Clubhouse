import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as ptyManager from '../services/pty-manager';

export function registerPtyHandlers(): void {
  // PTY.SPAWN is kept only for spawnShell or legacy usage.
  // Agent spawning should go through AGENT.SPAWN_AGENT.
  ipcMain.handle(IPC.PTY.SPAWN, (_event, { agentId, projectPath, claudeArgs }) => {
    // Legacy: if claudeArgs are passed, this is old renderer code — still handled via pty-manager directly.
    // The new flow uses AGENT.SPAWN_AGENT instead.
    if (claudeArgs) {
      // Resolve binary from the default provider
      const { getProvider } = require('../orchestrators');
      const provider = getProvider('claude-code');
      if (provider) {
        provider.buildSpawnCommand({ cwd: projectPath, model: undefined, mission: undefined })
          .then(({ binary }: { binary: string }) => {
            ptyManager.spawn(agentId, projectPath, binary, claudeArgs);
          })
          .catch(() => {
            // fallback
            ptyManager.spawn(agentId, projectPath, 'claude', claudeArgs);
          });
      } else {
        ptyManager.spawn(agentId, projectPath, 'claude', claudeArgs);
      }
    }
  });

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
