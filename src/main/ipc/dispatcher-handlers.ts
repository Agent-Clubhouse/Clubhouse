import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { DISPATCHER_OFF, type DispatcherState } from '../../shared/dispatcher-types';

export function registerDispatcherHandlers(): void {
  ipcMain.handle(IPC.DISPATCHER.GET, (): DispatcherState => ({ ...DISPATCHER_OFF }));
  ipcMain.handle(IPC.DISPATCHER.SET_ENABLED, (): DispatcherState => ({ ...DISPATCHER_OFF }));
}
