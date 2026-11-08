import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { DispatcherState } from '../shared/dispatcher-types';
import type { DispatcherBehavior } from '../shared/dispatcher-behavior';

export const dispatcher = {
  dispatcher: {
    get: (): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.GET),
    /** Turns the Dispatcher on or off; resolves with the state afterwards. */
    setEnabled: (on: boolean): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.SET_ENABLED, on),
    /** Sets its Behavior (#3045); resolves with the state afterwards. */
    setBehavior: (level: DispatcherBehavior): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.SET_BEHAVIOR, level),
    /** Starts its conversation over (#3043): now if it's running, else at its next start. Memory stays. */
    clearChat: (): Promise<{ cleared: 'now' | 'next_start' }> => ipcRenderer.invoke(IPC.DISPATCHER.CLEAR_CHAT),
    onChanged: (callback: (state: DispatcherState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: DispatcherState) => callback(state);
      ipcRenderer.on(IPC.DISPATCHER.CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DISPATCHER.CHANGED, listener);
      };
    },
  },
};
