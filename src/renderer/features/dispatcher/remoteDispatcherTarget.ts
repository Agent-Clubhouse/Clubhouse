import { namespacedAgentId, namespacedProjectId } from '../../stores/remoteProjectStore';
import { DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import type { Agent, SatelliteConnection } from '../../../shared/types';

/** What opening another computer's Dispatcher shows on this one. */
export type RemoteDispatcherTarget =
  /** This computer follows that computer's lead: its chat in the follower view. */
  | { kind: 'lead' }
  /** Its chat, which this computer has from that computer's snapshot, under this computer's namespaced ids. */
  | { kind: 'chat'; agentId: string; chat: Agent }
  /** No chat here yet (not connected from this side, or its Dispatcher is off): its status instead. */
  | { kind: 'details' };

type Peer = Pick<SatelliteConnection, 'id' | 'fingerprint' | 'snapshot'>;

/** Its chat from this computer's snapshot of that machine, under this computer's namespaced ids; whatever the target is. */
export function remoteDispatcherChat(machineId: string, satellites: readonly Peer[]): Agent | null {
  const machine = machineId.toLowerCase();
  const satellite = satellites.find((sat) => sat.fingerprint.toLowerCase() === machine);
  const chat = satellite?.snapshot?.dispatcher?.agent;
  if (!satellite || !chat?.id) return null;
  return { ...chat, id: namespacedAgentId(satellite.id, chat.id), projectId: namespacedProjectId(satellite.id, chat.projectId || DISPATCHER_PROJECT_ID) };
}

/**
 * The one lookup for a click on another computer's Dispatcher, the same from
 * either side. A computer is known by its fingerprint. Whether this computer
 * holds a connection to it, and its snapshot, depends on which side paired and
 * connected, so the answer can never be "do nothing": without a chat, the
 * target is its details.
 */
export function resolveRemoteDispatcherTarget(machineId: string, satellites: readonly Peer[], leadMachine?: string | null): RemoteDispatcherTarget {
  if (leadMachine && leadMachine.toLowerCase() === machineId.toLowerCase()) return { kind: 'lead' };
  const chat = remoteDispatcherChat(machineId, satellites);
  return chat ? { kind: 'chat', agentId: chat.id, chat } : { kind: 'details' };
}
