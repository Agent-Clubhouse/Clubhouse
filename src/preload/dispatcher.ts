import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { DispatcherState } from '../shared/dispatcher-types';

export const dispatcher = {
  dispatcher: {
    get: (): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.GET),
    /** Turns the Dispatcher on or off; resolves with the state afterwards. */
    setEnabled: (on: boolean): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.SET_ENABLED, on),
    onChanged: (callback: (state: DispatcherState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: DispatcherState) => callback(state);
      ipcRenderer.on(IPC.DISPATCHER.CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DISPATCHER.CHANGED, listener);
      };
    },
  },
};
