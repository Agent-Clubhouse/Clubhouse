import { Agent } from '../../../shared/types';
import { AgentIconSlice, GetAgentState, SetAgentState } from './types';

export function createIconSlice(set: SetAgentState, _get: GetAgentState): AgentIconSlice {
  return {
    agentIcons: {},

    pickAgentIcon: async () => {
      return window.clubhouse.agent.pickIcon();
    },

    saveAgentIcon: async (agentId, projectPath, dataUrl) => {
      const filename = await window.clubhouse.agent.saveIcon(projectPath, agentId, dataUrl);
      if (!filename) return;
      set((s) => {
        const agent = s.agents[agentId];
        if (!agent) return s;
        return {
          agents: { ...s.agents, [agentId]: { ...agent, icon: filename } },
          agentIcons: { ...s.agentIcons, [agentId]: dataUrl },
        };
      });
    },

    removeAgentIcon: async (agentId, projectPath) => {
      await window.clubhouse.agent.removeIcon(projectPath, agentId);
      set((s) => {
        const agent = s.agents[agentId];
        if (!agent) return s;
        const { [agentId]: _, ...agentIcons } = s.agentIcons;
        return {
          agents: { ...s.agents, [agentId]: { ...agent, icon: undefined } },
          agentIcons,
        };
      });
    },

    loadAgentIcon: async (agent: Agent) => {
      if (!agent.icon) return;
      const dataUrl = await window.clubhouse.agent.readIcon(agent.icon);
      if (dataUrl) {
        set((s) => ({
          agentIcons: { ...s.agentIcons, [agent.id]: dataUrl },
        }));
      }
    },
  };
}
