import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const process = {
  process: {
  exec: (req: {
    pluginId: string;
    command: string;
    args: string[];
    projectPath?: string;
    options?: { timeout?: number };
  }) => ipcRenderer.invoke(IPC.PROCESS.EXEC, req),
  },
};
