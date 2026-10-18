import { AgentUISlice, GetAgentState, SetAgentState } from './types';

export function createUISlice(set: SetAgentState, get: GetAgentState): AgentUISlice {
  return {
    activeAgentId: null,
    agentSettingsOpenFor: null,
    deleteDialogAgent: null,
    applyPersonaDialogAgent: null,
    extractPersonaDialogAgent: null,
    configChangesDialogAgent: null,
    configChangesProjectPath: null,
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
        const agent = get().agents[saved];
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

    openApplyPersonaDialog: (agentId) => set({ applyPersonaDialogAgent: agentId }),

    closeApplyPersonaDialog: () => set({ applyPersonaDialogAgent: null }),

    openExtractPersonaDialog: (agentId) => set({ extractPersonaDialogAgent: agentId }),

    closeExtractPersonaDialog: () => set({ extractPersonaDialogAgent: null }),

    openConfigChangesDialog: (agentId, projectPath) =>
      set({
        configChangesDialogAgent: agentId,
        configChangesProjectPath: projectPath,
      }),

    closeConfigChangesDialog: () =>
      set({
        configChangesDialogAgent: null,
        configChangesProjectPath: null,
      }),

    setSessionNamePrompt: (agentId) => set({ sessionNamePromptFor: agentId }),
  };
}
