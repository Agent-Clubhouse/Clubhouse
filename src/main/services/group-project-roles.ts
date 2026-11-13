/**
 * The Group Project as a security principal (#3360).
 *
 * - **Lead and admin are explicit grants** to agents, on one group project:
 *   `group_project.lead` and `group_project.admin` with target
 *   `{ kind: 'group_project', id }`. No agent has either by default, the
 *   creator included. They live with every other grant, in the agent grants
 *   store, so the Clubhouse permissions page shows them.
 * - **Its own grants** are what the group project does by itself: `deliver`
 *   (post notices to members, #3362) on by default, `wake` (a lead's shoulder
 *   tap wakes a sleeping member) off. They're kept in its record's metadata.
 * - **Migration.** An agent with the old `admins` role gets lead and admin,
 *   once per group project; the role is then retired.
 */

import type { GrantChangeMode } from '../../shared/agent-grant-changes';
import { withGrantChange } from '../../shared/agent-grant-changes';
import type { GrantAction } from '../../shared/agent-grants';
import type { GroupProject, GroupProjectRolesView } from '../../shared/group-project-types';
import { getProjectAdmins } from '../../shared/group-project-admin';
import { getAgentGrantChanges, listAgentsWithGrantChanges, updateAgentGrantChanges } from './agent-grants-store';
import { groupProjectHost } from './group-project-host';
import { appLog } from './log-service';

export type GroupProjectRole = 'lead' | 'admin';

export const ROLE_ACTION: Readonly<Record<GroupProjectRole, GrantAction>> = {
  lead: 'group_project.lead',
  admin: 'group_project.admin',
};

/** What a group project does by itself, and whether it may. */
export type GroupProjectOwnGrant = 'deliver' | 'wake';
export type GroupProjectOwnGrants = Record<GroupProjectOwnGrant, 'allow' | 'off'>;

export const DEFAULT_OWN_GRANTS: Readonly<GroupProjectOwnGrants> = { deliver: 'allow', wake: 'off' };

/** A group project's own grants: its saved ones over the defaults. */
export function ownGrantsOf(gp: Pick<GroupProject, 'metadata'>): GroupProjectOwnGrants {
  const saved = gp.metadata?.grants as Partial<Record<GroupProjectOwnGrant, unknown>> | undefined;
  const pick = (k: GroupProjectOwnGrant): 'allow' | 'off' => (saved?.[k] === 'allow' || saved?.[k] === 'off' ? saved[k] as 'allow' | 'off' : DEFAULT_OWN_GRANTS[k]);
  return { deliver: pick('deliver'), wake: pick('wake') };
}

/** Whether the group project may do this by itself. */
export function groupProjectMay(gp: Pick<GroupProject, 'metadata'>, grant: GroupProjectOwnGrant): boolean {
  return ownGrantsOf(gp)[grant] === 'allow';
}

/** Change the group project's own grants. */
export async function setOwnGrant(groupProjectId: string, grant: GroupProjectOwnGrant, mode: 'allow' | 'off'): Promise<GroupProjectOwnGrants> {
  const gp = await groupProjectHost.get(groupProjectId);
  if (!gp) throw new Error(`Group project ${groupProjectId} does not exist.`);
  const next = { ...ownGrantsOf(gp), [grant]: mode };
  const updated = await groupProjectHost.update(groupProjectId, { metadata: { grants: next } });
  return ownGrantsOf(updated ?? gp);
}

const target = (groupProjectId: string) => ({ kind: 'group_project' as const, id: groupProjectId });

/** Give or take a role: Allow, Ask first, or Off. */
export async function setGroupProjectRole(groupProjectId: string, agentId: string, role: GroupProjectRole, mode: GrantChangeMode): Promise<void> {
  await updateAgentGrantChanges(agentId, (saved) => withGrantChange(saved, {
    action: ROLE_ACTION[role], target: target(groupProjectId), mode, by: 'user', at: new Date().toISOString(),
  }, []));
}

/** An agent's role grant on one group project, as saved: Off when none. */
export function roleModeOf(agentId: string, groupProjectId: string, role: GroupProjectRole): GrantChangeMode {
  const changes = getAgentGrantChanges(agentId);
  const all = [...(changes?.template ?? []), ...(changes?.changes ?? [])];
  const matching = all.filter((c) => c.action === ROLE_ACTION[role] && 'id' in c.target && c.target.id === groupProjectId);
  const found = matching[matching.length - 1];
  return found?.mode ?? 'off';
}

export interface GroupProjectRoleHolder {
  agentId: string;
  lead: GrantChangeMode;
  admin: GrantChangeMode;
}

/** Who holds lead or admin on a group project (Allow or Ask first). */
export function listGroupProjectRoles(groupProjectId: string): GroupProjectRoleHolder[] {
  const out: GroupProjectRoleHolder[] = [];
  for (const agentId of listAgentsWithGrantChanges()) {
    const lead = roleModeOf(agentId, groupProjectId, 'lead');
    const admin = roleModeOf(agentId, groupProjectId, 'admin');
    if (lead !== 'off' || admin !== 'off') out.push({ agentId, lead, admin });
  }
  return out;
}

/** Remove every role grant on a deleted group project (#3364). Idempotent. */
export async function purgeGroupProjectRoles(groupProjectId: string): Promise<void> {
  for (const holder of listGroupProjectRoles(groupProjectId)) {
    for (const role of ['lead', 'admin'] as const) await setGroupProjectRole(groupProjectId, holder.agentId, role, 'off');
  }
}

const MIGRATED_KEY = 'rolesMigratedAt';

/**
 * Give today's admins (the `admins` role) lead and admin as grants, once per
 * group project. The record notes it's done, so a later change to the grants
 * is never undone by a second pass.
 */
export async function migrateGroupProjectRoles(): Promise<number> {
  let migrated = 0;
  for (const gp of await groupProjectHost.list()) {
    if (gp.metadata?.[MIGRATED_KEY]) continue;
    for (const agentId of getProjectAdmins(gp.metadata)) {
      for (const role of ['lead', 'admin'] as const) {
        if (roleModeOf(agentId, gp.id, role) === 'off') await setGroupProjectRole(gp.id, agentId, role, 'allow');
      }
      migrated++;
    }
    await groupProjectHost.update(gp.id, { metadata: { [MIGRATED_KEY]: new Date().toISOString() } });
  }
  if (migrated > 0) appLog('core:group-project', 'info', 'Gave group project admins lead and admin grants', { meta: { agents: migrated } });
  return migrated;
}

let stopRoles: (() => void) | null = null;

/** Migrate today's admins once, and take a deleted group project's role grants away. Returns the stop. */
export function watchGroupProjectRoles(): () => void {
  if (stopRoles) return stopRoles;
  void migrateGroupProjectRoles().catch((err) => {
    // telemetry-exempt: retried at the next start, and the admins keep nothing until it runs; logged
    appLog('core:group-project', 'error', 'Could not give group project admins their grants', { meta: { error: err instanceof Error ? err.message : String(err) } });
  });
  const off = groupProjectHost.onChange((change) => {
    if (change.part !== 'deleted') return;
    void purgeGroupProjectRoles(change.groupProjectId).catch((err) => {
      // telemetry-exempt: a grant on a deleted group project covers nothing; logged
      appLog('core:group-project', 'warn', 'Could not remove a deleted group project\'s role grants', { meta: { groupProjectId: change.groupProjectId, error: err instanceof Error ? err.message : String(err) } });
    });
  });
  stopRoles = () => { off(); stopRoles = null; };
  return stopRoles;
}

/** Its own grants and who holds lead and admin, for the directory and the canvas card. */
export async function describeGroupProjectRoles(groupProjectId: string): Promise<GroupProjectRolesView> {
  const gp = await groupProjectHost.get(groupProjectId);
  if (!gp) throw new Error(`Group project ${groupProjectId} does not exist.`);
  return { groupProjectId, own: ownGrantsOf(gp), holders: listGroupProjectRoles(groupProjectId) as GroupProjectRolesView['holders'] };
}
