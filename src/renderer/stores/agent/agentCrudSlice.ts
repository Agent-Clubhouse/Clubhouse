import { Agent, DurableAgentConfig } from '../../../shared/types';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import { AgentCrudSlice, GetAgentState, SetAgentState } from './types';
import { removeAgentsFromState } from './agentUtils';
import { clearPendingActivityTimer } from './activityTimers';
import { parentLinkFields } from './parentLink';

/** A loaded durable agent's status: creating or failed while its creation is unfinished (#2226), else asleep. */
function creationStatus(config: DurableAgentConfig): Pick<Agent, 'status' | 'errorMessage' | 'creationFailed'> {
  if (config.creation?.state === 'creating') return { status: 'creating', creationFailed: undefined };
  if (config.creation?.state === 'failed') return { status: 'error', errorMessage: config.creation.reason, creationFailed: true };
  return { status: 'sleeping', creationFailed: undefined };
}

export function createCrudSlice(set: SetAgentState, get: GetAgentState): AgentCrudSlice {
  return {
    agents: {},
    pendingRecovery: null,

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
        if (updates.emoji !== undefined) {
          patched.emoji = updates.emoji === null ? undefined : updates.emoji;
          // Emoji and image icon are mutually exclusive
          if (patched.emoji) {
            patched.icon = undefined;
          }
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
      const allConfigs: DurableAgentConfig[] = await window.clubhouse.agent.listDurable(projectPath);
      const agents = { ...get().agents };
      // A disposed helper (#2224) keeps its config row but has no worktree and
      // can't run, so the rail skips it.
      for (const config of allConfigs) {
        if (isDisposedAgent(config) && agents[config.id]?.kind === 'durable') delete agents[config.id];
      }
      const configs = allConfigs.filter((config) => !isDisposedAgent(config));

      for (const config of configs) {
        if (!agents[config.id]) {
          agents[config.id] = {
            id: config.id,
            projectId,
            name: config.name,
            kind: 'durable',
            ...creationStatus(config),
            color: config.color,
            icon: config.icon,
            worktreePath: config.worktreePath,
            branch: config.branch,
            model: config.model,
            orchestrator: config.orchestrator,
            freeAgentMode: config.freeAgentMode,
            mcpIds: config.mcpIds,
            lastSleep: config.lastSleep,
            ...parentLinkFields(config),
          };
        } else {
          // Always update projectId — the same agents.json may be loaded
          // under a different project store ID when a project is re-added
          // or when multiple store entries share the same path. Distinct
          // project directories never share an ID: the main process
          // reassigns a durable ID already loaded by another project.
          // Re-hydrate `model` too: agents.json is the source of truth for it,
          // and a store entry that lost the value (e.g. rebuilt on spawn) would
          // otherwise stay stale for the lifetime of the window.
          // The parent link (#2224) is config-only, so it follows agents.json too.
          agents[config.id] = {
            ...agents[config.id], projectId, model: config.model, lastSleep: agents[config.id].lastSleep ?? config.lastSleep,
            ...parentLinkFields(config),
          };
          // An unfinished creation (#2226) is ground truth for status; a finished
          // one moves an agent still shown as creating or failed to asleep, and
          // drops the failed mark.
          const existing = agents[config.id];
          if (config.creation || existing.status === 'creating' || existing.creationFailed) {
            agents[config.id] = {
              ...existing,
              ...creationStatus(config),
              ...(config.creation ? {} : { errorMessage: undefined }),
              worktreePath: config.worktreePath,
              branch: config.branch,
            };
          }
        }
      }

      set({ agents });

      // Reconcile status against the main process's live sessions. Durable
      // agents load as 'sleeping' (above), but their PTY/headless/structured
      // sessions outlive the renderer window — on a window reopen the freshly
      // loaded store would otherwise show genuinely-running agents as 'asleep'
      // until the next poll tick or hook event. Upgrade 'sleeping' → 'running'
      // for any loaded agent the main process reports as live (mirrors the
      // remote-agent reconciliation in remoteProjectStore). Upgrade only —
      // downgrades are left to the stale-status tick and hook events.
      try {
        const runningIds: string[] = await window.clubhouse.agent.getRunningStatuses(
          configs.map((config) => config.id),
        );
        if (runningIds.length > 0) {
          set((s) => {
            let changed = false;
            const next = { ...s.agents };
            for (const id of runningIds) {
              const agent = next[id];
              if (agent && agent.status === 'sleeping') {
                next[id] = { ...agent, status: 'running' };
                changed = true;
              }
            }
            return changed ? { agents: next } : s;
          });
        }
      } catch {
        // Non-fatal — status self-corrects on the next poll tick / hook event.
      }

      // Load icons for agents that have them (in parallel)
      await Promise.all(
        configs
          .filter((config) => config.icon && agents[config.id])
          .map((config) => get().loadAgentIcon(agents[config.id])),
      );

      // Check if the backup has more agents — offer recovery if so
      try {
        const backupInfo = await window.clubhouse.agent.getBackupInfo(projectPath) as
          { backupAgents: DurableAgentConfig[]; currentCount: number } | null;
        if (backupInfo && backupInfo.backupAgents.length > allConfigs.length) {
          const currentIds = new Set(allConfigs.map((c: DurableAgentConfig) => c.id));
          const missing = backupInfo.backupAgents.filter((a: DurableAgentConfig) => !currentIds.has(a.id));
          if (missing.length > 0) {
            set({
              pendingRecovery: {
                backupAgentCount: backupInfo.backupAgents.length,
                currentCount: allConfigs.length,
                missingNames: missing.map((a: DurableAgentConfig) => a.name),
                projectId,
                projectPath,
              },
            });
          }
        }
      } catch {
        // Non-fatal — recovery check failed
      }
    },

    restoreFromBackup: async (projectId, projectPath) => {
      const result = await window.clubhouse.agent.restoreFromBackup(projectPath);
      if (result.restoredCount > 0) {
        // Reload agents into store
        const configs: DurableAgentConfig[] = await window.clubhouse.agent.listDurable(projectPath);
        const agents = { ...get().agents };
        for (const config of configs) {
          if (!agents[config.id] && !isDisposedAgent(config)) {
            agents[config.id] = {
              id: config.id,
              projectId,
              name: config.name,
              kind: 'durable',
              ...creationStatus(config),
              color: config.color,
              icon: config.icon,
              worktreePath: config.worktreePath,
              branch: config.branch,
              model: config.model,
              orchestrator: config.orchestrator,
              freeAgentMode: config.freeAgentMode,
              mcpIds: config.mcpIds,
              ...parentLinkFields(config),
            };
          }
        }
        set({ agents, pendingRecovery: null });
      }
      return result.restoredCount;
    },

    dismissRecovery: () => {
      set({ pendingRecovery: null });
    },
  };
}
