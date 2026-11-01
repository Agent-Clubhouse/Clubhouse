import { Agent, DeleteResult, HelperCascadeResult, HelperDisposeBlock, HelperInProject } from '../../../shared/types';
import { generateQuickAgentId } from '../../../shared/agent-id';
import { generateQuickName } from '../../../shared/name-generator';
import { expandTemplate, AgentContext } from '../../../shared/template-engine';
import { useHeadlessStore } from '../headlessStore';
import { findLocalProject, isDispatcherAgent } from '../../features/dispatcher/dispatcherStore';
import { AgentLifecycleSlice, GetAgentState, SetAgentState } from './types';
import { omitRecordKey } from './agentUtils';
import { parentLinkFields } from './parentLink';

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

    spawnQuickAgent: async (projectId, projectPath, mission, model, parentAgentId, orchestrator, freeAgentMode, pluginMetadata, cwdOverride) => {
      const agentId = generateQuickAgentId();
      const name = generateQuickName();

      // Resolve CWD: an explicit override (retry in the same worktree) wins,
      // else the parent durable's worktree, else the project root.
      let cwd = projectPath;
      if (cwdOverride) {
        cwd = cwdOverride;
      } else if (parentAgentId) {
        const parent = get().agents[parentAgentId];
        if (parent?.worktreePath) {
          cwd = parent.worktreePath;
        }
      }

      // Best-effort base commit so the run's diff can be measured later.
      // Started now, before the agent can commit; never blocks or fails the spawn.
      let baseShaPromise: Promise<string | null | undefined>;
      try {
        baseShaPromise = Promise.resolve(window.clubhouse.git?.headSha?.(cwd)).catch((): undefined => undefined);
      } catch {
        baseShaPromise = Promise.resolve(undefined);
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
        status: 'spawning',
        color: 'gray',
        mission,
        model: resolvedModel,
        parentAgentId,
        orchestrator: resolvedOrchestrator,
        headless: isHeadless || undefined,
        freeAgentMode: resolvedFreeAgentMode || undefined,
        pluginMetadata,
        runCwd: cwd,
      };

      set((s) => ({
        agents: { ...s.agents, [agentId]: agent },
        activeAgentId: agentId,
        agentSpawnedAt: { ...s.agentSpawnedAt, [agentId]: Date.now() },
        agentLaunchFailure: omitRecordKey(s.agentLaunchFailure, agentId),
        projectActiveAgent: { ...s.projectActiveAgent, [projectId]: agentId },
      }));

      void baseShaPromise.then((sha) => {
        if (typeof sha !== 'string' || !sha) return;
        set((s) => {
          const current = s.agents[agentId];
          if (!current) return s;
          return { agents: { ...s.agents, [agentId]: { ...current, runBaseSha: sha } } };
        });
      });

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

        set((s) => {
          if (!s.agents[agentId]) return s;
          return {
            agents: { ...s.agents, [agentId]: { ...s.agents[agentId], status: 'running' } },
          };
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
      // A disposed helper (#2224) keeps its row but has no worktree to run in.
      if (config.disposedAt) throw new Error(`${config.name} was disposed and can't be started`);

      const agent: Agent = {
        id: agentId,
        projectId,
        name: config.name,
        kind: 'durable',
        status: 'spawning',
        color: config.color,
        icon: config.icon,
        worktreePath: config.worktreePath,
        branch: config.branch,
        exitCode: undefined,
        mission,
        // Carry the durable config's model through — this object REPLACES the
        // store entry, so omitting it wipes the agent's configured model on
        // every wake (settings + list badge fall back to "Default").
        model: config.model,
        orchestrator: config.orchestrator,
        freeAgentMode: config.freeAgentMode || undefined,
        mcpIds: config.mcpIds,
        resuming: resume || undefined,
        // Also config-only, and replaced with the rest: a helper keeps its
        // parent (#2224) so the sidebar keeps it nested after a wake (#2231).
        ...parentLinkFields(config),
        creationFailed: config.creation?.state === 'failed' || undefined,
      };

      set((s) => ({
        agents: { ...s.agents, [agentId]: agent },
        // The Dispatcher has its own view (#2563): it doesn't take the active
        // project's agent, which closing its view goes back to.
        activeAgentId: isDispatcherAgent({ id: agentId, projectId }) ? s.activeAgentId : agentId,
        agentSpawnedAt: { ...s.agentSpawnedAt, [agentId]: Date.now() },
        agentLaunchFailure: omitRecordKey(s.agentLaunchFailure, agentId),
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

        set((s) => {
          const current = s.agents[agentId];
          // Only a start still in progress becomes running here. One that was
          // killed while main was starting it (a chat start cancelled mid-load)
          // has already exited and been marked sleeping; keep it that way (#2087).
          if (!current || (current.status !== 'spawning' && current.status !== 'waking')) return s;
          return {
            agents: { ...s.agents, [agentId]: { ...current, status: 'running' } },
          };
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

    killAgent: async (id, projectPath, opts) => {
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
          return findLocalProject(agent.projectId)?.path;
        })();

      if (resolvedPath) {
        await window.clubhouse.agent.killAgent(id, resolvedPath, opts?.waitForExit);
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

    executeDelete: async (mode, projectPath, helperChoice) => {
      const agentId = get().deleteDialogAgent;
      if (!agentId) return { ok: false, message: 'No agent selected' };

      const agent = get().agents[agentId];

      // Settle helpers first so none is left pointing at a deleted parent (#2224).
      if (agent?.kind === 'durable') {
        const helpers = await listLiveHelpers(projectPath, agentId);
        if (helpers.length > 0) {
          if (!helperChoice) {
            return { ok: false, message: `Choose what happens to ${agent.name}'s helpers` };
          }
          // Run the checks right before stopping anything: a helper that
          // would block the dispose keeps running.
          const preview: HelperCascadeResult = await window.clubhouse.agent.resolveHelpersForDelete(projectPath, agentId, helperChoice, true);
          if (!preview.ok) return { ok: false, message: describeHelperBlock(preview) };
          if (helperChoice === 'dispose') {
            for (const helper of helpers) {
              if (get().agents[helper.config.id]?.status === 'running') {
                // Wait for the process to exit so it no longer holds the
                // worktree folder open (EBUSY on Windows). A helper can be in
                // another project (#2514), so it stops under its own.
                await window.clubhouse.agent.killAgent(helper.config.id, helper.projectPath, true);
              }
            }
          }
          // Main checks again before it removes anything.
          const resolved: HelperCascadeResult = await window.clubhouse.agent.resolveHelpersForDelete(projectPath, agentId, helperChoice);
          // A disposed helper keeps its config row but leaves the rail, even
          // when another helper's disposal failed.
          if (helperChoice === 'dispose') {
            for (const helperId of resolved.helperIds ?? []) get().removeAgent(helperId);
          }
          // The orchestrator stays unless every helper was settled.
          if (!resolved.ok) return { ok: false, message: describeHelperBlock(resolved) };
        }
      }

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

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Past this, an exact count says nothing more (a branch with its whole history unpushed). */
const MAX_LISTED_COMMITS = 99;

function describeBlock(block: HelperDisposeBlock): string {
  const parts: string[] = [];
  if (block.checks.error) parts.push(block.checks.error);
  if (block.checks.dirty > 0) parts.push(plural(block.checks.dirty, 'uncommitted file', 'uncommitted files'));
  if (block.checks.unpushed > MAX_LISTED_COMMITS) parts.push(`more than ${MAX_LISTED_COMMITS} unpushed commits`);
  else if (block.checks.unpushed > 0) parts.push(plural(block.checks.unpushed, 'unpushed commit', 'unpushed commits'));
  return `${block.name} (${parts.join(', ')})`;
}

function joinNames(names: string[]): string {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The delete error when helpers blocked the dispose, or some failed part way. */
export function describeHelperBlock(result: HelperCascadeResult): string {
  if (result.failed && result.failed.length > 0) {
    const done = result.helperIds?.length ?? 0;
    const failed = joinNames(result.failed.map((f) => `${f.name} (${f.reason})`));
    return `Disposed ${plural(done, 'helper', 'helpers')}, but couldn't dispose ${failed}, so the orchestrator was not deleted.`;
  }
  if (!result.blocked || result.blocked.length === 0) return result.message;
  const list = joinNames(result.blocked.map(describeBlock));
  return `Nothing was deleted. Disposing would lose work in ${list}. Keep the helpers, or commit and push their work first.`;
}

/**
 * The live helpers of a durable agent (#2224) in every project (#2514), each
 * with the project it is in: every one below it, or only its direct helpers
 * with `recursive` false. A failed lookup reads as none: main then keeps any
 * helpers as ordinary agents when the parent goes.
 */
export async function listLiveHelpers(projectPath: string, agentId: string, recursive = true): Promise<HelperInProject[]> {
  try {
    const helpers = await window.clubhouse.agent.listHelpers(projectPath, agentId, recursive);
    return Array.isArray(helpers) ? helpers : [];
  } catch {
    // telemetry-exempt: main keeps helpers as ordinary agents when this lookup fails
    return [];
  }
}
