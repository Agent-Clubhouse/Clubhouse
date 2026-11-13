import { getProjectAdmins } from '../../shared/group-project-admin';
import { groupProjectHost } from './group-project-host';
import { readGroupProjectCanvasInventory } from './group-project-canvas-inventory';
import type { GroupProjectDeletionInventory } from './group-project-deletion';
import { assertGroupProjectGuidanceDeletable } from './connection-guidance';

/** Assemble an impact check from the authoritative record and local canvas stores. */
export async function readGroupProjectDeletionInventory(id: string): Promise<GroupProjectDeletionInventory> {
  assertGroupProjectGuidanceDeletable();
  const project = await groupProjectHost.get(id);
  if (!project) throw new Error('This group project is unavailable on this host.');
  const [members, membership, digest, canvas] = await Promise.all([
    groupProjectHost.resolveMembers(id), groupProjectHost.getMembership(id),
    groupProjectHost.digest(id), readGroupProjectCanvasInventory(id),
  ]);
  const machines = new Set<string>();
  for (const member of members) {
    const at = member.address.lastIndexOf('@');
    if (at >= 0 && at < member.address.length - 1) machines.add(member.address.slice(at + 1));
  }
  return {
    groupProjectId: id,
    members: members.map((member) => `${member.name} (${member.address})`).sort(),
    exclusions: membership.excluded.map((entry) => entry.address).sort(),
    canvases: canvas.canvases,
    // Owned Actions and principal grants are introduced by separate lanes.
    actions: [],
    grants: getProjectAdmins(project.metadata).sort(),
    messages: digest.reduce((count, topic) => count + topic.messageCount, 0),
    topics: digest.length,
    machines: [...machines].sort(),
    revisions: [String(project.seq ?? 0), canvas.revision, JSON.stringify(membership)],
  };
}
