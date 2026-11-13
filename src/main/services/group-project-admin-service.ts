/**
 * Group-project admin bootstrap.
 *
 * Standard pattern: the first agent to join a group project becomes its admin
 * (project lead). Additional admins can be assigned later via the UI. This runs
 * when an agent binds to a group project and is a no-op once any admin exists.
 */

import { groupProjectHost } from './group-project-host';
import { getProjectAdmins } from '../../shared/group-project-admin';

/** Make `agentId` the project lead iff the project currently has no admins. */
export async function bootstrapGroupProjectAdmin(targetId: string, agentId: string): Promise<void> {
  // Ensure the registry is loaded before inspecting metadata.
  const project = await groupProjectHost.get(targetId);
  if (!project) return;
  if (getProjectAdmins(project.metadata).length > 0) return;
  await groupProjectHost.update(targetId, { metadata: { admins: [agentId] } });
}
