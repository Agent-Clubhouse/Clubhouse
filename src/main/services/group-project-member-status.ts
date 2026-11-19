/** Runtime observations shared by roster answers and network snapshots. */
import * as ptyManager from './pty-manager';
import { agentRegistry } from './agent-registry';
import { getAgentRuntime } from './agent-runtime';
import type { RosterStatus } from '../../shared/group-project-roster';

export function localMemberObservation(agentId: string): { status: RosterStatus; lastSeen: string } {
  const runtime = getAgentRuntime(agentId);
  const state = runtime?.kind === 'chat' ? runtime.getState() : undefined;
  const busy = state === 'running' || state === 'waiting_permission' || state === 'waiting_input';
  return { status: busy ? 'busy' : (ptyManager.isRunning(agentId) || agentRegistry.get(agentId) !== undefined) ? 'awake' : 'asleep', lastSeen: new Date().toISOString() };
}

/** Older snapshots have no observation time; malformed remote fields are not evidence. */
export function remoteMemberObservation(seen?: { runtimeStatus?: unknown; lastSeen?: unknown }): { status: RosterStatus; lastSeen?: string } {
  if (!seen || typeof seen.lastSeen !== 'string' || seen.lastSeen.length > 40 || Number.isNaN(Date.parse(seen.lastSeen))
    || !['awake', 'busy', 'asleep', 'unknown'].includes(seen.runtimeStatus as string)) return { status: 'unknown' };
  return { status: seen.runtimeStatus as RosterStatus, lastSeen: seen.lastSeen };
}
