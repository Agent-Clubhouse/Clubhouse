/** Explicit project-link coverage for automatic membership. Never uses repository keys. */
import type { GroupProjectScope, ResolvedGroupProjectMember } from '../../shared/group-project-types';
import type { NetworkProjectRef } from '../../shared/project-links';
import { projectLinksStore } from './project-links-store';
import { appLog } from './log-service';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { DurableAgentConfig } from '../../shared/types';

export function linkedProjectCopies(machine: string | null, projectId: string): NetworkProjectRef[] {
  if (!machine) return [];
  return projectLinksStore().groups().find((group) => group.some((p) => p.machine === machine && p.projectId === projectId))
    ?.filter((p) => p.machine !== machine) ?? [];
}

export function projectsExplicitlyLinked(host: string, hostProject: string, machine: string, projectId: string): boolean {
  return linkedProjectCopies(host, hostProject).some((p) => p.machine === machine && p.projectId === projectId);
}

export interface LinkedAgents {
  copies: NetworkProjectRef[];
  agents: Array<ResolvedGroupProjectMember & { machine: string }>;
  /** Verified durable agents including helpers, for explicit additions only. */
  available: Array<ResolvedGroupProjectMember & { machine: string }>;
  unknown: Array<{ projectId: string; name: string }>;
}

/** Only a connected, complete snapshot is evidence for new automatic joins. */
export async function linkedAgents(
  scope: GroupProjectScope | undefined, self: string | null, isMember: (machine: string) => boolean,
): Promise<LinkedAgents> {
  if (scope?.level !== 'project' || scope.reach !== 'network') return { copies: [], agents: [], available: [], unknown: [] };
  const copies = linkedProjectCopies(self, scope.projectId);
  if (!copies.length) return { copies, agents: [], available: [], unknown: [] };
  const { getSatellites } = await import('./annex-client');
  const satellites = getSatellites();
  const agents: LinkedAgents['agents'] = [], available: LinkedAgents['available'] = [], unknown: LinkedAgents['unknown'] = [];
  for (const copy of copies) {
    const sat = satellites.find((s) => s.fingerprint.toLowerCase() === copy.machine);
    const snapshot = sat?.snapshot;
    const project = snapshot?.projects?.find((raw) => raw && typeof raw === 'object' && (raw as { id?: unknown }).id === copy.projectId) as { name?: string; displayName?: string } | undefined;
    const name = `${project?.displayName || project?.name || copy.projectId} on ${sat?.alias || 'a linked computer'}`;
    if (!isMember(copy.machine) || sat?.state !== 'connected' || sat.snapshotUnavailable || !snapshot || !project
      || snapshot.snapshotTruncated?.omitted?.some((field) => field === 'agents' || field === 'projects')
      || !Array.isArray(snapshot.agents?.[copy.projectId])) {
      unknown.push({ projectId: `${copy.machine}/${copy.projectId}`, name });
      continue;
    }
    for (const raw of snapshot.agents[copy.projectId]) {
      if (!raw || typeof raw !== 'object') continue;
      const agent = raw as DurableAgentConfig;
      const kind = (raw as { kind?: unknown }).kind;
      if (kind !== undefined && kind !== 'durable' && kind !== 'helper') continue;
      const helper = !!agent.parentAgentId || kind === 'helper';
      if (typeof agent.id !== 'string' || typeof agent.name !== 'string' || isDisposedAgent(agent)) continue;
      // quickAgents is a separate snapshot inventory and is deliberately never read here.
      const member = { agentId: `${agent.id}@${copy.machine}`, name: agent.name, kind: helper ? 'helper' as const : 'durable' as const, via: 'explicit' as const, projectId: copy.projectId, projectName: name, machine: copy.machine };
      available.push(member);
      if (!helper) agents.push({ ...member, via: 'auto' });
    }
  }
  return { copies, agents, available, unknown };
}

/** Snapshot arrivals include later agents; link records include link and unlink, including incoming sync. */
export function watchLinkedAgents(changed: () => void): () => void {
  const offLinks = projectLinksStore().onChange((change) => { if (change.recordsChanged) changed(); });
  let stopped = false;
  let offSnapshot: (() => void) | undefined;
  void import('./annex-client').then((client) => {
    if (!stopped) offSnapshot = client.onSatelliteSnapshot(changed);
  }).catch((error) => {
    // telemetry-exempt: local membership continues; linked additions still require a verified inventory
    appLog('core:group-project', 'warn', 'Could not watch linked agent inventories', { meta: { error: String(error) } });
  });
  return () => { stopped = true; offLinks(); offSnapshot?.(); };
}
