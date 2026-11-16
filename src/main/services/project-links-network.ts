/**
 * Project display preferences replicate between member desktops over the
 * shared pinned-member REST sync (replica-network.ts). /network remains
 * strictly membership-only. Old peers are simply skipped.
 */
import {
  PROJECT_LINKS_CAPABILITIES_PATH, PROJECT_LINKS_SYNC_PATH, PROJECT_LINKS_PAGE_SIZE,
  parseIncomingProjectLinkRecords, parseProjectLinkRecords, projectLinkPairKey, PROJECT_LINKS_MAX_RECORDS, type ProjectLinkRecord,
} from '../../shared/project-links';
import { projectLinksStore, type ProjectLinksStore } from './project-links-store';
import { receiveReplica, replicaCapabilities, startReplicaNetwork, type ReplicaNetworkOptions, type ReplicaSpec } from './replica-network';

export const PROJECT_LINKS_REPLICA: ReplicaSpec<ProjectLinkRecord> = {
  noun: 'project link', plural: 'project links',
  capabilitiesPath: PROJECT_LINKS_CAPABILITIES_PATH, syncPath: PROJECT_LINKS_SYNC_PATH,
  pageSize: PROJECT_LINKS_PAGE_SIZE, maxRecords: PROJECT_LINKS_MAX_RECORDS,
  parse: parseProjectLinkRecords,
  parseIncoming: (raw, max) => parseIncomingProjectLinkRecords(raw, max),
  keyOf: (r) => projectLinkPairKey(...r.projects),
};
export const projectLinksCapabilities = () => replicaCapabilities(PROJECT_LINKS_REPLICA);
export interface ProjectLinksNetworkOptions extends ReplicaNetworkOptions {
  store?: ProjectLinksStore;
}

/** Called only after annex-server authenticates a currently pinned member desktop. */
export function receiveProjectLinks(source: string, raw: unknown, current: () => boolean, store = projectLinksStore()): Promise<Record<string, unknown>> {
  return receiveReplica(PROJECT_LINKS_REPLICA, store, source, raw, current);
}

export function startProjectLinksNetwork(options: ProjectLinksNetworkOptions): () => void {
  return startReplicaNetwork(PROJECT_LINKS_REPLICA, options.store ?? projectLinksStore(), options);
}
