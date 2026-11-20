import type { Agent } from '../../../../shared/types';
import type { RemoteHelperRow } from '../../../../shared/remote-helper-page';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { namespacedAgentId, namespacedProjectId, parseNamespacedId, useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { useUIStore } from '../../../stores/uiStore';
import { openAgent } from '../helpers/orchestration-hooks';

export function remoteHelperOpenUnavailable(parent: Agent, row: RemoteHelperRow): string | null {
  const address = parseNamespacedId(parent.id), project = parseNamespacedId(parent.projectId);
  if (!address || !project || project.satelliteId !== address.satelliteId || !row.target || row.status === 'disposed') return 'The host has not bound a navigable helper and project identity.';
  const host = useAnnexClientStore.getState().satellites.find((s) => s.id === address.satelliteId);
  if (host?.state !== 'connected' || host.snapshotUnavailable || !host.snapshot) return 'Reconnect to the host to open this helper.';
  if (host.snapshot.snapshotTruncated?.omitted?.some((s) => s === 'agents' || s === 'projects')) return 'The current host snapshot omits helper or project identities.';
  const snapshot = host.snapshot;
  if (snapshot.projects.filter((p) => p.id === project.agentId).length !== 1 || snapshot.projects.filter((p) => p.id === row.target!.projectId).length !== 1
    || snapshot.agents[project.agentId]?.filter((a) => a.id === address.agentId).length !== 1) return 'The selected parent or helper project is absent from the current host snapshot.';
  const matches = snapshot.agents[row.target.projectId]?.filter((a) => a.id === row.target!.agentId) ?? [];
  if (matches.length !== 1 || matches[0].kind !== 'durable' || matches[0].parentAgentId !== address.agentId) return 'The current host snapshot does not confirm this direct helper relationship.';
  const id = namespacedAgentId(address.satelliteId, row.target.agentId), pid = namespacedProjectId(address.satelliteId, row.target.projectId);
  const loaded = useRemoteProjectStore.getState().remoteAgents[id];
  if (!loaded || loaded.projectId !== pid || loaded.parentAgentId !== parent.id) return 'This helper is not available in the current host navigation inventory.';
  return null;
}
export function openRemoteHelper(parent: Agent, row: RemoteHelperRow): void {
  if (remoteHelperOpenUnavailable(parent, row)) return;
  const address = parseNamespacedId(parent.id)!;
  useUIStore.getState().setActiveHost(address.satelliteId);
  if (remoteHelperOpenUnavailable(parent, row)) return;
  openAgent(namespacedProjectId(address.satelliteId, row.target!.projectId), namespacedAgentId(address.satelliteId, row.target!.agentId));
}
