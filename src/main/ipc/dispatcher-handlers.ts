import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { DispatcherState } from '../../shared/dispatcher-types';
import * as dispatcher from '../services/dispatcher/dispatcher-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { restorePersistedBindings } from './mcp-binding-handlers';
import { withValidatedArgs, booleanArg } from './validation';

let registered = false;

export function registerDispatcherHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(IPC.DISPATCHER.GET, (): DispatcherState => dispatcher.getDispatcherState());
  ipcMain.handle(IPC.DISPATCHER.SET_ENABLED, withValidatedArgs(
    [booleanArg()],
    async (_event, on): Promise<DispatcherState> => dispatcher.setDispatcherEnabled(on),
  ));

  let lastApplied = '';
  dispatcher.onDispatcherChanged((state) => {
    broadcastToAllWindows(IPC.DISPATCHER.CHANGED, state);
    // Rebuild its wires without a restart. Its agent starting or stopping moves none.
    const applied = JSON.stringify({ ...state, running: false });
    if (state.enabled && applied !== lastApplied) void restorePersistedBindings();
    lastApplied = applied;
  });

  void dispatcher.initDispatcher();
}

/** For tests. */
export function _resetDispatcherHandlersForTesting(): void {
  registered = false;
}
