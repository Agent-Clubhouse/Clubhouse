import type { RemoteDispatcherPresence } from '../../shared/dispatcher-presence';
import { parseAgentAddress } from '../../shared/agent-address';
import { effectiveAgentGrants } from './agent-grants-service';
import { agentRegistry } from './agent-registry';
import { captureControllerPublication, forwardPreparedAgentCall } from './annex-agent-calls';
import { callApprovalVersion } from './grant-requests';
import { getAgentGrantRevision } from './agent-grants-store';
import { remoteDispatcherPermissionHash } from './dispatcher-remote-permissions';
import { remoteFederationController } from './dispatcher-federation';
import { federationRequestRouter } from './dispatcher-federation-policy';
import { callGrantIsApproved, grantApprovalContext } from './clubhouse-mcp/tool-registry';
import { resolveArgTargets } from './clubhouse-mcp/arg-targets';
import { checkToolGrant } from './clubhouse-mcp/grant-check';
import { REMOTE_DISPATCHER_GRANT } from './clubhouse-mcp/tools/remote-dispatcher-tools';

export async function sendRemoteDispatcherNews(agentId: string, toolName: string, args: Record<string, unknown>, peer: RemoteDispatcherPresence, tool: 'send_message' | 'send_file', field: 'message' | 'content') {
  const project = agentRegistry.get(agentId)?.projectPath;
  if (!project || !peer.address) throw new Error('The sender or receiving Dispatcher is unavailable.');
  const guard = captureControllerPublication(peer.machineId);
  const version = callApprovalVersion(agentId);
  const grantRevision = getAgentGrantRevision(agentId);
  const targets = await resolveArgTargets(agentId, REMOTE_DISPATCHER_GRANT, args);
  const check = checkToolGrant(agentId, REMOTE_DISPATCHER_GRANT, args);
  if (!callGrantIsApproved(agentId, toolName, args, check, grantApprovalContext(agentId, toolName, args, REMOTE_DISPATCHER_GRANT, targets))) throw new Error('The sender permission or its approval changed.');
  const grants = await effectiveAgentGrants(project, agentId);
  const policyHash = remoteDispatcherPermissionHash(agentId, grants);
  const current = () => guard.current() && callApprovalVersion(agentId) === version
    && getAgentGrantRevision(agentId) === grantRevision
    && callGrantIsApproved(agentId, toolName, args, checkToolGrant(agentId, REMOTE_DISPATCHER_GRANT, args), grantApprovalContext(agentId, toolName, args, REMOTE_DISPATCHER_GRANT, targets))
    && remoteFederationController(peer.machineId)?.enabled === true
    && remoteFederationController(peer.machineId)?.agentId === parseAgentAddress(peer.address!).agentId;
  if (!current()) throw new Error('The sender permission or remote Dispatcher changed.');
  const body = { [field]: args[field], ...(args.task_id !== undefined && { task_id: args.task_id }),
    ...(args.idempotency_key !== undefined && { idempotency_key: args.idempotency_key }), ...(tool === 'send_file' && args.filename !== undefined && { filename: args.filename }) };
  return forwardPreparedAgentCall(agentId, peer.address, peer.label, tool, body, Date.now(), federationRequestRouter()?.cause(agentId), undefined, { authorization: { policyHash }, current });
}
