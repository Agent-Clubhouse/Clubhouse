import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { DispatcherState, StartFreshResult } from '../../shared/dispatcher-types';
import * as dispatcher from '../services/dispatcher/dispatcher-service';
import { clearDispatcherChat, startDispatcherFresh, type ClearChatResult } from '../services/dispatcher/dispatcher-clear-chat';
import { installDispatcherWorkHealth } from '../services/dispatcher/dispatcher-work-health';
import { installGroupChat } from '../services/dispatcher/dispatcher-news';
import { installRequestTracking } from '../services/dispatcher/dispatcher-request-outcomes';
import { forgetEverything } from '../services/dispatcher/dispatcher-forget';
import { listConnectableAgents } from '../services/dispatcher/dispatcher-connected-agents';
import type { ConnectableAgent, ForgetEverythingResult } from '../../shared/dispatcher-settings-page';
import { getDispatcherUsageSplit } from '../services/dispatcher/dispatcher-usage';
import type { DispatcherUsageSplit } from '../../shared/dispatcher-usage';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { restorePersistedBindings } from './mcp-binding-handlers';
import { withValidatedArgs, booleanArg, objectArg, stringArg } from './validation';
import { cleanCardEdit, type AgentCardFields, type AgentCardView } from '../../shared/dispatcher-agent-card';
import { onAgentCardChanged, readAgentCardView, saveAgentCardEdit } from '../services/dispatcher/dispatcher-agent-card-source';
import { isDispatcherBehavior, type DispatcherBehaviorAuto } from '../../shared/dispatcher-behavior';
import { cleanSetupInput, cleanTryItOutRequest, type TryItOutResult } from '../../shared/dispatcher-setup';
import { checkDispatcherBehavior, tryDispatcherPersonality } from '../services/dispatcher/dispatcher-setup';
import type { DispatcherTeaching } from '../../shared/dispatcher-teaching';
import { readDispatcherTeaching } from '../services/dispatcher/dispatcher-teaching';
import { chooseLead, followLeadAgain, getLeadState, onLeadChanged, takeBackFromLead } from '../services/dispatcher-federation-lead';
import { dismissLeadOutboxNotice, leadOutboxState, onLeadOutboxChanged, queueForLead } from '../services/dispatcher-lead-outbox';
import { dismissLocalNews, localNewsState, onLocalNewsChanged } from '../services/dispatcher-follower-news';
import type { DispatcherLeadState } from '../../shared/dispatcher-lead';

/** A machine id, or null for "no lead". */
const nullableMachineArg = (value: unknown, argName: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`${argName} must be a computer's id or null`);
  return value;
};
import { getDispatcherPresence, onDispatcherPresenceChanged } from '../services/dispatcher-presence';
import type { DispatcherPresenceSnapshot } from '../../shared/dispatcher-presence';

/** The lead as Settings and the follower pane show it, with what waits for it. */
function leadView(): DispatcherLeadState {
  const state = getLeadState();
  return { ...state, outbox: leadOutboxState(state.lead?.machine ?? null), localNews: localNewsState() };
}

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
  // Choose models yourself (#3191): main checks the shape (cleanModelsUpdate), the provider and the model.
  ipcMain.handle(IPC.DISPATCHER.SET_MODELS, withValidatedArgs(
    [objectArg()],
    async (_event, update): Promise<DispatcherState> => dispatcher.setDispatcherModels(update),
  ));
  ipcMain.handle(IPC.DISPATCHER.CLEAR_CHAT, (): Promise<ClearChatResult> => clearDispatcherChat());
  ipcMain.handle(IPC.DISPATCHER.START_FRESH, withValidatedArgs(
    [stringArg()],
    async (_event, scope): Promise<StartFreshResult> => {
      if (scope !== 'work' && scope !== 'both') throw new Error(`Unknown scope: ${scope}. Use work or both.`);
      return startDispatcherFresh(scope);
    },
  ));
  // A controller conversation that fails every turn starts fresh on its own (#3240).
  installDispatcherWorkHealth();
  // What it used today, conversations apart from background work (#3040).
  ipcMain.handle(IPC.DISPATCHER.GET_USAGE, (): DispatcherUsageSplit => getDispatcherUsageSplit());

  // Settings > Dispatcher (#3046).
  ipcMain.handle(IPC.DISPATCHER.FORGET_EVERYTHING, (): Promise<ForgetEverythingResult> => forgetEverything());
  ipcMain.handle(IPC.DISPATCHER.LIST_CONNECTABLE_AGENTS, (): Promise<ConnectableAgent[]> => listConnectableAgents());
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
  // Each request it is handed reaches the chat with its outcome, failed or stopped included (#3237).
  installRequestTracking();

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

  // What its chat shows before the first message: the intro and suggestions (#3048).
  ipcMain.handle(IPC.DISPATCHER.GET_TEACHING, (): Promise<DispatcherTeaching> => readDispatcherTeaching());

  // The network-wide lead (#3351). Only Settings sets it: no tool or grant reaches these.
  ipcMain.handle(IPC.DISPATCHER.GET_LEAD, (): DispatcherLeadState => leadView());
  ipcMain.handle(IPC.DISPATCHER.SET_LEAD, withValidatedArgs(
    [nullableMachineArg],
    async (_event, machine): Promise<DispatcherLeadState> => { await chooseLead(machine); return leadView(); },
  ));
  // The Dispatchers on this person's other computers (#3349): read-only, pushed on a real change.
  ipcMain.handle(IPC.DISPATCHER.GET_PRESENCE, (): DispatcherPresenceSnapshot => getDispatcherPresence());
  onDispatcherPresenceChanged(() => broadcastToAllWindows(IPC.DISPATCHER.PRESENCE_CHANGED, getDispatcherPresence()));
  // Following (#3352, #3353): Take back and follow again are a person's, from the pane and Settings.
  ipcMain.handle(IPC.DISPATCHER.TAKE_BACK, async (): Promise<DispatcherLeadState> => { await takeBackFromLead(); return leadView(); });
  ipcMain.handle(IPC.DISPATCHER.FOLLOW_AGAIN, async (): Promise<DispatcherLeadState> => { await followLeadAgain(); return leadView(); });
  ipcMain.handle(IPC.DISPATCHER.QUEUE_FOR_LEAD, withValidatedArgs(
    [stringArg({ maxLength: 64_000 })],
    async (_event, text): Promise<{ id: string }> => {
      const lead = getLeadState().lead;
      if (!lead || !getLeadState().following) throw new Error('This computer isn’t following another computer’s Dispatcher.');
      return queueForLead(lead.machine, text);
    },
  ));
  ipcMain.handle(IPC.DISPATCHER.DISMISS_LEAD_NOTICE, async (): Promise<DispatcherLeadState> => {
    await dismissLeadOutboxNotice();
    dismissLocalNews();
    return leadView();
  });
  const broadcastLead = () => broadcastToAllWindows(IPC.DISPATCHER.LEAD_CHANGED, leadView());
  onLeadChanged(broadcastLead);
  onLeadOutboxChanged(broadcastLead);
  onLocalNewsChanged(broadcastLead);

  let lastApplied = '';
  dispatcher.onDispatcherChanged((state) => {
    broadcastToAllWindows(IPC.DISPATCHER.CHANGED, state);
    // Rebuild its wires without a restart. Its agent starting or stopping moves none, and nor does Behavior.
    const applied = JSON.stringify({ ...state, running: false, workRunning: false, requestsUnderWay: 0, behavior: null });
    if (state.enabled && applied !== lastApplied) void restorePersistedBindings();
    lastApplied = applied;
  });

  void dispatcher.initDispatcher();
}

/** For tests. */
export function _resetDispatcherHandlersForTesting(): void {
  registered = false;
}
