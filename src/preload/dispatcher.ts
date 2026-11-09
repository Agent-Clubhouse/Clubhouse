import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { DispatcherState } from '../shared/dispatcher-types';
import type { AgentCardFields, AgentCardView } from '../shared/dispatcher-agent-card';
import type { DispatcherBehavior, DispatcherBehaviorAuto } from '../shared/dispatcher-behavior';
import type { DispatcherPersonality } from '../shared/dispatcher-personality';
import type { DispatcherSetupInput, TryItOutRequest, TryItOutResult } from '../shared/dispatcher-setup';
import type { DispatcherUsageSplit } from '../shared/dispatcher-usage';

export const dispatcher = {
  dispatcher: {
    get: (): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.GET),
    /** Turns the Dispatcher on or off; resolves with the state afterwards. */
    setEnabled: (on: boolean): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.SET_ENABLED, on),
    /** Sets its Behavior (#3045); resolves with the state afterwards. */
    setBehavior: (level: DispatcherBehavior): Promise<DispatcherState> => ipcRenderer.invoke(IPC.DISPATCHER.SET_BEHAVIOR, level),
    /** Starts its conversation over (#3043): now if it's running, else at its next start. Memory stays. */
    clearChat: (): Promise<{ cleared: 'now' | 'next_start' }> => ipcRenderer.invoke(IPC.DISPATCHER.CLEAR_CHAT),
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
    onAgentCardChanged: (callback: (agentId: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, agentId: string) => callback(agentId);
      ipcRenderer.on(IPC.DISPATCHER.AGENT_CARD_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DISPATCHER.AGENT_CARD_CHANGED, listener);
      };
    },
  },
};
