/** Actions use Annex's public durable sender; no local runtime or inferred sender. */
import { createHash } from 'crypto';
import { addressFromNamespacedId, formatAgentAddress, localizeAgentReference, parseAgentAddress } from '../../../shared/agent-address';
import type { SatelliteSnapshot } from '../../../shared/types';
import type { ActionStepResult } from '../../../shared/actions';
import type { AnnexDeliveryStatus } from '../../../shared/annex-delivery';
import { activeAgentLinks } from '../../../shared/connection-grants';
import { DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import { remoteFederationController } from '../dispatcher-federation';
import { getSatellite } from '../annex-client';
import { getIdentity } from '../annex-identity';
import { forwardPreparedAgentCall, getDelivery, isNetworkComputer } from '../annex-agent-calls';
import { getConnectionDirection } from '../connection-grants-store';
import type { StepContext } from './engine';

export function canonicalActionReference(id: string): string {
  return localizeAgentReference(formatAgentAddress(addressFromNamespacedId(id) ?? parseAgentAddress(id)), getIdentity()?.fingerprint);
}

export function remoteActionAgent(id: string) {
  const address = parseAgentAddress(id);
  if (!address.machine || !isNetworkComputer(address.machine)) return undefined;
  const satellite = getSatellite(address.machine);
  if (!satellite || satellite.state !== 'connected' || !satellite.snapshot) return undefined;
  const snapshot = satellite.snapshot as unknown as SatelliteSnapshot;
  const agent = Object.values(snapshot.agents).flat().find((a) => a.id === address.agentId);
  if (!agent || agent.kind !== 'durable' || agent.projectId === DISPATCHER_PROJECT_ID || remoteFederationController(address.machine)?.agentId === agent.id || (satellite.snapshot as unknown as SatelliteSnapshot).dispatcher?.agent?.id === agent.id) return undefined;
  return { agent, name: `${agent.name} on ${satellite.alias || snapshot.machine?.name || address.machine}` };
}

/** Separate connection/tool checks from the owner's grant evaluation. */
export function remoteMessageRefusal(sender: string, target: string): string | null {
  const { agentId, machine } = parseAgentAddress(target);
  if (!machine || !isNetworkComputer(machine)) return 'The target computer is unknown or no longer in the Annex Network.';
  const satellite = getSatellite(machine);
  if (!satellite || satellite.state !== 'connected' || !satellite.snapshot) return 'The target computer is offline. Reconnect it before starting this Action; already queued Annex deliveries remain durable.';
  if (remoteFederationController(machine)?.agentId === agentId || (satellite.snapshot as unknown as SatelliteSnapshot).dispatcher?.agent?.id === agentId) return 'Remote Dispatcher targets are unavailable for Actions.';
  if (!remoteActionAgent(target)) return 'The remote target is unknown or is not an ordinary durable agent.';
  const direction = getConnectionDirection({ agentId: sender }, { agentId, machineId: machine });
  if (!direction || (!direction.link && !direction.cardLink && !activeAgentLinks(direction).length)) return 'This Action needs an active connection from its owner to the remote agent.';
  if (direction.disabledTools.includes('send_message')) return 'Enable send_message on the owner’s connection to the remote agent.';
  return null;
}

export function remoteReceiptResult(receipt: AnnexDeliveryStatus): Pick<ActionStepResult, 'outcome' | 'detail' | 'remoteDelivery'> {
  const failed = ['refused', 'expired', 'indeterminate'].includes(receipt.state);
  return { outcome: failed ? 'failed' : 'done', remoteDelivery: receipt,
    detail: receipt.state === 'delivered' ? 'Message accepted by the remote runtime (model processing is not confirmed)'
      : `Remote delivery ${receipt.state}${receipt.reason ? `: ${receipt.reason}` : ''}. delivery_id=${receipt.callId}` };
}

export async function sendRemoteActionMessage(target: string, message: string, ctx: StepContext): Promise<ActionStepResult> {
  const owner = ctx.action.owner;
  const sender = owner.kind === 'agent' ? owner.agentId : owner.kind === 'dispatcher' ? ctx.dispatcherAgentId : undefined;
  const fail = (detail: string): ActionStepResult => ({ kind: 'message', outcome: 'failed', agentId: target, detail });
  if (!sender) return fail('Remote messages require a real local agent or Dispatcher owner.');
  const refusal = remoteMessageRefusal(sender, target);
  if (refusal) return fail(refusal);
  if (ctx.stepIndex === undefined) return fail('Remote message delivery requires a stable step identity.');
  const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const key = `action:${hash([ctx.action.id, ctx.runId, ctx.stepIndex])}`;
  let callId: string | undefined;
  const result = await forwardPreparedAgentCall(sender, target, remoteActionAgent(target)!.name, 'send_message', {
    message, task_id: key, idempotency_key: key,
  }, Date.now(), { rootId: `action:${hash([ctx.runId, ctx.chain])}`, parentId: ctx.runId, depth: ctx.chain.length }, (id) => { callId = id; });
  const text = result.content.map((c) => c.type === 'text' ? c.text : '').join(' ');
  const receipt = callId ? getDelivery(sender, callId) : undefined;
  if (receipt) return { kind: 'message', agentId: target, ...remoteReceiptResult(receipt) };
  return fail(text || 'Annex did not return a durable delivery receipt.');
}

export function currentRemoteReceipt(owner: import('../../../shared/actions').ActionOwner | undefined, dispatcherId: string | undefined, receipt: AnnexDeliveryStatus): AnnexDeliveryStatus | undefined {
  const sender = owner?.kind === 'agent' ? owner.agentId : owner?.kind === 'dispatcher' ? dispatcherId : undefined;
  return sender ? getDelivery(sender, receipt.callId) : undefined;
}
