import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { DispatcherState } from '../../shared/dispatcher-types';
import * as dispatcher from '../services/dispatcher/dispatcher-service';
import { clearDispatcherChat, type ClearChatResult } from '../services/dispatcher/dispatcher-clear-chat';
import { installGroupChat } from '../services/dispatcher/dispatcher-news';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { restorePersistedBindings } from './mcp-binding-handlers';
import { withValidatedArgs, booleanArg, objectArg, stringArg } from './validation';
import { cleanCardEdit, type AgentCardFields, type AgentCardView } from '../../shared/dispatcher-agent-card';
import { onAgentCardChanged, readAgentCardView, saveAgentCardEdit } from '../services/dispatcher/dispatcher-agent-card-source';
import { isDispatcherBehavior, type DispatcherBehaviorAuto } from '../../shared/dispatcher-behavior';
import { cleanSetupInput, cleanTryItOutRequest, type TryItOutResult } from '../../shared/dispatcher-setup';
import { checkDispatcherBehavior, tryDispatcherPersonality } from '../services/dispatcher/dispatcher-setup';

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

  // Personality and first-run setup (#3047).
  ipcMain.handle(IPC.DISPATCHER.SET_PERSONALITY, withValidatedArgs(
    [objectArg()],
    async (_event, personality): Promise<DispatcherState> => dispatcher.setDispatcherPersonality(personality),
  ));
  ipcMain.handle(IPC.DISPATCHER.COMPLETE_SETUP, withValidatedArgs(
    [objectArg()],
    async (_event, input): Promise<DispatcherState> => dispatcher.completeDispatcherSetup(cleanSetupInput(input)),
  ));
  ipcMain.handle(IPC.DISPATCHER.SET_SETUP_STATUS, withValidatedArgs(
    [stringArg()],
    async (_event, status): Promise<DispatcherState> => {
      if (status !== 'later' && status !== 'done') throw new Error(`Unknown setup status: ${status}. Use later or done.`);
      return dispatcher.setDispatcherSetupStatus(status);
    },
  ));
  // Runs one prompt on a model and never touches an agent.
  ipcMain.handle(IPC.DISPATCHER.TRY_PERSONALITY, withValidatedArgs(
    [objectArg()],
    async (_event, req): Promise<TryItOutResult> => tryDispatcherPersonality(cleanTryItOutRequest(req)),
  ));
  ipcMain.handle(IPC.DISPATCHER.CHECK_BEHAVIOR, withValidatedArgs(
    [stringArg({ maxLength: 200 }), stringArg()],
    async (_event, provider, level): Promise<DispatcherBehaviorAuto> => {
      if (!isDispatcherBehavior(level)) throw new Error(`Unknown Behavior: ${level}. Use light, standard or thorough.`);
      return checkDispatcherBehavior(provider, level);
    },
  ));

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
