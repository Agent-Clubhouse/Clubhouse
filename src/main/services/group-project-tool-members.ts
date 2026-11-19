/** Compact agent-facing identities from the authoritative roster. */
import { groupProjectRoster } from './group-project-roster';
import { groupProjectHost } from './group-project-host';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { localMemberObservation } from './group-project-member-status';
import { getSettings } from './annex-settings';
import { listGroupProjectRoles } from './group-project-roles';
import type { MentionMember } from '../../shared/group-project-mentions';

export async function groupProjectToolMembers(id: string) {
  const roster = await groupProjectRoster.describe(id).catch((): null => null);
  if (roster?.status === 'available') {
    const gp = await groupProjectHost.get(id);
    return Promise.all(roster.members.map(async m => {
      const reference = m.machine ? m.key : m.agentId;
      const address = gp ? groupProjectHost.addressOf(gp, reference) : reference;
      return {
        name: m.label, address, computer: m.thisComputer ? getSettings().alias || getSettings().deviceName || m.machineLabel : m.machineLabel,
        inbox: m.inbox ?? await groupProjectHost.inboxFor(id, m.label, address),
        ...(m.thisComputer ? localMemberObservation(m.agentId) : { status: m.status ?? 'unknown', ...(m.lastSeen && { lastSeen: m.lastSeen }) }),
        roles: (['lead', 'admin'] as const).filter(role => m[role] === 'allow' || m[role] === 'ask'),
      };
    }));
  }
  const roles = new Map(listGroupProjectRoles(id).map(r => [r.agentId, r]));
  return Promise.all(bindingManager.getAllBindings().filter(b => b.targetKind === 'group-project' && b.targetId === id).map(async b => ({
    name: b.agentName || b.agentId, address: b.agentId,
    computer: getSettings().alias || getSettings().deviceName || 'This computer',
    inbox: await groupProjectHost.inboxFor(id, b.agentName || b.agentId, b.agentId),
    ...localMemberObservation(b.agentId),
    roles: (['lead', 'admin'] as const).filter(role => roles.get(b.agentId)?.[role] === 'allow' || roles.get(b.agentId)?.[role] === 'ask'),
  })));
}

/** Base display names for mention resolution; addresses match resolveMembers on this host. */
export async function groupProjectMentionMembers(id: string): Promise<MentionMember[]> {
  const [rows, gp] = await Promise.all([groupProjectToolMembers(id), groupProjectHost.get(id)]);
  return rows.map(({ name, address, computer }) => ({
    name, address: gp ? groupProjectHost.addressOf(gp, address) : address, computer,
  }));
}
