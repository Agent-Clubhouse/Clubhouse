import type { AgentInfo, PluginAgentDetailedStatus } from '../../../../shared/plugin-types';
import { isRemoteAgentId } from './host';

export function filterAgents(agents: AgentInfo[], includeSleeping: boolean): AgentInfo[] {
  if (includeSleeping) return agents;
  return agents.filter((a) => a.status !== 'sleeping');
}

export function filterNeedsAttention(
  agents: AgentInfo[],
  detailedStatuses: Map<string, PluginAgentDetailedStatus | null>,
): AgentInfo[] {
  return agents.filter((a) => {
    if (a.status === 'error') return true;
    const d = detailedStatuses.get(a.id);
    return d?.state === 'needs_permission' || d?.state === 'tool_error';
  });
}

export function filterRemoteAgents(agents: AgentInfo[], includeRemote: boolean): AgentInfo[] {
  if (includeRemote) return agents;
  return agents.filter((a) => !isRemoteAgentId(a.id));
}

export function resolveIndex(current: number, length: number, delta: -1 | 1): number {
  if (length === 0) return 0;
  return (current + delta + length) % length;
}

/**
 * Synchronously clamp an index into the bounds of a list of given length.
 * Used by MainPanel so that a render which happens *between* the agent list
 * shrinking and the clamp `useEffect` running cannot read past the array end.
 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}
