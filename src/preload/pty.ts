import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { PtyBufferSnapshot } from '../shared/pty-snapshot';

export const pty = {
  pty: {
  spawnShell: (id: string, projectPath: string) =>
    ipcRenderer.invoke(IPC.PTY.SPAWN_SHELL, id, projectPath),
  write: (agentId: string, data: string) =>
    ipcRenderer.send(IPC.PTY.WRITE, agentId, data),
  /** Write a binary string (one char per byte, e.g. xterm `onBinary` output) byte-for-byte. */
  writeBinary: (agentId: string, data: string) =>
    ipcRenderer.send(IPC.PTY.WRITE_BINARY, agentId, data),
  resize: (agentId: string, cols: number, rows: number) =>
    ipcRenderer.send(IPC.PTY.RESIZE, agentId, cols, rows),
  kill: (agentId: string) =>
    ipcRenderer.invoke(IPC.PTY.KILL, agentId),
  getBuffer: (agentId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.PTY.GET_BUFFER, agentId),
  /** True when a shell session is running a command, or when that can't be told (Windows). */
  isShellBusy: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.PTY.IS_SHELL_BUSY, id),
  /**
   * Buffer plus the output seq it includes (pair with the `seq` passed to
   * `onData`) and the PTY size each part was written at.
   */
  getBufferSnapshot: (agentId: string): Promise<PtyBufferSnapshot> =>
    ipcRenderer.invoke(IPC.PTY.GET_BUFFER_SNAPSHOT, agentId),
  onData: (callback: (agentId: string, data: string, seq?: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, data: string, seq?: number) =>
      callback(agentId, data, seq);
    ipcRenderer.on(IPC.PTY.DATA, listener);
    return () => { ipcRenderer.removeListener(IPC.PTY.DATA, listener); };
  },
  /** The PTY's size changed; sent after any output produced at the old size. */
  onResized: (callback: (agentId: string, cols: number, rows: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, cols: number, rows: number) =>
      callback(agentId, cols, rows);
    ipcRenderer.on(IPC.PTY.RESIZED, listener);
    return () => { ipcRenderer.removeListener(IPC.PTY.RESIZED, listener); };
  },
  onExit: (callback: (agentId: string, exitCode: number, lastOutput?: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, exitCode: number, lastOutput?: string) =>
      callback(agentId, exitCode, lastOutput);
    ipcRenderer.on(IPC.PTY.EXIT, listener);
    return () => { ipcRenderer.removeListener(IPC.PTY.EXIT, listener); };
  },
  },
};
