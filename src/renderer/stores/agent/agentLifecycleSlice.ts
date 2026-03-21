import { Agent, DeleteResult } from '../../../shared/types';
import { generateQuickAgentId } from '../../../shared/agent-id';
import { generateQuickName } from '../../../shared/name-generator';
import { expandTemplate, AgentContext } from '../../../shared/template-engine';
import { useHeadlessStore } from '../headlessStore';
import { useProjectStore } from '../projectStore';
import { AgentLifecycleSlice, GetAgentState, SetAgentState } from './types';

export function createLifecycleSlice(set: SetAgentState, get: GetAgentState): AgentLifecycleSlice {
  return {
    cancelledAgentIds: {},

    resumingAgents: {},

    setResumeStatus: (agentId, status) => {
      set((s) => ({
        resumingAgents: { ...s.resumingAgents, [agentId]: status },
      }));
    },

    clearResumingAgents: () => {
      set({ resumingAgents: {} });
    },

    spawnQuickAgent: async (projectId, projectPath, mission, model, parentAgentId, orchestrator, freeAgentMode, pluginMetadata) => {
      const agentId = generateQuickAgentId();
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
      let quickDefaults:
        | { systemPrompt?: string; allowedTools?: string[]; defaultModel?: string; freeAgentMode?: boolean }
        | undefined;
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
      const resolvedOrchestrator =
        orchestrator || (parentAgentId ? get().agents[parentAgentId]?.orchestrator : undefined);

      const isHeadless = useHeadlessStore.getState().getProjectMode(projectPath) === 'headless';

      // Resolve free agent mode: explicit param > parent's quickDefaults
      const resolvedFreeAgentMode = freeAgentMode ?? quickDefaults?.freeAgentMode;

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
        headless: isHeadless || undefined,
        freeAgentMode: resolvedFreeAgentMode || undefined,
        pluginMetadata,
      };

      set((s) => ({
        agents: { ...s.agents, [agentId]: agent },
        activeAgentId: agentId,
        agentSpawnedAt: { ...s.agentSpawnedAt, [agentId]: Date.now() },
        projectActiveAgent: { ...s.projectActiveAgent, [projectId]: agentId },
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
          freeAgentMode: resolvedFreeAgentMode,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to launch agent';
        set((s) => {
          if (!s.agents[agentId]) return s;
          return {
            agents: { ...s.agents, [agentId]: { ...s.agents[agentId], status: 'error', errorMessage } },
          };
        });
        throw err;
      }

      return agentId;
    },

    spawnDurableAgent: async (projectId, projectPath, config, resume, mission?) => {
      const agentId = config.id;

      const agent: Agent = {
        id: agentId,
        projectId,
        name: config.name,
        kind: 'durable',
        status: 'running',
        color: config.color,
        icon: config.icon,
        worktreePath: config.worktreePath,
        branch: config.branch,
        exitCode: undefined,
        mission,
        orchestrator: config.orchestrator,
        freeAgentMode: config.freeAgentMode || undefined,
        mcpIds: config.mcpIds,
        resuming: resume || undefined,
      };

      set((s) => ({
        agents: { ...s.agents, [agentId]: agent },
        activeAgentId: agentId,
        agentSpawnedAt: { ...s.agentSpawnedAt, [agentId]: Date.now() },
        projectActiveAgent: { ...s.projectActiveAgent, [projectId]: agentId },
      }));

      try {
        const cwd = config.worktreePath || projectPath;

        await window.clubhouse.agent.spawnAgent({
          agentId,
          projectPath,
          cwd,
          kind: 'durable',
          model: config.model,
          mission,
          orchestrator: config.orchestrator,
          freeAgentMode: config.freeAgentMode,
          resume,
          sessionId: resume ? config.lastSessionId : undefined,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to launch agent';
        set((s) => {
          if (!s.agents[agentId]) return s;
          return {
            agents: { ...s.agents, [agentId]: { ...s.agents[agentId], status: 'error', errorMessage } },
          };
        });
        throw err;
      }

      return agentId;
    },

    killAgent: async (id, projectPath) => {
      const agent = get().agents[id];
      if (!agent) return;

      // Mark as user-cancelled so exit handler can distinguish from natural completion
      if (agent.kind === 'quick') {
        set((s) => ({ cancelledAgentIds: { ...s.cancelledAgentIds, [id]: true as const } }));
      }

      // Resolve projectPath from agent if not provided
      const resolvedPath =
        projectPath ||
        (() => {
          const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
          return project?.path;
        })();

      if (resolvedPath) {
        await window.clubhouse.agent.killAgent(id, resolvedPath);
      } else {
        // Last resort fallback
        await window.clubhouse.pty.kill(id);
      }

      const newStatus = 'sleeping' as const;
      set((s) => {
        const { [id]: _, ...restStatus } = s.agentDetailedStatus;
        const agentTerminalAt =
          agent.kind === 'quick' && !(id in s.agentTerminalAt)
            ? { ...s.agentTerminalAt, [id]: Date.now() }
            : s.agentTerminalAt;

        return {
          agents: { ...s.agents, [id]: { ...s.agents[id], status: newStatus } },
          agentDetailedStatus: restStatus,
          agentTerminalAt,
        };
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

    registerCreatingAgent: (projectId, name, color, orchestrator, freeAgentMode) => {
      const tempId = `creating_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const agent: Agent = {
        id: tempId,
        projectId,
        name,
        kind: 'durable',
        status: 'creating',
        color,
        orchestrator: orchestrator || undefined,
        freeAgentMode: freeAgentMode || undefined,
      };
      set((s) => ({
        agents: { ...s.agents, [tempId]: agent },
        activeAgentId: tempId,
        projectActiveAgent: { ...s.projectActiveAgent, [projectId]: tempId },
      }));
      return tempId;
    },

    clearResuming: (id) => {
      set((s) => {
        const agent = s.agents[id];
        if (!agent || !agent.resuming) return s;
        return { agents: { ...s.agents, [id]: { ...agent, resuming: undefined } } };
      });
    },

    executeDelete: async (mode, projectPath) => {
      const agentId = get().deleteDialogAgent;
      if (!agentId) return { ok: false, message: 'No agent selected' };

      const agent = get().agents[agentId];

      // Kill and remove any child quick agents before deleting a durable parent
      if (agent?.kind === 'durable') {
        const children = Object.values(get().agents).filter(
          (a) => a.kind === 'quick' && a.parentAgentId === agentId,
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
  };
}
