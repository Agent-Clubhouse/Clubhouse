/**
 * The host's check of an agent's write from another computer (#3363, #3360):
 * the same grants as a local call, for the agent as `<id>@<its computer>`. A
 * member may post; lead and admin changes need those grants on the group
 * project. Ask first can't be asked here (no person sees a remote write on the
 * host), so it refuses.
 */
import { decideGrant } from './clubhouse-mcp/grant-check';
import { GRANT_REFUSAL_MESSAGES } from '../../shared/agent-grants';
import type { RemoteWriteGate } from './group-project-host';

export const remoteGroupProjectGrantGate: RemoteWriteGate = ({ project, address, isMember, action }) => {
  if (!isMember) return 'Only a member of this group project can do that.';
  const decision = decideGrant(address, action, { kind: 'group_project', groupRole: 'member', groupProjectId: project.id });
  if (decision.outcome === 'allow') return undefined;
  if (decision.outcome === 'ask') {
    return `This needs approval on ${project.name}'s host, which a change from another computer can't ask for. Ask for an Allow grant instead.`;
  }
  return GRANT_REFUSAL_MESSAGES[decision.reason] ?? GRANT_REFUSAL_MESSAGES.no_grant;
};
