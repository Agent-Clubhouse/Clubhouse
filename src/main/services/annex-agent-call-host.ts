import { formatAgentAddress } from '../../shared/agent-address';
import type { McpToolResult } from './clubhouse-mcp/types';
import { decideGrant } from './clubhouse-mcp/grant-check';
import { remoteFederationController } from './dispatcher-federation';
import { isNetworkComputer } from './annex-agent-calls';
import { readAgentConfig } from './agent-config-reader';
import { activeAgentLinks } from '../../shared/connection-grants';
import { evaluateGrant } from '../../shared/agent-grants';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { DeliveryOutboxItem } from './annex-delivery-store';
import { effectiveAgentGrants } from './agent-grants-service';
import { agentRegistry } from './agent-registry';
import { getDurableConfig, peekDurableConfigs } from './agent-config';
import { getConnectionDirection } from './connection-grants-store';
import { getDispatcherState, isDispatcherAgentId, isDispatcherChatAgentId } from './dispatcher/dispatcher-service';
import { peekProjects } from './project-store';
import type { AnnexDeliveryFailure } from '../../shared/annex-delivery';
import { getAgentRuntime } from './agent-runtime';
import { actionsReady, recordExternalRun } from './actions';
import { federationMessageDirection, federationRequestRouter } from './dispatcher-federation-policy';
import { remoteDispatcherPermissionHash } from './dispatcher-remote-permissions';

/** Recovered work uses saved grants too: a sleeping sender is not revoked. */
export async function authorizeQueuedAnnexCall(item: DeliveryOutboxItem): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const callerId = item.body.from.agentId;
  const refuse = (reason: string) => ({ allowed: false as const, reason });
  if (isDispatcherChatAgentId(callerId)) return refuse('The Dispatcher chat cannot deliver controller messages.');
  let projectPath = agentRegistry.get(callerId)?.projectPath;
  if (isDispatcherAgentId(callerId)) {
    const state = getDispatcherState();
    if (!state.enabled || !state.path) return refuse('The sending Dispatcher was turned off.');
    projectPath = state.path;
  }

  if (!projectPath) {
    for (const project of await peekProjects()) {
      if ((await peekDurableConfigs(project.path)).some((a) => a.id === callerId && !isDisposedAgent(a))) {
        projectPath = project.path;
        break;
      }
    }
  }
  if (!projectPath) return refuse('The sending agent no longer has saved permissions.');
  const config = await getDurableConfig(projectPath, callerId);
  if (!config || isDisposedAgent(config)) return refuse('The sending agent was removed.');
  const grants = await effectiveAgentGrants(projectPath, callerId);
  if (item.remoteDispatcherAuthorization) {
    if (!['send_message', 'send_file'].includes(item.body.tool)
      || !federationMessageDirection({ agentId: callerId }, { agentId: item.body.to, machineId: item.machine })
      || federationRequestRouter()?.allowed(item.machine, item.body.args, item.body.tool) === false) return refuse('The receiving Dispatcher or its controller link is unavailable.');
    const decision = evaluateGrant({ caller: { kind: 'agent', agentId: callerId, projectPath }, action: 'agent.message', target: { kind: 'agent', remoteDispatcher: true } }, grants);
    return decision.outcome !== 'refuse' && remoteDispatcherPermissionHash(callerId, grants) === item.remoteDispatcherAuthorization.policyHash
      ? { allowed: true } : refuse('The sender permission changed after this delivery was approved.');
  }
  const direction = getConnectionDirection({ agentId: callerId }, { agentId: item.body.to, machineId: item.machine });
  if ((!direction?.link && !direction?.cardLink && !activeAgentLinks(direction).length) || direction.disabledTools.includes(item.body.tool)) return refuse('The sender connection or its tool permission was removed.');
  const decision = evaluateGrant({
    caller: { kind: 'agent', agentId: callerId, projectPath },
    action: 'agent.message',
    target: { kind: 'agent', relations: config.parentAgentId === `${item.body.to}@${item.machine}` ? ['parent'] : ['connected'] },
  }, grants);
  return decision.outcome === 'allow' ? { allowed: true } : refuse('The sender no longer has an Allow grant for agent.message on this connection.');
}

const FAILURE_REASONS: Record<string, string> = {
  expired: 'No receiving-tool receipt arrived within seven days.',
  authorization_revoked: 'The sender connection or permission was revoked.',
  peer_revoked: 'The target computer was removed from the Annex Network.',
  receiver_interrupted: 'The receiver restarted during delivery; input acceptance is unknown.',
  runtime_queued: 'The receiving runtime queued input; final dispatch is unconfirmed.',
  durable_delivery_unsupported: 'The other computer needs an update before durable delivery can resume.',
  pairing_changed: 'The network pairing changed; this delivery was not sent under the new pairing.',
  legacy_delivery_unverified: 'This pending delivery predates durable receipts; earlier acceptance is unconfirmed.',
  missing_durable_receipt: 'The other computer answered without a durable receiving-tool receipt.',
};

/** Repeated callbacks replace one history row and reuse one native-chat correlation. */
export async function reportAnnexDeliveryFailure(notice: AnnexDeliveryFailure): Promise<boolean> {
  if (!actionsReady()) return false;
  const reason = FAILURE_REASONS[notice.reason ?? ''] ?? (notice.state === 'indeterminate'
    ? 'Input may have been accepted; automatic redelivery is disabled.'
    : 'The receiving computer refused this delivery.');
  const id = `annex-delivery:${notice.callId}`;
  const detail = `Annex delivery to ${notice.targetId}: ${reason}`;
  const at = Date.parse(notice.updatedAt);
  await recordExternalRun({
    id, actionId: id, externalSource: 'annex_delivery',
    owner: isDispatcherAgentId(notice.callerId) ? { kind: 'dispatcher' } : { kind: 'agent', agentId: notice.callerId },
    trigger: { kind: 'manual', at, detail: 'Annex delivery receipt' },
    chain: [], startedAt: at, endedAt: at,
    outcome: notice.state === 'expired' ? 'expired' : 'failed', reason: detail,
    steps: [{ kind: 'message', outcome: 'failed', agentId: notice.targetId, detail }],
  });
  const runtime = getAgentRuntime(notice.callerId);
  if (!runtime?.isRunning()) return false;
  if (runtime.kind === 'chat') {
    const transcript = await runtime.readTranscript();
    const previous = transcript.events?.find((e) => e.type === 'user_message' && e.data.clientCommandId === id);
    if (previous?.type === 'user_message') {
      if (previous.data.delivery !== 'queued') return true;
      const messageId = previous.data.queuedWith ?? previous.data.messageId;
      return !!messageId && !!transcript.events?.some((e) => e.type === 'queue_state'
        && e.data.transition.status === 'delivered' && e.data.transition.messageIds.includes(messageId));
    }
    if (runtime.getState() !== 'idle' || runtime.hasPendingWork?.()) return false;
  }
  const result = await runtime.sendMessage(`[Clubhouse] ${detail} delivery_id=${notice.callId}. ${notice.state === 'indeterminate' ? 'Inspect the target before sending new work under a new key.' : 'Use get_delivery for the retained state.'}`, {
    source: 'mcp', taskId: id, clientCommandId: id,
    routed: [{ fromClubhouse: true, text: detail }],
  });
  return result.delivery !== 'queued';
}

/** The identity published by this pinned member, never a model-supplied name or flag. */
export function isConfigDispatcher(machine: string, agentId: string): boolean {
  const controller = remoteFederationController(machine);
  return isNetworkComputer(machine) && controller?.enabled === true && controller.agentId === agentId;
}

/** Recheck the host's own permission immediately before returning any configuration bytes. */
export async function readConfigForRemoteCaller(machine: string, agentId: string, targetId: string): Promise<McpToolResult> {
  const address = formatAgentAddress({ agentId, machine });
  const allowed = () => {
    if (!isNetworkComputer(machine)) return false;
    const direction = getConnectionDirection({ agentId, machineId: machine }, { agentId: targetId });
    const connected = !!(direction?.link || direction?.cardLink || activeAgentLinks(direction).length);
    const dispatcher = isConfigDispatcher(machine, agentId);
    if ((!connected && !dispatcher) || direction?.disabledTools.includes('read_agent_config')) return false;
    return decideGrant(address, 'agent.read', { kind: 'agent', agentId: targetId, relations: connected ? ['connected'] : [] }, dispatcher).outcome === 'allow';
  };
  const refused = (): McpToolResult => ({ content: [{ type: 'text', text: 'The receiving host does not allow agent.read on that target.' }], isError: true });
  if (!allowed()) return refused();
  try {
    const result = await readAgentConfig(targetId);
    return allowed() ? { content: [{ type: 'text', text: JSON.stringify(result) }] } : refused();
  } catch {
    // telemetry-exempt: read failure returned without configuration content or source paths
    return { content: [{ type: 'text', text: 'The target configuration could not be read on its computer.' }], isError: true };
  }
}
