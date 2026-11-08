import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { DispatcherState } from '../../shared/dispatcher-types';
import * as dispatcher from '../services/dispatcher/dispatcher-service';
import { clearDispatcherChat, type ClearChatResult } from '../services/dispatcher/dispatcher-clear-chat';
import { installGroupChat } from '../services/dispatcher/dispatcher-news';
import { forgetEverything } from '../services/dispatcher/dispatcher-forget';
import { readDispatcherUsage } from '../services/dispatcher/dispatcher-usage';
import { listConnectableAgents } from '../services/dispatcher/dispatcher-connected-agents';
import type { ConnectableAgent, DispatcherUsage, ForgetEverythingResult } from '../../shared/dispatcher-settings-page';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { restorePersistedBindings } from './mcp-binding-handlers';
import { withValidatedArgs, booleanArg, objectArg, stringArg } from './validation';
import { cleanCardEdit, type AgentCardFields, type AgentCardView } from '../../shared/dispatcher-agent-card';
import { onAgentCardChanged, readAgentCardView, saveAgentCardEdit } from '../services/dispatcher/dispatcher-agent-card-source';
import { isDispatcherBehavior } from '../../shared/dispatcher-behavior';

let registered = false;

export function registerDispatcherHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(IPC.DISPATCHER.GET, (): DispatcherState => dispatcher.getDispatcherState());
  ipcMain.handle(IPC.DISPATCHER.SET_ENABLED, withValidatedArgs(
    [booleanArg()],
    async (_event, on): Promise<DispatcherState> => dispatcher.setDispatcherEnabled(on),
  ));
  ipcMain.handle(IPC.DISPATCHER.SET_BEHAVIOR, withValidatedArgs(
    [stringArg()],
    async (_event, level): Promise<DispatcherState> => {
      if (!isDispatcherBehavior(level)) throw new Error(`Unknown Behavior: ${level}. Use light, standard or thorough.`);
      return dispatcher.setDispatcherBehavior(level);
    },
  ));
  ipcMain.handle(IPC.DISPATCHER.CLEAR_CHAT, (): Promise<ClearChatResult> => clearDispatcherChat());

  // Settings > Dispatcher (#3046).
  ipcMain.handle(IPC.DISPATCHER.FORGET_EVERYTHING, (): Promise<ForgetEverythingResult> => forgetEverything());
  ipcMain.handle(IPC.DISPATCHER.GET_USAGE, (): Promise<DispatcherUsage> => readDispatcherUsage());
  ipcMain.handle(IPC.DISPATCHER.LIST_CONNECTABLE_AGENTS, (): Promise<ConnectableAgent[]> => listConnectableAgents());

  // Its chat is a group chat (#3043): what reaches it is triaged, and agents' news rewritten.
  installGroupChat();

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
    // Rebuild its wires without a restart. Its agent starting or stopping moves none, and nor does Behavior.
    const applied = JSON.stringify({ ...state, running: false, behavior: null });
    if (state.enabled && applied !== lastApplied) void restorePersistedBindings();
    lastApplied = applied;
  });

  void dispatcher.initDispatcher();
}

/** For tests. */
export function _resetDispatcherHandlersForTesting(): void {
  registered = false;
}
