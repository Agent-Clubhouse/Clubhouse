import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const log = {
  log: {
  write: (entry: { ts: string; ns: string; level: string; msg: string; projectId?: string; meta?: Record<string, unknown> }) =>
    ipcRenderer.send(IPC.LOG.LOG_WRITE, entry),
  getSettings: () =>
    ipcRenderer.invoke(IPC.LOG.GET_LOG_SETTINGS),
  saveSettings: (settings: { enabled: boolean; namespaces: Record<string, boolean>; retention: string; minLogLevel: string }) =>
    ipcRenderer.invoke(IPC.LOG.SAVE_LOG_SETTINGS, settings),
  getNamespaces: (): Promise<string[]> =>
    ipcRenderer.invoke(IPC.LOG.GET_LOG_NAMESPACES),
  getPath: (): Promise<string> =>
    ipcRenderer.invoke(IPC.LOG.GET_LOG_PATH),
  },
};
