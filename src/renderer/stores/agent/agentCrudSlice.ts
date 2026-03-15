import { Agent, DurableAgentConfig } from '../../../shared/types';
import { AgentCrudSlice, GetAgentState, SetAgentState } from './types';
import { removeAgentsFromState } from './agentUtils';
import { clearPendingActivityTimer } from './activityTimers';

export function createCrudSlice(set: SetAgentState, get: GetAgentState): AgentCrudSlice {
  return {
    agents: {},

    removeAgent: (id) => {
      clearPendingActivityTimer(id);
      set((s) => removeAgentsFromState(s, [id]));
    },

    renameAgent: async (id, newName, projectPath) => {
      await window.clubhouse.agent.renameDurable(projectPath, id, newName);
      set((s) => {
        const agent = s.agents[id];
        if (!agent) return s;
        return { agents: { ...s.agents, [id]: { ...agent, name: newName } } };
      });
    },

    updateAgent: async (id, updates, projectPath) => {
      await window.clubhouse.agent.updateDurable(projectPath, id, updates);
      set((s) => {
        const agent = s.agents[id];
        if (!agent) return s;
        const patched = { ...agent };
        if (updates.name !== undefined) patched.name = updates.name;
        if (updates.color !== undefined) patched.color = updates.color;
        if (updates.icon !== undefined) {
          patched.icon = updates.icon === null ? undefined : updates.icon;
        }
        return { agents: { ...s.agents, [id]: patched } };
      });
    },

    reorderAgents: async (projectPath, orderedIds) => {
      await window.clubhouse.agent.reorderDurable(projectPath, orderedIds);
      set((s) => {
        const newAgents: Record<string, Agent> = {};
        for (const id of orderedIds) {
          if (s.agents[id]) newAgents[id] = s.agents[id];
        }
        for (const [id, agent] of Object.entries(s.agents)) {
          if (!newAgents[id]) newAgents[id] = agent;
        }
        return { agents: newAgents };
      });
    },

    loadDurableAgents: async (projectId, projectPath) => {
      const configs: DurableAgentConfig[] = await window.clubhouse.agent.listDurable(projectPath);
      const agents = { ...get().agents };

      for (const config of configs) {
        if (!agents[config.id]) {
          agents[config.id] = {
            id: config.id,
            projectId,
            name: config.name,
            kind: 'durable',
            status: 'sleeping',
            color: config.color,
            icon: config.icon,
            worktreePath: config.worktreePath,
            branch: config.branch,
            model: config.model,
            orchestrator: config.orchestrator,
            freeAgentMode: config.freeAgentMode,
            mcpIds: config.mcpIds,
          };
        } else {
          // Always update projectId — the same agents.json may be loaded
          // under a different project store ID when a project is re-added
          // or when multiple store entries share the same path.
          agents[config.id] = { ...agents[config.id], projectId };
        }
      }

      set({ agents });

      // Load icons for agents that have them (in parallel)
      await Promise.all(
        configs
          .filter((config) => config.icon && agents[config.id])
          .map((config) => get().loadAgentIcon(agents[config.id])),
      );
    },
  };
}
