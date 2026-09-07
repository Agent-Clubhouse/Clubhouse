import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const pty = {
  pty: {
  spawnShell: (id: string, projectPath: string) =>
    ipcRenderer.invoke(IPC.PTY.SPAWN_SHELL, id, projectPath),
  write: (agentId: string, data: string) =>
    ipcRenderer.send(IPC.PTY.WRITE, agentId, data),
  resize: (agentId: string, cols: number, rows: number) =>
    ipcRenderer.send(IPC.PTY.RESIZE, agentId, cols, rows),
  kill: (agentId: string) =>
    ipcRenderer.invoke(IPC.PTY.KILL, agentId),
  getBuffer: (agentId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.PTY.GET_BUFFER, agentId),
  onData: (callback: (agentId: string, data: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, data: string) =>
      callback(agentId, data);
    ipcRenderer.on(IPC.PTY.DATA, listener);
    return () => { ipcRenderer.removeListener(IPC.PTY.DATA, listener); };
  },
  onExit: (callback: (agentId: string, exitCode: number, lastOutput?: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, exitCode: number, lastOutput?: string) =>
      callback(agentId, exitCode, lastOutput);
    ipcRenderer.on(IPC.PTY.EXIT, listener);
    return () => { ipcRenderer.removeListener(IPC.PTY.EXIT, listener); };
  },
  },
};
