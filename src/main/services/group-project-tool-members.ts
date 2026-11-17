/** Agent-facing roster rows. Remote inventory does not establish runtime liveness. */
import { groupProjectRoster } from './group-project-roster';
import { groupProjectHost } from './group-project-host';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { isAgentAlive } from './group-project-lifecycle';

export async function groupProjectToolMembers(id: string) {
  const roster = await groupProjectRoster.describe(id).catch((): null => null);
  if (roster?.status === 'available') {
    const gp = await groupProjectHost.get(id);
    return roster.members.map(m => ({
      agentId: gp && m.machine === (gp.host?.machine ?? '') ? m.agentId : m.key,
      agentName: m.label,
      status: m.thisComputer ? (isAgentAlive(m.agentId) ? 'connected' : 'sleeping') : 'unknown',
      machine: m.machine, machineLabel: m.machineLabel,
      rosterSource: roster.source, rosterComplete: roster.complete,
      ...(roster.stale && { stale: roster.stale }), fetchedAt: roster.fetchedAt,
    }));
  }
  return bindingManager.getAllBindings().filter(b => b.targetKind === 'group-project' && b.targetId === id).map(b => ({
    agentId: b.agentId, agentName: b.agentName || b.agentId,
    status: isAgentAlive(b.agentId) ? 'connected' : 'sleeping',
    rosterSource: 'local', rosterComplete: false,
    fallbackReason: roster?.status === 'unavailable' ? roster.reason : 'failed',
  }));
}
