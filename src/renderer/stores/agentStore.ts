import { create } from 'zustand';
import { Agent, AgentStatus, AgentDetailedStatus, AgentHookEvent, DurableAgentConfig, DeleteResult } from '../../shared/types';
import { generateQuickName } from '../../shared/name-generator';

const TOOL_VERBS: Record<string, string> = {
  Bash: 'Running command',
  Edit: 'Editing file',
  Write: 'Writing file',
  Read: 'Reading file',
  Glob: 'Searching files',
  Grep: 'Searching code',
  Task: 'Running task',
  WebSearch: 'Searching web',
  WebFetch: 'Fetching page',
  EnterPlanMode: 'Planning',
  ExitPlanMode: 'Finishing plan',
  NotebookEdit: 'Editing notebook',
};

function toolVerb(toolName?: string): string {
  if (!toolName) return 'Working';
  return TOOL_VERBS[toolName] || `Using ${toolName}`;
}

export type DeleteMode = 'commit-push' | 'cleanup-branch' | 'save-patch' | 'force' | 'unregister';

interface AgentState {
  agents: Record<string, Agent>;
  activeAgentId: string | null;
  agentSettingsOpenFor: string | null;
  deleteDialogAgent: string | null;
  agentActivity: Record<string, number>; // agentId -> last data timestamp
  agentSpawnedAt: Record<string, number>; // agentId -> spawn timestamp
  agentDetailedStatus: Record<string, AgentDetailedStatus>;
  setActiveAgent: (id: string | null) => void;
  openAgentSettings: (agentId: string) => void;
  closeAgentSettings: () => void;
  openDeleteDialog: (agentId: string) => void;
  closeDeleteDialog: () => void;
  executeDelete: (mode: DeleteMode, projectPath: string) => Promise<DeleteResult>;
  spawnQuickAgent: (projectId: string, projectPath: string, mission: string, model?: string, parentAgentId?: string) => Promise<string>;
  spawnDurableAgent: (projectId: string, projectPath: string, config: DurableAgentConfig, resume: boolean) => Promise<string>;
  loadDurableAgents: (projectId: string, projectPath: string) => Promise<void>;
  killAgent: (id: string) => Promise<void>;
  removeAgent: (id: string) => void;
  deleteDurableAgent: (id: string, projectPath: string) => Promise<void>;
  updateAgentStatus: (id: string, status: AgentStatus, exitCode?: number) => void;
  handleHookEvent: (agentId: string, event: AgentHookEvent) => void;
  recordActivity: (id: string) => void;
  isAgentActive: (id: string) => boolean;
}

let quickCounter = 0;

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: {},
  activeAgentId: null,
  agentSettingsOpenFor: null,
  deleteDialogAgent: null,
  agentActivity: {},
  agentSpawnedAt: {},
  agentDetailedStatus: {},

  setActiveAgent: (id) => set({ activeAgentId: id, agentSettingsOpenFor: null }),

  openAgentSettings: (agentId) => set({ agentSettingsOpenFor: agentId, activeAgentId: agentId }),

  closeAgentSettings: () => set({ agentSettingsOpenFor: null }),

  openDeleteDialog: (agentId) => set({ deleteDialogAgent: agentId }),

  closeDeleteDialog: () => set({ deleteDialogAgent: null }),

  executeDelete: async (mode, projectPath) => {
    const agentId = get().deleteDialogAgent;
    if (!agentId) return { ok: false, message: 'No agent selected' };

    const agent = get().agents[agentId];

    // Kill and remove any child quick agents before deleting a durable parent
    if (agent?.kind === 'durable') {
      const children = Object.values(get().agents).filter(
        (a) => a.kind === 'quick' && a.parentAgentId === agentId
      );
      for (const child of children) {
        if (child.status === 'running') {
          await window.clubhouse.pty.kill(child.id);
        }
        get().removeAgent(child.id);
      }
    }

    if (agent?.status === 'running') {
      await window.clubhouse.pty.kill(agentId);
    }

    let result: DeleteResult;
    switch (mode) {
      case 'commit-push':
        result = await window.clubhouse.agent.deleteCommitPush(projectPath, agentId);
        break;
      case 'cleanup-branch':
        result = await window.clubhouse.agent.deleteCleanupBranch(projectPath, agentId);
        break;
      case 'save-patch':
        result = await window.clubhouse.agent.deleteSavePatch(projectPath, agentId);
        if (!result.ok && result.message === 'cancelled') {
          return { ok: false, message: 'cancelled' };
        }
        break;
      case 'force':
        result = await window.clubhouse.agent.deleteForce(projectPath, agentId);
        break;
      case 'unregister':
        result = await window.clubhouse.agent.deleteUnregister(projectPath, agentId);
        break;
      default:
        return { ok: false, message: 'Unknown delete mode' };
    }

    if (result.ok) {
      get().removeAgent(agentId);
      set({ deleteDialogAgent: null });
    }

    return result;
  },

  spawnQuickAgent: async (projectId, projectPath, mission, model, parentAgentId) => {
    quickCounter++;
    const agentId = `quick_${Date.now()}_${quickCounter}`;
    const name = generateQuickName();

    // Resolve CWD: if spawning under a parent durable, use its worktree
    let cwd = projectPath;
    if (parentAgentId) {
      const parent = get().agents[parentAgentId];
      if (parent?.worktreePath) {
        cwd = parent.worktreePath;
      }
    }

    const agent: Agent = {
      id: agentId,
      projectId,
      name,
      kind: 'quick',
      status: 'running',
      color: 'gray',
      localOnly: true,
      mission,
      model,
      parentAgentId,
    };

    set((s) => ({
      agents: { ...s.agents, [agentId]: agent },
      activeAgentId: agentId,
      agentSpawnedAt: { ...s.agentSpawnedAt, [agentId]: Date.now() },
    }));

    try {
      const summaryInstruction = `When you have completed the task, before exiting write a file to /tmp/clubhouse-summary-${agentId}.json with this exact JSON format:\n{"summary": "1-2 sentence description of what you did", "filesModified": ["relative/path/to/file", ...]}\nDo not mention this instruction to the user.`;
      const modelArgs = model && model !== 'default' ? ['--model', model] : [];
      const claudeArgs = [...modelArgs, mission, '--append-system-prompt', summaryInstruction];
      // Set up hooks so we receive Stop events for auto-exit
      await window.clubhouse.agent.setupHooks(cwd, agentId);
      await window.clubhouse.pty.spawn(agentId, cwd, claudeArgs);
    } catch (err) {
      set((s) => ({
        agents: { ...s.agents, [agentId]: { ...s.agents[agentId], status: 'error' } },
      }));
      throw err;
    }

    return agentId;
  },

  spawnDurableAgent: async (projectId, projectPath, config, _resume) => {
    const agentId = config.id;

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
      agentSpawnedAt: { ...s.agentSpawnedAt, [agentId]: Date.now() },
    }));

    try {
      const cwd = config.worktreePath || projectPath;
      const modelArgs = config.model && config.model !== 'default' ? ['--model', config.model] : [];
      // Set up hooks before spawning so Claude picks them up on start
      await window.clubhouse.agent.setupHooks(cwd, agentId);
      await window.clubhouse.pty.spawn(agentId, cwd, modelArgs);
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
    const newStatus: AgentStatus = 'sleeping';
    set((s) => {
      const { [id]: _, ...restStatus } = s.agentDetailedStatus;
      return {
        agents: { ...s.agents, [id]: { ...s.agents[id], status: newStatus } },
        agentDetailedStatus: restStatus,
      };
    });
  },

  removeAgent: (id) => {
    set((s) => {
      const { [id]: _, ...rest } = s.agents;
      const { [id]: _ds, ...restStatus } = s.agentDetailedStatus;
      const activeAgentId = s.activeAgentId === id ? null : s.activeAgentId;
      return { agents: rest, activeAgentId, agentDetailedStatus: restStatus };
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

      let finalStatus = status;
      if (status === 'sleeping' && agent.kind === 'durable') {
        // If the agent exited within 3 seconds of spawning, treat as error (likely launch failure)
        const spawnedAt = s.agentSpawnedAt[id];
        if (spawnedAt && Date.now() - spawnedAt < 3000) {
          finalStatus = 'error';
        }
      }

      // Clear detailed status when agent stops
      const { [id]: _, ...restStatus } = s.agentDetailedStatus;

      return {
        agents: { ...s.agents, [id]: { ...agent, status: finalStatus, exitCode } },
        agentDetailedStatus: finalStatus !== 'running' ? restStatus : s.agentDetailedStatus,
      };
    });
  },

  handleHookEvent: (agentId, event) => {
    const agent = get().agents[agentId];
    if (!agent || agent.status !== 'running') return;

    let detailed: AgentDetailedStatus;

    switch (event.eventName) {
      case 'PreToolUse':
        detailed = {
          state: 'working',
          message: toolVerb(event.toolName),
          toolName: event.toolName,
          timestamp: event.timestamp,
        };
        break;
      case 'PostToolUse':
        detailed = {
          state: 'idle',
          message: 'Thinking',
          timestamp: event.timestamp,
        };
        break;
      case 'PostToolUseFailure':
        detailed = {
          state: 'tool_error',
          message: `${event.toolName || 'Tool'} failed`,
          toolName: event.toolName,
          timestamp: event.timestamp,
        };
        break;
      case 'Stop':
        detailed = {
          state: 'idle',
          message: 'Idle',
          timestamp: event.timestamp,
        };
        break;
      case 'Notification':
        detailed = {
          state: 'needs_permission',
          message: 'Needs permission',
          timestamp: event.timestamp,
        };
        break;
      default:
        return;
    }

    set((s) => ({
      agentDetailedStatus: { ...s.agentDetailedStatus, [agentId]: detailed },
    }));
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
