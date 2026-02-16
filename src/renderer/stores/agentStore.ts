import { create } from 'zustand';
import { Agent, AgentStatus, AgentDetailedStatus, AgentHookEvent, DurableAgentConfig, DeleteResult, HookEventKind } from '../../shared/types';
import { generateQuickName } from '../../shared/name-generator';
import { expandTemplate, AgentContext } from '../../shared/template-engine';

/** Detailed statuses older than this are considered stale and cleared */
const STALE_THRESHOLD_MS = 30_000;

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
  spawnQuickAgent: (projectId: string, projectPath: string, mission: string, model?: string, parentAgentId?: string, orchestrator?: string) => Promise<string>;
  spawnDurableAgent: (projectId: string, projectPath: string, config: DurableAgentConfig, resume: boolean) => Promise<string>;
  loadDurableAgents: (projectId: string, projectPath: string) => Promise<void>;
  killAgent: (id: string, projectPath?: string) => Promise<void>;
  removeAgent: (id: string) => void;
  deleteDurableAgent: (id: string, projectPath: string) => Promise<void>;
  renameAgent: (id: string, newName: string, projectPath: string) => Promise<void>;
  updateAgent: (id: string, updates: { name?: string; color?: string; emoji?: string | null }, projectPath: string) => Promise<void>;
  updateAgentStatus: (id: string, status: AgentStatus, exitCode?: number) => void;
  handleHookEvent: (agentId: string, event: AgentHookEvent) => void;
  clearStaleStatuses: () => void;
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
          await window.clubhouse.agent.killAgent(child.id, projectPath);
        }
        get().removeAgent(child.id);
      }
    }

    if (agent?.status === 'running') {
      await window.clubhouse.agent.killAgent(agentId, projectPath);
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

  spawnQuickAgent: async (projectId, projectPath, mission, model, parentAgentId, orchestrator) => {
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

    // Fetch quick agent defaults from parent durable agent
    let quickDefaults: { systemPrompt?: string; allowedTools?: string[]; defaultModel?: string } | undefined;
    if (parentAgentId) {
      try {
        const parentConfig = await window.clubhouse.agent.getDurableConfig(projectPath, parentAgentId);
        quickDefaults = parentConfig?.quickAgentDefaults;
      } catch {
        // Ignore — proceed without defaults
      }
    }

    // Resolve model: explicit spawn model > parent's defaultModel > original
    let resolvedModel = model;
    if ((!resolvedModel || resolvedModel === 'default') && quickDefaults?.defaultModel) {
      resolvedModel = quickDefaults.defaultModel;
    }

    // Explicit orchestrator > inherit from parent
    const resolvedOrchestrator = orchestrator || (parentAgentId ? get().agents[parentAgentId]?.orchestrator : undefined);

    const agent: Agent = {
      id: agentId,
      projectId,
      name,
      kind: 'quick',
      status: 'running',
      color: 'gray',
      mission,
      model: resolvedModel,
      parentAgentId,
      orchestrator: resolvedOrchestrator,
    };

    set((s) => ({
      agents: { ...s.agents, [agentId]: agent },
      activeAgentId: agentId,
      agentSpawnedAt: { ...s.agentSpawnedAt, [agentId]: Date.now() },
    }));

    try {
      // Get summary instruction from the orchestrator provider
      const summaryInstruction = await window.clubhouse.agent.getSummaryInstruction(agentId, projectPath);

      // Build system prompt: per-agent systemPrompt from quickDefaults, then summary
      const systemParts: string[] = [];
      const quickContext: AgentContext = {
        agentName: name,
        agentType: 'quick',
        worktreePath: cwd,
        branch: '',
        projectPath,
      };
      if (quickDefaults?.systemPrompt) {
        systemParts.push(expandTemplate(quickDefaults.systemPrompt, quickContext));
      }
      systemParts.push(summaryInstruction);
      const systemPrompt = systemParts.join('\n\n');

      // Spawn via the new orchestrator-aware API
      await window.clubhouse.agent.spawnAgent({
        agentId,
        projectPath,
        cwd,
        kind: 'quick',
        model: resolvedModel,
        mission,
        systemPrompt,
        allowedTools: quickDefaults?.allowedTools,
        orchestrator: resolvedOrchestrator,
      });
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
      worktreePath: config.worktreePath,
      branch: config.branch,
      exitCode: undefined,
      orchestrator: config.orchestrator,
    };

    set((s) => ({
      agents: { ...s.agents, [agentId]: agent },
      activeAgentId: agentId,
      agentSpawnedAt: { ...s.agentSpawnedAt, [agentId]: Date.now() },
    }));

    try {
      const cwd = config.worktreePath || projectPath;

      // Spawn via the new orchestrator-aware API
      await window.clubhouse.agent.spawnAgent({
        agentId,
        projectPath,
        cwd,
        kind: 'durable',
        model: config.model,
        orchestrator: config.orchestrator,
      });
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
          emoji: config.emoji,
          worktreePath: config.worktreePath,
          branch: config.branch,
          orchestrator: config.orchestrator,
        };
      }
    }

    set({ agents });
  },

  renameAgent: async (id, newName, projectPath) => {
    await window.clubhouse.agent.renameDurable(projectPath, id, newName);
    set((s) => ({
      agents: { ...s.agents, [id]: { ...s.agents[id], name: newName } },
    }));
  },

  updateAgent: async (id, updates, projectPath) => {
    await window.clubhouse.agent.updateDurable(projectPath, id, updates);
    set((s) => {
      const agent = s.agents[id];
      if (!agent) return s;
      const patched = { ...agent };
      if (updates.name !== undefined) patched.name = updates.name;
      if (updates.color !== undefined) patched.color = updates.color;
      if (updates.emoji !== undefined) {
        patched.emoji = updates.emoji === null ? undefined : updates.emoji;
      }
      return { agents: { ...s.agents, [id]: patched } };
    });
  },

  killAgent: async (id, projectPath) => {
    const agent = get().agents[id];
    if (!agent) return;

    if (projectPath) {
      await window.clubhouse.agent.killAgent(id, projectPath);
    } else {
      // Fallback to legacy pty kill when no project path available
      await window.clubhouse.pty.kill(id);
    }

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
      await window.clubhouse.agent.killAgent(id, projectPath);
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

    switch (event.kind) {
      case 'pre_tool':
        detailed = {
          state: 'working',
          message: event.toolVerb || 'Working',
          toolName: event.toolName,
          timestamp: event.timestamp,
        };
        break;
      case 'post_tool':
        detailed = {
          state: 'idle',
          message: 'Thinking',
          timestamp: event.timestamp,
        };
        break;
      case 'tool_error':
        detailed = {
          state: 'tool_error',
          message: `${event.toolName || 'Tool'} failed`,
          toolName: event.toolName,
          timestamp: event.timestamp,
        };
        break;
      case 'stop':
        detailed = {
          state: 'idle',
          message: 'Idle',
          timestamp: event.timestamp,
        };
        break;
      case 'notification':
        detailed = {
          state: 'needs_permission',
          message: 'Needs permission',
          timestamp: event.timestamp,
        };
        break;
      case 'permission_request':
        detailed = {
          state: 'needs_permission',
          message: 'Needs permission',
          toolName: event.toolName,
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

  /** Clear detailed statuses that haven't been updated in STALE_THRESHOLD_MS */
  clearStaleStatuses: () => {
    const now = Date.now();
    const statuses = get().agentDetailedStatus;
    const agents = get().agents;
    let changed = false;
    const updated = { ...statuses };

    for (const [agentId, status] of Object.entries(statuses)) {
      const agent = agents[agentId];
      if (!agent || agent.status !== 'running') continue;

      const age = now - status.timestamp;
      // Permission states shouldn't auto-clear — agent is waiting for user
      if (status.state === 'needs_permission') continue;
      if (age > STALE_THRESHOLD_MS) {
        delete updated[agentId];
        changed = true;
      }
    }

    if (changed) {
      set({ agentDetailedStatus: updated });
    }
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
