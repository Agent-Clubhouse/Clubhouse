/**
 * Linked project state replicates between member desktops over the shared
 * pinned-member REST sync (replica-network.ts), beside project links.
 */
import {
  LINKED_PROJECT_STATE_CAPABILITIES_PATH, LINKED_PROJECT_STATE_MAX_RECORDS, LINKED_PROJECT_STATE_PAGE_SIZE, LINKED_PROJECT_STATE_SYNC_PATH,
  linkedStateRecordKey, parseIncomingLinkedStateRecords, parseLinkedStateRecords, type LinkedProjectStateRecord,
} from '../../shared/linked-project-state';
import { linkedProjectStateStore, type LinkedProjectStateStore } from './linked-project-state-store';
import { receiveReplica, replicaCapabilities, startReplicaNetwork, type ReplicaNetworkOptions, type ReplicaSpec } from './replica-network';

export const LINKED_PROJECT_STATE_REPLICA: ReplicaSpec<LinkedProjectStateRecord> = {
  noun: 'linked project state', plural: 'linked project state',
  capabilitiesPath: LINKED_PROJECT_STATE_CAPABILITIES_PATH, syncPath: LINKED_PROJECT_STATE_SYNC_PATH,
  pageSize: LINKED_PROJECT_STATE_PAGE_SIZE, maxRecords: LINKED_PROJECT_STATE_MAX_RECORDS,
  parse: parseLinkedStateRecords,
  parseIncoming: (raw, max) => parseIncomingLinkedStateRecords(raw, max),
  keyOf: linkedStateRecordKey,
};
export const linkedProjectStateCapabilities = () => replicaCapabilities(LINKED_PROJECT_STATE_REPLICA);

/** Called only after annex-server authenticates a currently pinned member desktop. */
export function receiveLinkedProjectState(source: string, raw: unknown, current: () => boolean, store = linkedProjectStateStore()): Promise<Record<string, unknown>> {
  return receiveReplica(LINKED_PROJECT_STATE_REPLICA, store, source, raw, current);
}

export function startLinkedProjectStateNetwork(options: ReplicaNetworkOptions & { store?: LinkedProjectStateStore }): () => void {
  return startReplicaNetwork(LINKED_PROJECT_STATE_REPLICA, options.store ?? linkedProjectStateStore(), options);
}
