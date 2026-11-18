/** Resume through the same guarded lifecycle used by wake_agent. */
import { parseAgentAddress, formatAgentAddress } from '../../shared/agent-address';
import { decideGrant } from './clubhouse-mcp/grant-check';
import { findDurableAgentConfig, wakeWiredAgent } from './clubhouse-mcp/tools/agent-lifecycle';
import { groupProjectHost } from './group-project-host';
import { groupProjectMay } from './group-project-roles';
import { reserveWake } from './group-project-notification-store';
import type { GroupProject } from '../../shared/group-project-types';
import type { RoutedMessagePart } from '../../shared/chat';

export async function wakeForGroupPost(group: string, agent: string, name: string, text: string, routed: RoutedMessagePart[], senders: Array<string | undefined>): Promise<boolean> {
  const allowed = async () => {
    const gp = await groupProjectHost.get(group);
    if (!gp) return false;
    if (wakeHoldReason(gp, senders)) return false;
    return groupProjectMay(gp, 'deliver') && groupProjectMay(gp, 'wake')
      && (await groupProjectHost.resolveMembers(group)).some((m) => groupProjectHost.localAgentId(gp, m.address) === agent);
  };
  if (!(await allowed())) return false;
  const durable = await findDurableAgentConfig(agent);
  // A missing session must not turn a direct notice into a fresh task.
  if (!durable?.agentConfig.lastSessionId || !(await reserveWake(agent))) return false;
  const result = await wakeWiredAgent({
    taskId: `group-project:${group}`, callerId: group, targetId: agent, targetName: name,
    mission: text, missionRouted: routed, locate: async () => durable,
    authorize: async () => { if (!(await allowed())) throw new Error('Group project wake permission or membership changed.'); },
  });
  if (result.isError) return false;
  return result.content.some((c) => c.type === 'text' && (() => {
    try { return JSON.parse(c.text).messageDelivered === true; } catch { return false; }
  })());
}

/** Receiving-computer preflight; Allow is required because remote requests cannot ask. */
export function wakeHoldReason(gp: GroupProject, senders: Array<string | undefined>): string | undefined {
  if (!groupProjectMay(gp, 'wake')) return 'The group project wake grant is Off; the notice stays unread.';
  for (const sender of senders) {
    if (!sender) { if (gp.network?.role === 'replica' || gp.scope?.reach === 'network') return 'The sender computer is unknown; the notice stays unread.'; continue; }
    if (groupProjectHost.localAgentId(gp, sender)) continue;
    const parsed = parseAgentAddress(sender);
    const address = formatAgentAddress({ agentId: parsed.agentId, machine: parsed.machine ?? gp.host?.machine ?? undefined });
    if (decideGrant(address, 'group_project.lead', { kind: 'group_project', groupRole: 'member', groupProjectId: gp.id }).outcome !== 'allow') return 'Remote wake needs an Allow grant for group_project.lead on the receiving computer; the notice stays unread.';
  }
  return undefined;
}
