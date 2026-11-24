import { AgentUISlice, GetAgentState, SetAgentState } from './types';
import { useAnnexClientStore } from '../annexClientStore';
import { isRemoteAgentId, parseNamespacedId, useRemoteProjectStore } from '../remoteProjectStore';

export function createUISlice(set: SetAgentState, get: GetAgentState): AgentUISlice {
  return {
    activeAgentId: null,
    agentSettingsOpenFor: null,
    deleteDialogAgent: null,
    sessionNamePromptFor: null,
    projectActiveAgent: {},
    agentSelectionSeq: 0,

    setActiveAgent: (id, projectId?) => {
      set((s) => ({ activeAgentId: id, agentSettingsOpenFor: null, agentSelectionSeq: id ? s.agentSelectionSeq + 1 : s.agentSelectionSeq }));
      if (projectId) {
        set((s) => ({ projectActiveAgent: { ...s.projectActiveAgent, [projectId]: id } }));
      }
    },

    restoreProjectAgent: (projectId) => {
      const saved = get().projectActiveAgent[projectId];
      if (saved) {
        // The sidebar can select a remote agent while switching projects. Remote
        // agents live outside the local map; disconnected catalogs are retained
        // for display, so only restore them while their host is connected.
        const remote = isRemoteAgentId(saved);
        const parsed = remote ? parseNamespacedId(saved) : null;
        const connected = parsed && useAnnexClientStore.getState().satellites.some(
          (satellite) => satellite.id === parsed.satelliteId && satellite.state === 'connected',
        );
        const agent = remote
          ? connected ? useRemoteProjectStore.getState().remoteAgents[saved] : undefined
          : get().agents[saved];
        if (agent && agent.projectId === projectId) {
          set({ activeAgentId: saved, agentSettingsOpenFor: null });
          return;
        }
      }
      set({ activeAgentId: null, agentSettingsOpenFor: null });
    },

    openAgentSettings: (agentId) => {
      const agent = get().agents[agentId];
      set((s) => ({ agentSettingsOpenFor: agentId, activeAgentId: agentId, agentSelectionSeq: s.agentSelectionSeq + 1 }));
      if (agent) {
        set((s) => ({ projectActiveAgent: { ...s.projectActiveAgent, [agent.projectId]: agentId } }));
      }
    },

    closeAgentSettings: () => set({ agentSettingsOpenFor: null }),

    openDeleteDialog: (agentId) => set({ deleteDialogAgent: agentId }),

    closeDeleteDialog: () => set({ deleteDialogAgent: null }),

    setSessionNamePrompt: (agentId) => set({ sessionNamePromptFor: agentId }),
  };
}
