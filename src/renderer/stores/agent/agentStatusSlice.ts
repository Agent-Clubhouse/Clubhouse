import { AgentDetailedStatus } from '../../../shared/types';
import { AgentState, AgentStatusSlice, GetAgentState, SetAgentState } from './types';
import {
  omitRecordKey,
  omitRecordKeys,
  STALE_THRESHOLD_MS,
  COMPLETED_QUICK_AGENT_RETENTION_MS,
  MAX_COMPLETED_QUICK_AGENTS,
  ACTIVITY_UPDATE_THROTTLE_MS,
  MAX_ACTIVITY_ENTRIES,
  protectedAgentIds,
  removeAgentsFromState,
} from './agentUtils';
import { pendingActivityTimers, clearPendingActivityTimer, clearPendingActivityTimers } from './activityTimers';

export function createStatusSlice(set: SetAgentState, get: GetAgentState): AgentStatusSlice {
  const commitActivity = (id: string, timestamp: number) => {
    set((s) => {
      if (!s.agents[id]) return s;
      const previous = s.agentActivity[id];
      if (previous !== undefined && timestamp <= previous) return s;
      return {
        agentActivity: { ...s.agentActivity, [id]: timestamp },
      };
    });
  };

  return {
    agentActivity: {},
    agentSpawnedAt: {},
    agentTerminalAt: {},
    agentDetailedStatus: {},

    updateAgentStatus: (id, status, exitCode, errorMessage, lastOutput?) => {
      set((s) => {
        const agent = s.agents[id];
        if (!agent) return s;

        let finalStatus = status;
        let resolvedErrorMessage = errorMessage;
        if (status === 'sleeping' && agent.kind === 'durable') {
          // If the agent exited within 3 seconds of spawning, treat as error (likely launch failure)
          const spawnedAt = s.agentSpawnedAt[id];
          if (spawnedAt && Date.now() - spawnedAt < 3000) {
            finalStatus = 'error';
            if (!resolvedErrorMessage) {
              // Extract meaningful diagnostic from PTY output (strip ANSI codes)
              const cleanOutput = lastOutput
                // eslint-disable-next-line no-control-regex
                ?.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
                .trim()
                .split('\n')
                .filter((l) => l.trim().length > 0)
                .slice(-3)
                .join(' | ');

              if (cleanOutput) {
                resolvedErrorMessage = cleanOutput.slice(0, 200);
              } else {
                resolvedErrorMessage =
                  exitCode != null && exitCode !== 0
                    ? `Agent process exited immediately (code ${exitCode})`
                    : 'Agent process exited immediately after launch';
              }
            }
          }
        }

        // Clear detailed status when agent stops
        const { [id]: _, ...restStatus } = s.agentDetailedStatus;
        let agentTerminalAt = s.agentTerminalAt;

        if (finalStatus === 'running' || agent.kind !== 'quick') {
          agentTerminalAt = omitRecordKey(agentTerminalAt, id);
        } else if (finalStatus === 'sleeping' && !(id in agentTerminalAt)) {
          agentTerminalAt = { ...agentTerminalAt, [id]: Date.now() };
        } else if (finalStatus !== 'sleeping') {
          agentTerminalAt = omitRecordKey(agentTerminalAt, id);
        }

        return {
          agents: {
            ...s.agents,
            [id]: {
              ...agent,
              status: finalStatus,
              exitCode,
              errorMessage: finalStatus === 'error' ? resolvedErrorMessage : undefined,
            },
          },
          agentTerminalAt,
          agentDetailedStatus: finalStatus !== 'running' ? restStatus : s.agentDetailedStatus,
        };
      });
    },

    handleHookEvent: (agentId, event) => {
      const agent = get().agents[agentId];
      if (!agent) return;

      // If a sleeping/error agent sends a non-stop hook event, it was woken
      // externally (e.g. via annex). Transition to 'running' so the store
      // reflects the actual PTY state.
      if (agent.status !== 'running') {
        if (event.kind === 'stop') return;
        set((s) => {
          const a = s.agents[agentId];
          if (!a) return s;
          return {
            agents: {
              ...s.agents,
              [agentId]: { ...a, status: 'running', exitCode: undefined, errorMessage: undefined },
            },
            agentSpawnedAt: { ...s.agentSpawnedAt, [agentId]: Date.now() },
            agentTerminalAt: omitRecordKey(s.agentTerminalAt, agentId),
          };
        });
      }

      // Guard: don't let non-actionable events overwrite a pending permission
      // state. Only pre_tool (permission granted, tool executing), a new
      // permission_request, or permission_resolved (decision sent back to
      // the agent) should clear the needs_permission state.
      const currentState = get().agentDetailedStatus[agentId]?.state;
      if (currentState === 'needs_permission') {
        if (event.kind !== 'pre_tool' && event.kind !== 'permission_request' && event.kind !== 'permission_resolved') {
          return;
        }
      }

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
            state: 'idle',
            message: event.message || 'Notification',
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
        case 'permission_resolved':
          detailed = {
            state: 'idle',
            message: 'Thinking',
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

    /** Periodic cleanup for stale detailed statuses and lingering completed quick agents */
    clearStaleStatuses: () => {
      const prunedQuickIds = new Set<string>();
      set((state) => {
        const now = Date.now();
        let workingState = state;
        const statuses = state.agentDetailedStatus;
        let changed = false;
        let updated = statuses;

        for (const [agentId, status] of Object.entries(statuses)) {
          const agent = state.agents[agentId];
          if (!agent || agent.status !== 'running') continue;

          const age = now - status.timestamp;
          // Permission states shouldn't auto-clear — agent is waiting for user
          if (status.state === 'needs_permission') continue;
          if (age > STALE_THRESHOLD_MS) {
            if (updated === statuses) {
              updated = { ...statuses };
            }
            delete updated[agentId];
            changed = true;
          }
        }

        if (changed) {
          workingState = { ...state, agentDetailedStatus: updated };
        }

        const protectedIdsSet = protectedAgentIds(workingState);
        const completedQuickAgents = Object.values(workingState.agents)
          .filter(
            (agent) => agent.kind === 'quick' && agent.status === 'sleeping' && !protectedIdsSet.has(agent.id),
          )
          .map((agent) => ({
            id: agent.id,
            terminalAt: workingState.agentTerminalAt[agent.id] ?? workingState.agentSpawnedAt[agent.id] ?? 0,
          }))
          .sort((left, right) => right.terminalAt - left.terminalAt);

        const quickIdsToRemove = new Set<string>();
        for (const agent of completedQuickAgents) {
          if (agent.terminalAt > 0 && now - agent.terminalAt > COMPLETED_QUICK_AGENT_RETENTION_MS) {
            quickIdsToRemove.add(agent.id);
          }
        }

        for (const agent of completedQuickAgents.slice(MAX_COMPLETED_QUICK_AGENTS)) {
          quickIdsToRemove.add(agent.id);
        }

        let result: Partial<AgentState>;
        if (quickIdsToRemove.size === 0) {
          result = changed ? { agentDetailedStatus: updated } : {};
        } else {
          for (const agentId of quickIdsToRemove) {
            prunedQuickIds.add(agentId);
          }
          result = removeAgentsFromState(workingState, quickIdsToRemove) as Partial<AgentState>;
        }

        // Phase 3: Evict orphaned activity/spawn/terminal entries for agents
        // that no longer exist, and cap agentActivity at MAX_ACTIVITY_ENTRIES.
        const currentAgents = result.agents ?? state.agents;
        const currentAgentIds = new Set(Object.keys(currentAgents));

        const currentActivity = result.agentActivity ?? state.agentActivity;
        const currentSpawnedAt = result.agentSpawnedAt ?? state.agentSpawnedAt;
        const currentTerminalAt = result.agentTerminalAt ?? state.agentTerminalAt;

        // Find orphaned IDs across all three maps
        const orphanedIds = new Set<string>();
        for (const id of Object.keys(currentActivity)) {
          if (!currentAgentIds.has(id)) orphanedIds.add(id);
        }
        for (const id of Object.keys(currentSpawnedAt)) {
          if (!currentAgentIds.has(id)) orphanedIds.add(id);
        }
        for (const id of Object.keys(currentTerminalAt)) {
          if (!currentAgentIds.has(id)) orphanedIds.add(id);
        }

        if (orphanedIds.size > 0) {
          result.agentActivity = omitRecordKeys(currentActivity, orphanedIds);
          result.agentSpawnedAt = omitRecordKeys(currentSpawnedAt, orphanedIds);
          result.agentTerminalAt = omitRecordKeys(currentTerminalAt, orphanedIds);
          for (const id of orphanedIds) prunedQuickIds.add(id);
        }

        // Cap agentActivity at MAX_ACTIVITY_ENTRIES (LRU by timestamp)
        const activity = result.agentActivity ?? currentActivity;
        const activityKeys = Object.keys(activity);
        if (activityKeys.length > MAX_ACTIVITY_ENTRIES) {
          const sorted = activityKeys.sort((a, b) => (activity[b] ?? 0) - (activity[a] ?? 0));
          const toEvict = new Set(sorted.slice(MAX_ACTIVITY_ENTRIES));
          result.agentActivity = omitRecordKeys(activity, toEvict);
        }

        return Object.keys(result).length > 0 ? result : state;
      });
      clearPendingActivityTimers(prunedQuickIds);
    },

    recordActivity: (id) => {
      const state = get();
      if (!state.agents[id]) {
        clearPendingActivityTimer(id);
        return;
      }

      const now = Date.now();
      const last = state.agentActivity[id] ?? 0;
      const elapsed = now - last;

      if (elapsed >= ACTIVITY_UPDATE_THROTTLE_MS) {
        clearPendingActivityTimer(id);
        commitActivity(id, now);
        return;
      }

      if (pendingActivityTimers.has(id)) {
        return;
      }

      const delay = ACTIVITY_UPDATE_THROTTLE_MS - elapsed;
      const timer = setTimeout(() => {
        pendingActivityTimers.delete(id);
        commitActivity(id, Date.now());
      }, delay);
      pendingActivityTimers.set(id, timer);
    },

    isAgentActive: (id) => {
      const last = get().agentActivity[id];
      if (!last) return false;
      return Date.now() - last < 3000;
    },
  };
}
