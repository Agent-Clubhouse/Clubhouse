import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { LoggingSettings } from '../shared/types';

export const log = {
  log: {
  /** Deprecated (#2302): the legacy session-log writer only. Renderer code logs through rendererLog. */
  write: (entry: { ts: string; ns: string; level: string; msg: string; projectId?: string; meta?: Record<string, unknown> }) =>
    ipcRenderer.send(IPC.LOG.LOG_WRITE, entry),
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
