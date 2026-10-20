import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { LoggingSettings } from '../shared/types';

export const log = {
  log: {
  getSettings: () =>
    ipcRenderer.invoke(IPC.LOG.GET_LOG_SETTINGS),
  saveSettings: (settings: LoggingSettings) =>
    ipcRenderer.invoke(IPC.LOG.SAVE_LOG_SETTINGS, settings),
  getNamespaces: (): Promise<string[]> =>
    ipcRenderer.invoke(IPC.LOG.GET_LOG_NAMESPACES),
  getPath: (): Promise<string> =>
    ipcRenderer.invoke(IPC.LOG.GET_LOG_PATH),
  },
};
