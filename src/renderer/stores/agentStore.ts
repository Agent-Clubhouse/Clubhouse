import { create } from 'zustand';
import { Agent, AgentStatus, DurableAgentConfig } from '../../shared/types';
import { generateQuickName } from '../../shared/name-generator';

interface AgentState {
  agents: Record<string, Agent>;
  activeAgentId: string | null;
  agentActivity: Record<string, number>; // agentId -> last data timestamp
  setActiveAgent: (id: string | null) => void;
  spawnQuickAgent: (projectId: string, projectPath: string) => Promise<string>;
  spawnDurableAgent: (projectId: string, projectPath: string, config: DurableAgentConfig, resume: boolean) => Promise<string>;
  loadDurableAgents: (projectId: string, projectPath: string) => Promise<void>;
  killAgent: (id: string) => Promise<void>;
  removeAgent: (id: string) => void;
  deleteDurableAgent: (id: string, projectPath: string) => Promise<void>;
  updateAgentStatus: (id: string, status: AgentStatus, exitCode?: number) => void;
  recordActivity: (id: string) => void;
  isAgentActive: (id: string) => boolean;
}

let quickCounter = 0;

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: {},
  activeAgentId: null,
  agentActivity: {},

  setActiveAgent: (id) => set({ activeAgentId: id }),

  spawnQuickAgent: async (projectId, projectPath) => {
    quickCounter++;
    const agentId = `quick_${Date.now()}_${quickCounter}`;
    const name = generateQuickName();

    const agent: Agent = {
      id: agentId,
      projectId,
      name,
      kind: 'quick',
      status: 'running',
      color: 'gray',
      localOnly: true,
    };

    set((s) => ({
      agents: { ...s.agents, [agentId]: agent },
      activeAgentId: agentId,
    }));

    try {
      await window.clubhouse.pty.spawn(agentId, projectPath);
    } catch (err) {
      set((s) => ({
        agents: { ...s.agents, [agentId]: { ...s.agents[agentId], status: 'error' } },
      }));
      throw err;
    }

    return agentId;
  },

  spawnDurableAgent: async (projectId, projectPath, config, resume) => {
    const agentId = config.id;
    const existing = get().agents[agentId];

    const agent: Agent = {
      id: agentId,
      projectId,
      name: config.name,
      kind: 'durable',
      status: 'running',
      color: config.color,
      localOnly: config.localOnly,
      worktreePath: config.worktreePath,
      branch: config.branch,
      exitCode: undefined,
    };

    set((s) => ({
      agents: { ...s.agents, [agentId]: agent },
      activeAgentId: agentId,
    }));

    try {
      const args = resume && existing?.status === 'sleeping' ? ['--continue'] : [];
      const cwd = config.worktreePath || projectPath;
      await window.clubhouse.pty.spawn(agentId, cwd, args);
    } catch (err) {
      set((s) => ({
        agents: { ...s.agents, [agentId]: { ...s.agents[agentId], status: 'error' } },
      }));
      throw err;
    }

    return agentId;
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
          localOnly: config.localOnly,
          worktreePath: config.worktreePath,
          branch: config.branch,
        };
      }
    }

    set({ agents });
  },

  killAgent: async (id) => {
    const agent = get().agents[id];
    if (!agent) return;
    await window.clubhouse.pty.kill(id);
    const newStatus: AgentStatus = agent.kind === 'durable' ? 'sleeping' : 'stopped';
    set((s) => ({
      agents: { ...s.agents, [id]: { ...s.agents[id], status: newStatus } },
    }));
  },

  removeAgent: (id) => {
    set((s) => {
      const { [id]: _, ...rest } = s.agents;
      const activeAgentId = s.activeAgentId === id ? null : s.activeAgentId;
      return { agents: rest, activeAgentId };
    });
  },

  deleteDurableAgent: async (id, projectPath) => {
    const agent = get().agents[id];
    if (agent?.status === 'running') {
      await window.clubhouse.pty.kill(id);
    }
    await window.clubhouse.agent.deleteDurable(projectPath, id);
    get().removeAgent(id);
  },

  updateAgentStatus: (id, status, exitCode) => {
    set((s) => {
      const agent = s.agents[id];
      if (!agent) return s;
      const finalStatus = status === 'stopped' && agent.kind === 'durable' ? 'sleeping' as AgentStatus : status;
      return {
        agents: { ...s.agents, [id]: { ...agent, status: finalStatus, exitCode } },
      };
    });
  },

  recordActivity: (id) => {
    set((s) => ({
      agentActivity: { ...s.agentActivity, [id]: Date.now() },
    }));
  },

  isAgentActive: (id) => {
    const last = get().agentActivity[id];
    if (!last) return false;
    return Date.now() - last < 3000;
  },
}));
