import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { ActionInput, ActionOwnerUsage, ActionRun } from '../shared/actions';
import type { ActionView, ActionNotice } from '../shared/actions/view';

export const actions = {
  actions: {
    list: (): Promise<ActionView[]> => ipcRenderer.invoke(IPC.ACTIONS.LIST),
    create: (input: ActionInput): Promise<ActionView> => ipcRenderer.invoke(IPC.ACTIONS.CREATE, input),
    update: (id: string, input: ActionInput): Promise<ActionView> => ipcRenderer.invoke(IPC.ACTIONS.UPDATE, id, input),
    setEnabled: (id: string, enabled: boolean): Promise<ActionView> => ipcRenderer.invoke(IPC.ACTIONS.SET_ENABLED, id, enabled),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ACTIONS.DELETE, id),
    runNow: (id: string): Promise<{ runId: string }> => ipcRenderer.invoke(IPC.ACTIONS.RUN_NOW, id),
    history: (id: string): Promise<ActionRun[]> => ipcRenderer.invoke(IPC.ACTIONS.HISTORY, id),
    usage: (): Promise<ActionOwnerUsage[]> => ipcRenderer.invoke(IPC.ACTIONS.USAGE),
    onChanged: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC.ACTIONS.CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.ACTIONS.CHANGED, listener); };
    },
    onNotice: (callback: (notice: ActionNotice) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, notice: ActionNotice) => callback(notice);
      ipcRenderer.on(IPC.ACTIONS.NOTICE, listener);
      return () => { ipcRenderer.removeListener(IPC.ACTIONS.NOTICE, listener); };
    },
  },
};
