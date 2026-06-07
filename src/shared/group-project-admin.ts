/**
 * Group-project admin role.
 *
 * A group project has zero or more *admins* (project leads) recorded as agent
 * ids in `project.metadata.admins`. The standard pattern is a single project
 * manager, but multiple admins are allowed.
 *
 * Role model (see {@link deniedGroupProjectTools}):
 *  - Non-admin members get the core tools only (read/post/list/info).
 *  - Admins additionally get the privileged tools (wake/sleep, polling,
 *    broadcast, shoulder_tap, clear/compact, message curation, set_project_info).
 *  - The role sets the baseline; per-wire `disabledTools` restrict further for
 *    anyone (an admin can have specific tools removed on their wire).
 */

import { GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES } from './group-project-permissions';

/** Read the admin agent-id list from a group project's metadata. */
export function getProjectAdmins(metadata?: Record<string, unknown>): string[] {
  const admins = metadata?.admins;
  if (!Array.isArray(admins)) return [];
  return admins.filter((a): a is string => typeof a === 'string');
}

/** Whether `agentId` is an admin of the project described by `metadata`. */
export function isProjectAdmin(metadata: Record<string, unknown> | undefined, agentId: string): boolean {
  return getProjectAdmins(metadata).includes(agentId);
}

/** Add `agentId` to the admin list (idempotent). Returns the new list. */
export function addAdmin(metadata: Record<string, unknown> | undefined, agentId: string): string[] {
  const admins = getProjectAdmins(metadata);
  return admins.includes(agentId) ? admins : [...admins, agentId];
}

/** Remove `agentId` from the admin list. Returns the new list. */
export function removeAdmin(metadata: Record<string, unknown> | undefined, agentId: string): string[] {
  return getProjectAdmins(metadata).filter((a) => a !== agentId);
}

/**
 * The set of tool suffixes denied for `agentId` on a group-project wire.
 *
 * - Per-wire `disabledTools` always apply (a wire can restrict anyone further).
 * - Non-admins are additionally denied every privileged tool (role baseline);
 *   admins keep the privileged set unless a wire explicitly disables one.
 */
export function deniedGroupProjectTools(
  metadata: Record<string, unknown> | undefined,
  agentId: string,
  wireDisabledTools?: string[],
): Set<string> {
  const denied = new Set<string>(wireDisabledTools ?? []);
  if (!isProjectAdmin(metadata, agentId)) {
    for (const t of GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES) denied.add(t);
  }
  return denied;
}
