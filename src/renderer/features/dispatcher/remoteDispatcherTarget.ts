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

/**
 * The one lookup for a click on another computer's Dispatcher, the same from
 * either side. A computer is known by its fingerprint. Whether this computer
 * holds a connection to it, and its snapshot, depends on which side paired and
 * connected, so the answer can never be "do nothing": without a chat, the
 * target is its details.
 */
export function resolveRemoteDispatcherTarget(machineId: string, satellites: readonly Peer[], leadMachine?: string | null): RemoteDispatcherTarget {
  const machine = machineId.toLowerCase();
  if (leadMachine && leadMachine.toLowerCase() === machine) return { kind: 'lead' };
  const satellite = satellites.find((sat) => sat.fingerprint.toLowerCase() === machine);
  const chat = satellite?.snapshot?.dispatcher?.agent;
  if (!satellite || !chat?.id) return { kind: 'details' };
  const agentId = namespacedAgentId(satellite.id, chat.id);
  return { kind: 'chat', agentId, chat: { ...chat, id: agentId, projectId: namespacedProjectId(satellite.id, chat.projectId || DISPATCHER_PROJECT_ID) } };
}
