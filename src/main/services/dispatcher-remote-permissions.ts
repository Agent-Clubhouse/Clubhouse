import type { Grant } from '../../shared/agent-grants';
import { getAgentGrantChanges, getAgentGrantRevision } from './agent-grants-store';
import { deliveryHash } from './annex-delivery-store';

/** Local queue provenance only. Never sent to another computer or accepted from model arguments. */
export function remoteDispatcherPermissionHash(agentId: string, grants: readonly Grant[]): string {
  return deliveryHash({ grants, changes: getAgentGrantChanges(agentId), revision: getAgentGrantRevision(agentId) });
}
