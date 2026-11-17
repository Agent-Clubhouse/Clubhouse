import type { AutoJoinPreview } from '../../../shared/group-project-types';
import { groupProjectLabel } from '../../../shared/group-project-labels';
import type { Agent, Project } from '../../../shared/types';
import { parseNamespacedId, type RemoteProject } from '../../stores/remoteProjectStore';

/** Resolve display details from the same synced inventory used by the sidebar. Never promotes saved rows to wouldJoin. */
export function resolveCreatePreview(preview: AutoJoinPreview, projects: Project[], remoteProjects: RemoteProject[], remoteAgents: Record<string, Agent>) {
  const remoteRef = (id: string) => {
    const slash = id.indexOf('/');
    return slash < 0 ? null : { machine: id.slice(0, slash), projectId: id.slice(slash + 1) };
  };
  const machines = new Set(preview.coverage?.copies.map((copy) => copy.machine) ?? []);
  for (const project of preview.unreadableProjects) {
    const ref = remoteRef(project.projectId);
    if (ref) machines.add(ref.machine);
  }
  if (preview.wouldJoin.some((agent) => !agent.agentId.includes('@'))) machines.add('local');
  // A local coverage copy already represents the local machine.
  if (preview.coverage?.copies.some((copy) => copy.thisComputer)) machines.delete('local');
  const several = machines.size > 1;
  const projectLabels = new Map(projects.map((p) => [p.id, `${groupProjectLabel(p.displayName, p.name, 'This project')}${several ? ' on this computer' : ''}`]));
  const lastSeen = (preview.lastSeen ?? []).map((agent) => ({ ...agent, projectName: agent.projectName ? groupProjectLabel(undefined, agent.projectName) : undefined }));
  const unreadableProjects = preview.unreadableProjects.map((entry) => {
    const ref = remoteRef(entry.projectId);
    const project = ref && remoteProjects.find((p) => {
      const parsed = parseNamespacedId(p.id);
      return parsed?.satelliteId === ref.machine && parsed.agentId === ref.projectId;
    });
    const name = project ? `${groupProjectLabel(project.displayName, project.name)}${several ? ` on ${project.satelliteName}` : ''}`
      : projectLabels.get(entry.projectId) ?? groupProjectLabel(undefined, entry.name);
    if (project) {
      for (const agent of lastSeen) {
        if (agent.projectId === ref!.projectId && agent.agentId.endsWith(`@${ref!.machine}`)) {
          agent.projectName = name;
          agent.machineName = project.satelliteName;
        }
      }
      for (const agent of Object.values(remoteAgents)) {
        const parsed = parseNamespacedId(agent.id);
        if (!parsed || agent.projectId !== project.id || agent.kind !== 'durable' || agent.parentAgentId
          || ('disposedAt' in agent && agent.disposedAt)) continue;
        const agentId = `${parsed.agentId}@${parsed.satelliteId}`;
        if (!lastSeen.some((row) => row.agentId === agentId) && !preview.wouldJoin.some((row) => row.agentId === agentId)) {
          lastSeen.push({ agentId, name: agent.name, kind: 'durable', via: 'auto', projectId: ref!.projectId,
            projectName: name, machineName: project.satelliteName });
        }
      }
    }
    return { ...entry, name, reason: project ? entry.reason?.replace('a linked computer', project.satelliteName) : entry.reason };
  });
  const wouldJoin = preview.wouldJoin.map((agent) => ({ ...agent,
    projectName: (!agent.agentId.includes('@') && agent.projectId && projectLabels.get(agent.projectId))
      || (agent.projectName ? groupProjectLabel(undefined, agent.projectName) : undefined),
  }));
  const coverage = preview.coverage && {
    ...preview.coverage,
    repositoryMatches: preview.coverage.repositoryMatches.map((match) => ({ ...match, name: groupProjectLabel(undefined, match.name) })),
    copies: preview.coverage.copies.map((copy) => ({ ...copy,
      name: copy.thisComputer ? projectLabels.get(copy.projectId) ?? groupProjectLabel(undefined, copy.name)
        : unreadableProjects.find((entry) => entry.projectId === `${copy.machine}/${copy.projectId}`)?.name ?? groupProjectLabel(undefined, copy.name),
    })),
  };
  return { projectLabels, preview: { ...preview, unreadableProjects, lastSeen, wouldJoin, coverage } };
}
