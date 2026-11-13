import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { DispatcherState, StartFreshResult, StartFreshScope } from '../shared/dispatcher-types';
import type { AgentCardFields, AgentCardView } from '../shared/dispatcher-agent-card';
import type { DispatcherBehavior, DispatcherBehaviorAuto } from '../shared/dispatcher-behavior';
import type { DispatcherModelsUpdate } from '../shared/dispatcher-models';
import type { DispatcherPersonality } from '../shared/dispatcher-personality';
import type { DispatcherSetupInput, TryItOutRequest, TryItOutResult } from '../shared/dispatcher-setup';
import type { ConnectableAgent, ForgetEverythingResult } from '../shared/dispatcher-settings-page';
import type { DispatcherTeaching } from '../shared/dispatcher-teaching';
import type { DispatcherUsageSplit } from '../shared/dispatcher-usage';
import type { DispatcherLeadState } from '../shared/dispatcher-lead';
import type { DispatcherPresenceSnapshot } from '../shared/dispatcher-presence';

export const dispatcher = {
  dispatcher: {
    get: (): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.GET),
    /** Turns the Dispatcher on or off; resolves with the state afterwards. */
    setEnabled: (on: boolean): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.SET_ENABLED, on),
    /** Sets its Behavior (#3045); resolves with the state afterwards. */
    setBehavior: (level: DispatcherBehavior): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.SET_BEHAVIOR, level),
    /** Choose models yourself (#3191): the switch, or one job's provider, model, effort or context. Resolves with the state afterwards. */
    setModels: (update: DispatcherModelsUpdate): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.SET_MODELS, update),
    /** Starts its conversation over (#3043): now if it's running, else at its next start. Memory stays. */
    clearChat: (): Promise<{ cleared: 'now' | 'next_start' }> => ipcRenderer.invoke(IPC.DISPATCHER.CLEAR_CHAT),
    /** Start fresh (#3240): its controller conversation, or both. Memory, agents, connections, Actions and settings stay. */
    startFresh: (scope: StartFreshScope): Promise<StartFreshResult> => ipcRenderer.invoke(IPC.DISPATCHER.START_FRESH, scope),
    /** Forget everything (#3046): clears its memory and held news. Agents, connections and Actions stay. */
    forgetEverything: (): Promise<ForgetEverythingResult> => ipcRenderer.invoke(IPC.DISPATCHER.FORGET_EVERYTHING),
    /** Every agent that can connect to it, across projects, with its Connect switch (#3046). */
    listConnectableAgents: (): Promise<ConnectableAgent[]> => ipcRenderer.invoke(IPC.DISPATCHER.LIST_CONNECTABLE_AGENTS),
    /** Sets its personality (#3047); its chat reads it at its next start. Resolves with the state afterwards. */
    setPersonality: (personality: DispatcherPersonality): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.SET_PERSONALITY, personality),
    /** Finishes first-run setup (#3047). Resolves with the state afterwards. */
    completeSetup: (input: DispatcherSetupInput): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.COMPLETE_SETUP, input),
    /** Set up later, or put the offer away (#3047). Resolves with the state afterwards. */
    setSetupStatus: (status: 'later' | 'done'): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.SET_SETUP_STATUS, status),
    /** Try it out (#3047): one sample question to the chosen model, with nothing saved and no agent contacted. */
    tryPersonality: (req: TryItOutRequest): Promise<TryItOutResult> => ipcRenderer.invoke(IPC.DISPATCHER.TRY_PERSONALITY, req),
    /** Whether Auto gives a level its models on a provider (#3047), for setup before anything is saved. */
    checkBehavior: (provider: string, level: DispatcherBehavior): Promise<DispatcherBehaviorAuto> =>
      ipcRenderer.invoke(IPC.DISPATCHER.CHECK_BEHAVIOR, provider, level),
    /** Today's usage, conversations apart from background work (#3040). */
    getUsage: (): Promise<DispatcherUsageSplit> => ipcRenderer.invoke(IPC.DISPATCHER.GET_USAGE),
    onChanged: (callback: (state: DispatcherState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: DispatcherState) => callback(state);
      ipcRenderer.on(IPC.DISPATCHER.CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DISPATCHER.CHANGED, listener);
      };
    },
    /** An agent's card (#3049), or null when Clubhouse has never asked it for one. */
    getAgentCard: (agentId: string): Promise<AgentCardView | null> => ipcRenderer.invoke(IPC.DISPATCHER.GET_AGENT_CARD, agentId),
    /** The user's edit of an agent's card. Fields left out keep what the card said. */
    saveAgentCard: (agentId: string, fields: Partial<AgentCardFields>): Promise<AgentCardView> =>
      ipcRenderer.invoke(IPC.DISPATCHER.SAVE_AGENT_CARD, agentId, fields),
    /** What its chat shows before the first message (#3048): the agents connected to it. */
    getTeaching: (): Promise<DispatcherTeaching> => ipcRenderer.invoke(IPC.DISPATCHER.GET_TEACHING),
    /** The network-wide lead (#3351), as Settings shows it. */
    getLead: (): Promise<DispatcherLeadState> => ipcRenderer.invoke(IPC.DISPATCHER.GET_LEAD),
    /** Choose the lead: a computer's machine id, or null for peers. Resolves with the state afterwards. */
    setLead: (machine: string | null): Promise<DispatcherLeadState> => ipcRenderer.invoke(IPC.DISPATCHER.SET_LEAD, machine),
    /** Take back (#3353): use this computer's own Dispatcher chat again. */
    takeBack: (): Promise<DispatcherLeadState> => ipcRenderer.invoke(IPC.DISPATCHER.TAKE_BACK),
    /** Follow the lead again after Take back. */
    followAgain: (): Promise<DispatcherLeadState> => ipcRenderer.invoke(IPC.DISPATCHER.FOLLOW_AGAIN),
    /** Keep a message for the lead's chat until its computer is back (#3353). */
    queueForLead: (text: string): Promise<{ id: string }> => ipcRenderer.invoke(IPC.DISPATCHER.QUEUE_FOR_LEAD, text),
    /** On the lead (#3354): answer an Ask-first request waiting on another computer. Throws with the reason when refused there. */
    answerRemoteApproval: (machine: string, requestId: string, answer: 'allow_once' | 'allow_lasting' | 'decline'): Promise<void> =>
      ipcRenderer.invoke(IPC.DISPATCHER.ANSWER_REMOTE_APPROVAL, machine, requestId, answer),
    /** Clear the notices about expired or refused waiting messages. */
    dismissLeadNotice: (): Promise<DispatcherLeadState> => ipcRenderer.invoke(IPC.DISPATCHER.DISMISS_LEAD_NOTICE),
    onLeadChanged: (callback: (state: DispatcherLeadState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: DispatcherLeadState) => callback(state);
      ipcRenderer.on(IPC.DISPATCHER.LEAD_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DISPATCHER.LEAD_CHANGED, listener);
      };
    },
    /** The Dispatchers on this person's other computers (#3349), read-only. */
    getPresence: (): Promise<DispatcherPresenceSnapshot> => ipcRenderer.invoke(IPC.DISPATCHER.GET_PRESENCE),
    onPresenceChanged: (callback: (snapshot: DispatcherPresenceSnapshot) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: DispatcherPresenceSnapshot) => callback(snapshot);
      ipcRenderer.on(IPC.DISPATCHER.PRESENCE_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DISPATCHER.PRESENCE_CHANGED, listener);
      };
    },
    onAgentCardChanged: (callback: (agentId: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, agentId: string) => callback(agentId);
      ipcRenderer.on(IPC.DISPATCHER.AGENT_CARD_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DISPATCHER.AGENT_CARD_CHANGED, listener);
      };
    },
  },
};
