import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { DispatcherState } from '../../shared/dispatcher-types';
import * as dispatcher from '../services/dispatcher/dispatcher-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { restorePersistedBindings } from './mcp-binding-handlers';
import { withValidatedArgs, booleanArg, objectArg, stringArg } from './validation';
import { cleanCardEdit, type AgentCardFields, type AgentCardView } from '../../shared/dispatcher-agent-card';
import { onAgentCardChanged, readAgentCardView, saveAgentCardEdit } from '../services/dispatcher/dispatcher-agent-card-source';

let registered = false;

export function registerDispatcherHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(IPC.DISPATCHER.GET, (): DispatcherState => dispatcher.getDispatcherState());
  ipcMain.handle(IPC.DISPATCHER.SET_ENABLED, withValidatedArgs(
    [booleanArg()],
    async (_event, on): Promise<DispatcherState> => dispatcher.setDispatcherEnabled(on),
  ));

  // An agent's card, for its Dispatcher card in Details (#3049).
  ipcMain.handle(IPC.DISPATCHER.GET_AGENT_CARD, withValidatedArgs(
    [stringArg({ maxLength: 200 })],
    async (_event, agentId): Promise<AgentCardView | null> => readAgentCardView(agentId),
  ));
  ipcMain.handle(IPC.DISPATCHER.SAVE_AGENT_CARD, withValidatedArgs(
    [stringArg({ maxLength: 200 }), objectArg<Partial<AgentCardFields>>()],
    async (_event, agentId, fields): Promise<AgentCardView> => saveAgentCardEdit(agentId, cleanCardEdit(fields)),
  ));
  onAgentCardChanged((agentId) => broadcastToAllWindows(IPC.DISPATCHER.AGENT_CARD_CHANGED, agentId));

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
