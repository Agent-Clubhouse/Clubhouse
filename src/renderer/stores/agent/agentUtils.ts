import { AgentState } from './types';

/** Detailed statuses older than this are considered stale and cleared */
export const STALE_THRESHOLD_MS = 30_000;
/** Keep a small backstop of completed quick agents in-memory before pruning */
export const COMPLETED_QUICK_AGENT_RETENTION_MS = 60_000;
export const MAX_COMPLETED_QUICK_AGENTS = 20;
export const ACTIVITY_UPDATE_THROTTLE_MS = 100;

export function omitRecordKeys<T>(record: Record<string, T>, ids: Set<string>): Record<string, T> {
  if (ids.size === 0) return record;

  let changed = false;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ids.has(key)) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return changed ? next : record;
}

export function omitRecordKey<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!(id in record)) return record;
  const { [id]: _removed, ...rest } = record;
  return rest;
}

export function protectedAgentIds(
  state: Pick<
    AgentState,
    | 'activeAgentId'
    | 'agentSettingsOpenFor'
    | 'deleteDialogAgent'
    | 'configChangesDialogAgent'
    | 'sessionNamePromptFor'
  >,
): Set<string> {
  const ids = [
    state.activeAgentId,
    state.agentSettingsOpenFor,
    state.deleteDialogAgent,
    state.configChangesDialogAgent,
    state.sessionNamePromptFor,
  ].filter((id): id is string => Boolean(id));

  return new Set(ids);
}

export function removeAgentsFromState(
  state: AgentState,
  idsToRemove: Iterable<string>,
): Partial<AgentState> | AgentState {
  const ids = new Set(idsToRemove);
  if (ids.size === 0) return state;

  const agents = omitRecordKeys(state.agents, ids);
  const agentActivity = omitRecordKeys(state.agentActivity, ids);
  const agentSpawnedAt = omitRecordKeys(state.agentSpawnedAt, ids);
  const agentTerminalAt = omitRecordKeys(state.agentTerminalAt, ids);
  const agentDetailedStatus = omitRecordKeys(state.agentDetailedStatus, ids);
  const cancelledAgentIds = omitRecordKeys(state.cancelledAgentIds, ids);
  const agentIcons = omitRecordKeys(state.agentIcons, ids);

  let projectActiveAgent = state.projectActiveAgent;
  for (const agentId of Object.values(state.projectActiveAgent)) {
    if (agentId && ids.has(agentId)) {
      projectActiveAgent = Object.fromEntries(
        Object.entries(state.projectActiveAgent).filter(([, currentId]) => !currentId || !ids.has(currentId)),
      );
      break;
    }
  }

  const activeAgentId = state.activeAgentId && ids.has(state.activeAgentId) ? null : state.activeAgentId;
  const agentSettingsOpenFor =
    state.agentSettingsOpenFor && ids.has(state.agentSettingsOpenFor) ? null : state.agentSettingsOpenFor;
  const deleteDialogAgent =
    state.deleteDialogAgent && ids.has(state.deleteDialogAgent) ? null : state.deleteDialogAgent;
  const clearConfigDialog = state.configChangesDialogAgent && ids.has(state.configChangesDialogAgent);
  const configChangesDialogAgent = clearConfigDialog ? null : state.configChangesDialogAgent;
  const configChangesProjectPath = clearConfigDialog ? null : state.configChangesProjectPath;
  const sessionNamePromptFor =
    state.sessionNamePromptFor && ids.has(state.sessionNamePromptFor) ? null : state.sessionNamePromptFor;

  return {
    agents,
    activeAgentId,
    agentSettingsOpenFor,
    deleteDialogAgent,
    configChangesDialogAgent,
    configChangesProjectPath,
    agentActivity,
    agentSpawnedAt,
    agentTerminalAt,
    agentDetailedStatus,
    cancelledAgentIds,
    projectActiveAgent,
    agentIcons,
    sessionNamePromptFor,
  };
}
