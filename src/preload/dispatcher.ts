import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { DispatcherState } from '../shared/dispatcher-types';
import type { AgentCardFields, AgentCardView } from '../shared/dispatcher-agent-card';
import type { DispatcherBehavior } from '../shared/dispatcher-behavior';
import type { DispatcherTeaching } from '../shared/dispatcher-teaching';
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
    onAgentCardChanged: (callback: (agentId: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, agentId: string) => callback(agentId);
      ipcRenderer.on(IPC.DISPATCHER.AGENT_CARD_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DISPATCHER.AGENT_CARD_CHANGED, listener);
      };
    },
  },
};
