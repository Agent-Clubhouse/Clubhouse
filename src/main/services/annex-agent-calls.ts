import { activeAgentLinks } from '../../shared/connection-grants';
/**
 * Agents across machines (#3064, Annex Network stage 7).
 *
 * An agent's connection to an agent on another computer in the network is a
 * binding whose target is that agent's address (`<agentId>@<machine>`,
 * agent-address.ts). Calling one of its tools runs nowhere here: after this
 * machine's own checks (the caller's grants, the wire's disabled tools), the
 * call goes to the target's machine over the pinned connection, which checks
 * it against its own connection store and runs it with the same tool code a
 * local call uses.
 *
 * - Only between computers in the network (members, which connect to each
 *   other both ways): not one-to-one pairings, and never a phone (D238).
 * - The receiving machine checks each call against its copy of the direction
 *   (D129, D231). Every member already controls every other, so the copy a
 *   member sends is taken as the person's own edit, newest first (D234).
 * - Loop and rate limits apply per link (D233).
 * - The receiver sees the sender's name and machine, never "You".
 * - A machine that's offline: messages wait here and go, in order, when it's
 *   back; reads say it's offline; other calls are refused (D235).
 */

import { FEDERATION_TOOLS, federationDirection, federationStatus, type FederationPublicationGuard } from './dispatcher-federation-policy';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { tel } from '../telemetry/facade';
import { formatAgentAddress, parseAgentAddress, routeOf } from '../../shared/agent-address';
import { CONNECTION_TOOLS, WAKE_TOOL, localWakeOn, type AgentAddress as ConnectionEnd, type ConnectionDirection } from '../../shared/connection-grants';
import type { McpToolResult } from './clubhouse-mcp/types';
import * as annexIdentity from './annex-identity';
import * as annexPeers from './annex-peers';
import { ownPairing } from './annex-network-membership';
import { appLog } from './log-service';
import { createSettingsStore } from './settings-store';
import {
  boundedDeliveryResult, createAnnexDeliveryStore, deliveryFailure, deliveryHash, DELIVERY_MAX_AGE_MS,
  type AnnexDeliveryStore, type DeliveryOutboxItem, type DurableAgentCall, type ReceiverDelivery,
} from './annex-delivery-store';
import type { AnnexCallContext, AnnexDeliveryEpoch, AnnexDeliveryFailure, AnnexDeliveryReceipt, AnnexDeliveryStatus, AuthenticatedAnnexOrigin } from '../../shared/annex-delivery';
import {
  getConnectionDirection, listAllConnectionDirections, onConnectionGrantsChanged, putConnectionDirection,
} from './connection-grants-store';

export const AGENT_CALL_VERSION = 1;

/** Wake, across machines: a switch of its own on the connection, as each connection tool has (D232). */
export { WAKE_TOOL };
/** The tools another machine's agent may call here: what a connection carries, and wake (D232). */
export const AGENT_CALL_TOOLS: ReadonlySet<string> = new Set([...CONNECTION_TOOLS.map((t) => t.tool), WAKE_TOOL]);
/** Tools whose call waits for an offline machine; the rest answer at once. */
const QUEUED_TOOLS = new Set(['send_message', 'send_file']);
/** Tools that put something in front of the other agent, counted by the loop limit. */
const LOOP_TOOLS = new Set(['send_message', 'send_file', WAKE_TOOL]);
const READ_TOOLS = new Set(['get_status', 'read_output', 'check_connectivity']);

export const AGENT_CALL_MAX_BYTES = 512 * 1024;
/** Per direction, on the receiving machine (D233). */
export const RATE_LIMIT = { calls: 30, windowMs: 60_000 };
/** Messages between one pair of agents, both ways, counted on both machines (D233). */
export const LOOP_LIMIT = { messages: 40, windowMs: 10 * 60_000 };
const OUTBOX_MAX_PER_MACHINE = 200;
const RETRY_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const OUTBOX_MAX_TOTAL = 2000;
/** Directions sent per request, and kept with any one other machine. */
export const DIRECTIONS_PER_REQUEST = 200;
const DIRECTIONS_PER_MACHINE = 1000;
const NAMES_MAX = 2000;
/** A copy dated further ahead than this is taken as made now: another machine's clock can't pin it forever. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** How long a queued message refused as "not connected" is tried again, in case the link hasn't arrived there yet. */
const NOT_CONNECTED_GRACE_MS = 10 * 60_000;
export const ANNEX_CALL_MAX_DEPTH = 8;
const DISPATCHER_CALL_TOOLS = FEDERATION_TOOLS;

// ── Who is calling ──────────────────────────────────────────────────────────

/** The sender of a call that came from another machine, while its tool runs here. */
export interface RemoteCaller {
  name: string;
  machineName: string;
  projectName?: string;
  /** The name of the agent here it's calling, for the tool's answer. */
  targetName?: string;
  machineId: string;
  agentId: string;
  deliveryId: string;
  context: AnnexCallContext;
}

const remoteCallers = new AsyncLocalStorage<RemoteCaller>();

/** The other machine's agent this call is for, if the call came from one. */
export function currentRemoteCaller(): RemoteCaller | undefined {
  return remoteCallers.getStore();
}

// ── Transport and the tool runner (set at startup; tests set fakes) ────────

export interface AgentCallTransport {
  /** Whether this machine has a connection to `machine` it can send on now. */
  connected(machine: string): boolean;
  post(machine: string, path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  /** Negotiated on the pinned peer before sending input; an old peer must not execute a retried durable call. */
  supportsDurableDelivery(machine: string): Promise<boolean>;
  /** The name this machine knows `machine` by. */
  machineName(machine: string): string | undefined;
  /** Called each time a connection to a machine opens. */
  onConnected(listener: (machine: string) => void): () => void;
}

/** Runs one of this machine's agent tools for a caller, as a local wire call would. */
export type AgentToolRunResult = McpToolResult & {
  /** retry_later is safe only when the handler knows no input was accepted. */
  annexDelivery?: { state: AnnexDeliveryReceipt['state']; reason?: string };
};
export type AgentToolRunner = (tool: string, targetId: string, callerId: string, args: Record<string, unknown>) => Promise<AgentToolRunResult>;

type DescribeAgent = (agentId: string) => Promise<{ name: string; projectName?: string } | undefined>;
const describeNothing: DescribeAgent = async () => undefined;

let transport: AgentCallTransport | null = null;
let runTool: AgentToolRunner | null = null;
let describeLocalAgent: DescribeAgent = describeNothing;
let nameOfLocalSender: ((agentId: string) => string | undefined) | undefined;
export interface DispatcherAgentCallReceiver {
  isTarget(id: string): boolean;
  isAvailable(id: string): boolean;
  receive(request: { origin: AuthenticatedAnnexOrigin; targetId: string; deliveryId: string; cause: AnnexCallContext; tool: string; args: Record<string, unknown> }): Promise<AgentToolRunResult>;
}
let remoteDispatcher: DispatcherAgentCallReceiver | undefined;
let lifecycle = 0;
let federation: StartAgentCallsOptions['federation'];
export function federationControllerForShare(): unknown { return federation?.local(); }
/** Other federation state for the connection exchange (#3351's lead), beside the controller. */
export function federationExtraForShare(): unknown { return federation?.extra?.local(); }

/** Pairing and service incarnation that authenticated this publication. */
export function captureControllerPublication(machine: string): FederationPublicationGuard {
  const generation = lifecycle;
  const owner = federation;
  const epoch = Object.freeze(outgoingEpoch(machine));
  return { epoch, current: () => generation === lifecycle && owner === federation && isNetworkComputer(machine)
    && deliveryHash(epoch) === deliveryHash(outgoingEpoch(machine)) };
}
function publicationEpochMatches(raw: unknown, expected: AnnexDeliveryEpoch): boolean {
  const epoch = raw as AnnexDeliveryEpoch | null;
  return !!epoch && epoch.sender === expected.receiver && epoch.receiver === expected.sender;
}


const selfFingerprint = (): string | undefined => annexIdentity.getIdentity()?.fingerprint.toLowerCase();

function text(message: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: message }], ...(isError && { isError: true }) };
}

const describe = (agentId: string) => describeLocalAgent(agentId).catch((): undefined => undefined);

/** A computer in this machine's network: a member that isn't a phone (D238). */
export function isNetworkComputer(machine: string): boolean {
  const fp = machine.toLowerCase();
  const peer = annexPeers.listPeers().find((p) => p.fingerprint.toLowerCase() === fp);
  return !!peer && peer.role === 'member' && peer.kind !== 'phone';
}

// ── Limits ─────────────────────────────────────────────────────────────────

const limits = new Map<string, number[]>();

function hit(key: string, windowMs: number, max: number, now: number): boolean {
  const times = (limits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (times.length >= max) { limits.set(key, times); return false; }
  times.push(now);
  limits.set(key, times);
  // Keys of links gone quiet go, so the map stays as small as the links in use.
  if (limits.size > 500) for (const [k, list] of limits) if (list.every((t) => now - t >= LOOP_LIMIT.windowMs)) limits.delete(k);
  return true;
}

/** One pair of agents, the same key on both machines: each end as `machine/agent`. */
function pairKey(a: { machine: string; agentId: string }, b: { machine: string; agentId: string }): string {
  return `loop:${[`${a.machine}/${a.agentId}`, `${b.machine}/${b.agentId}`].sort().join('<>')}`;
}

const LOOP_MESSAGE = 'These two agents have sent each other many messages in a short time, so this connection is paused for a few minutes.';

// ── Sending ────────────────────────────────────────────────────────────────

/** The machine a wire's target is on, when it isn't this one. */
export function remoteMachineOf(targetId: string): string | null {
  const route = routeOf(parseAgentAddress(targetId), selfFingerprint());
  return 'machine' in route ? route.machine : null;
}

let deliveries = createAnnexDeliveryStore();
export type AgentCallBody = DurableAgentCall;
type OutboxItem = DeliveryOutboxItem;
type DeliveryAuthorization = { allowed: true } | { allowed: false; reason: string };
let authorizeQueuedCall: ((item: OutboxItem) => Promise<DeliveryAuthorization>) | undefined;
let onDeliveryFailure: ((notice: AnnexDeliveryFailure) => Promise<boolean | void>) | undefined;

const payloadHash = (body: AgentCallBody): string => deliveryHash({ from: body.from.agentId, to: body.to, tool: body.tool, args: body.args, ...(body.context && { context: body.context }), ...(body.epoch && { epoch: body.epoch }) });
const queuedResult = (callId: string, message: string): McpToolResult => text(`${message} delivery_id=${callId}. This confirms a durable queue, not model execution.`);

function outgoingEpoch(machine: string): AnnexDeliveryEpoch {
  return {
    sender: ownPairing()?.id ?? 'legacy',
    receiver: annexPeers.listPeers().find((p) => p.fingerprint.toLowerCase() === machine)?.pairingId ?? 'legacy',
  };
}

/** Version 1 is the atomic claim/receipt protocol, not an assertion by the calling agent. */
export function agentDeliveryCapabilities(): { deliveryVersion: 1; receiptBoundary: 'runtime-accepted' } {
  deliveries.get();
  return { deliveryVersion: 1, receiptBoundary: 'runtime-accepted' };
}

/** A sender may inspect only its own delivery, never another agent's payload. */
export function getDelivery(callerId: string, callId: string): AnnexDeliveryStatus | undefined {
  const found = deliveries.get().deliveries.find((r) => r.callId === callId && r.callerId === callerId);
  if (!found) return undefined;
  const { payloadHash: _hash, result: _result, failureNotified: _notified, ...status } = found;
  return status;
}

/**
 * A wire call to an agent on another machine. Called once this machine's checks
 * passed; the other machine checks it again against its own store.
 */
export async function forwardAgentCall(callerId: string, targetId: string, targetName: string, tool: string, args: Record<string, unknown>, now = Date.now(), context?: AnnexCallContext): Promise<McpToolResult> {
  const { agentId: to } = parseAgentAddress(targetId);
  const machine = remoteMachineOf(targetId);
  const self = selfFingerprint();
  if (!machine || !self || !transport) return text('That agent is on another machine, which this one is not connected to.', true);
  const machineName = transport.machineName(machine) ?? 'the other computer';
  if (!isNetworkComputer(machine)) return text(`${machineName} is not in this computer's Annex Network, so its agents can't be reached from here.`, true);
  if (context !== undefined && !validContext(context)) return text('The trusted Annex causal context is invalid or exceeds its depth limit.', true);
  args = structuredClone(args);
  if (context) context = structuredClone(context);
  const controllerLink = federationDirection({ agentId: callerId }, { agentId: to, machineId: machine });
  if (controllerLink && !FEDERATION_TOOLS.has(tool)) return text('That tool is fixed off on controller connections.', true);
  const controllerStatus = controllerLink && federationStatus({ agentId: callerId }, { agentId: to, machineId: machine });
  if (controllerStatus && controllerStatus.state === 'unavailable') return text(controllerStatus.reason, true);
  const sender = await describe(callerId);
  const epoch = outgoingEpoch(machine);
  const body: AgentCallBody = {
    v: AGENT_CALL_VERSION,
    callId: QUEUED_TOOLS.has(tool) && (args.idempotency_key !== undefined || args.task_id !== undefined)
      ? deliveryHash([self, callerId, machine, to, tool, args.idempotency_key ?? args.task_id, context?.rootId, epoch])
      : randomUUID(),
    from: { agentId: callerId, name: nameOfLocalSender?.(callerId) ?? sender?.name ?? callerId, ...(sender?.projectName && { projectName: sender.projectName }) },
    to,
    tool,
    args,
    epoch,
  };
  body.context = context ?? { rootId: body.callId, depth: 0 };
  if (args.idempotency_key !== undefined && (typeof args.idempotency_key !== 'string' || !args.idempotency_key.trim() || args.idempotency_key.length > 200)) {
    return text('idempotency_key must be a non-empty string of at most 200 characters.', true);
  }
  if (Buffer.byteLength(JSON.stringify(body)) > AGENT_CALL_MAX_BYTES) return text('That is too large to send to another computer. Send a shorter message, or a file it can read there.', true);

  if (QUEUED_TOOLS.has(tool)) {
    const previous = deliveries.get().deliveries.find((r) => r.callId === body.callId);
    if (previous) {
      if (previous.payloadHash !== payloadHash(body)) return text('idempotency_conflict: this delivery key already names different content. Use a new key for a new message.', true);
      return previous.result ?? queuedResult(body.callId, `Delivery is ${previous.state}${previous.reason ? `: ${previous.reason}` : ''}.`);
    }
  }
  // Counted here too, so the limit holds for messages both ways (D233).
  if (LOOP_TOOLS.has(tool) && !hit(pairKey({ machine: self, agentId: callerId }, { machine, agentId: to }), LOOP_LIMIT.windowMs, LOOP_LIMIT.messages, now)) return text(LOOP_MESSAGE, true);
  if (QUEUED_TOOLS.has(tool)) {
    // Behind what's already waiting for that machine, so messages keep their order.
    const online = transport.connected(machine);
    const behind = waitingFor(machine).length > 0;
    await queue(machine, body, targetId);
    if (online && !behind) {
      await flushOutbox(machine);
      const finished = deliveries.get().deliveries.find((r) => r.callId === body.callId);
      if (finished?.result) return finished.result;
    } else if (online) void flushOutbox(machine).catch(logFlushError);
    const taskId = typeof args.task_id === 'string' ? ` task_id=${args.task_id}.` : '';
    return online
      ? queuedResult(body.callId, `Queued for ${targetName} on ${machineName}, behind messages already on their way.${taskId}`)
      : queuedResult(body.callId, `${targetName} is on ${machineName}, which is offline. The message waits here until ${machineName} is back.${taskId}`);
  } else if (!transport.connected(machine)) {
    if (READ_TOOLS.has(tool)) return text(JSON.stringify({ status: 'offline', running: false, message: `${targetName} is on ${machineName}, which is offline.` }, null, 2));
    return text(`${targetName} is on ${machineName}, which is offline, so this can't be done now.`, true);
  }
  return send(machine, body, machineName);
}

async function send(machine: string, body: AgentCallBody, machineName: string): Promise<McpToolResult> {
  try {
    const response = await transport!.post(machine, '/api/v1/network/agent-call', body as unknown as Record<string, unknown>);
    const result = (response.body as { result?: McpToolResult } | null)?.result;
    if (response.status === 200 && result && Array.isArray(result.content)) return result;
    const message = (response.body as { message?: unknown } | null)?.message;
    return text(typeof message === 'string' ? message : `${machineName} didn't take the call.`, true);
  } catch (err) {
    appLog('core:annex', 'warn', 'An agent call to another machine failed', { meta: { tool: body.tool, error: err instanceof Error ? err.message : String(err) } });
    return text(`Couldn't reach ${machineName}. Try again in a moment.`, true);
  }
}

async function queue(machine: string, body: AgentCallBody, targetId: string): Promise<void> {
  await deliveries.update((file) => {
    const existing = file.deliveries.find((r) => r.callId === body.callId);
    if (existing) {
      if (existing.payloadHash !== payloadHash(body)) throw new Error('idempotency_conflict: this delivery key already names different content.');
      return;
    }
    if (file.outbox.length >= OUTBOX_MAX_TOTAL || file.outbox.filter((i) => i.machine === machine).length >= OUTBOX_MAX_PER_MACHINE) throw new Error('Too many messages are already waiting. Retry after earlier deliveries finish.');
    const queuedAt = new Date().toISOString();
    file.outbox.push({ id: body.callId, machine, body, queuedAt });
    file.deliveries.push({
      callId: body.callId, callerId: body.from.agentId, targetId, tool: body.tool,
      state: 'queued', queuedAt, updatedAt: queuedAt, attempts: 0, payloadHash: payloadHash(body),
    });
  });
}

/** Messages waiting for `machine`, in the order they were sent. */
export function waitingFor(machine: string): OutboxItem[] {
  return deliveries.get().outbox.filter((i) => i.machine === machine);
}

/**
 * Whether the other machine's answer means "try again later": it was busy, it
 * refused for its limits, or it wasn't ready for agent calls yet.
 */
function transient(status: number, body: unknown, queuedAt: string): boolean {
  const error = (body as { error?: unknown } | null)?.error;
  // A link made while the other machine was off may not have reached it yet: worth a few more tries.
  const young = Date.now() - Date.parse(queuedAt) < NOT_CONNECTED_GRACE_MS;
  return status >= 500 || status === 429 || (status === 404 && error === 'unavailable') || (status === 403 && error === 'not_connected' && young);
}

const flushing = new Set<string>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function retryLater(machine: string, delay = RETRY_MS): void {
  if (retryTimers.has(machine)) return;
  retryTimers.set(machine, setTimeout(() => {
    retryTimers.delete(machine);
    void syncThenFlush(machine);
  }, delay));
}

function logFlushError(err: unknown): void {
  appLog('core:annex', 'error', 'Durable agent delivery failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
}

let notifyingFailures: Promise<void> | undefined;
let noticeRetryTimer: ReturnType<typeof setTimeout> | undefined;

function notifyFailures(): Promise<void> {
  if (notifyingFailures) return notifyingFailures;
  const pending = deliverFailureNotices().finally(() => {
    if (notifyingFailures !== pending) return;
    notifyingFailures = undefined;
    if (onDeliveryFailure && !noticeRetryTimer && deliveries.get().deliveries.some((r) => r.failureNotified === false)) {
      noticeRetryTimer = setTimeout(() => {
        noticeRetryTimer = undefined;
        void notifyFailures().catch(logFlushError);
      }, RETRY_MS);
      noticeRetryTimer.unref?.();
    }
  });
  notifyingFailures = pending;
  return pending;
}

async function deliverFailureNotices(): Promise<void> {
  const callback = onDeliveryFailure;
  const store = deliveries;
  if (!callback) return;
  for (const status of store.get().deliveries.filter((r) => r.failureNotified === false)) {
    const notice = deliveryFailure(status);
    if (!notice) continue;
    if (await callback(notice) === false) continue;
    await store.update((file) => {
      const saved = file.deliveries.find((r) => r.callId === status.callId);
      if (saved) saved.failureNotified = true;
    });
  }
}

async function finishDelivery(item: OutboxItem, state: 'delivered' | 'refused' | 'expired' | 'indeterminate', result: McpToolResult, reason?: string): Promise<void> {
  await deliveries.update((file) => {
    const status = file.deliveries.find((r) => r.callId === item.id)!;
    Object.assign(status, { state, result: boundedDeliveryResult(result), updatedAt: new Date().toISOString(), ...(reason && { reason }) });
    delete status.nextAttemptAt;
    if (state !== 'delivered') status.failureNotified = false;
    file.outbox = file.outbox.filter((i) => i.id !== item.id);
  });
  if (state !== 'delivered') {
    appLog('core:annex', 'warn', 'An agent delivery ended without confirmed delivery', { meta: { callId: item.id, targetAgent: item.body.to, state, reason } });
    await notifyFailures();
  }
}

function receiptOf(raw: unknown, callId: string): AnnexDeliveryReceipt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const receipt = (raw as { delivery?: AnnexDeliveryReceipt }).delivery;
  if (!receipt || receipt.callId !== callId || !['delivered', 'refused', 'retry_later', 'indeterminate'].includes(receipt.state)) return undefined;
  if (receipt.reason !== undefined && (typeof receipt.reason !== 'string' || receipt.reason.length > 200)) return undefined;
  if ((receipt.state === 'delivered' || receipt.state === 'refused') && !Number.isFinite(Date.parse(receipt.receiptAt ?? ''))) return undefined;
  return receipt;
}

/** Connections first, so the other machine has the links its messages need; then what waited. */
async function syncThenFlush(machine: string): Promise<void> {
  try {
    if (await syncDirectionsWith(machine)) await flushOutbox(machine);
    else if (waitingFor(machine).length > 0) retryLater(machine);
  } catch (err) {
    // telemetry-exempt: logged; the next connect or retry tries again.
    appLog('core:annex', 'warn', 'Could not catch up with another machine', { meta: { error: err instanceof Error ? err.message : String(err) } });
    if (waitingFor(machine).length > 0) retryLater(machine);
  }
}

/**
 * Sends what waited for `machine`, in order. A transient answer stops the
 * flush, keeping the rest, and tries again a minute later; a refusal is final.
 * Only a durable receiving-tool receipt completes delivery. A transport ACK
 * alone says nothing about either runtime acceptance or model execution.
 */
export async function flushOutbox(machine: string): Promise<void> {
  if (flushing.has(machine) || !transport) return;
  const generation = lifecycle;
  const session = transport;
  const authorize = authorizeQueuedCall;
  flushing.add(machine);
  try {
    for (;;) {
      if (generation !== lifecycle) return;
      const item = waitingFor(machine)[0];
      if (!item) return;
      if (Date.now() - Date.parse(item.queuedAt) >= DELIVERY_MAX_AGE_MS) {
        await finishDelivery(item, 'expired', text('Delivery expired after seven days without a receiving receipt.', true), 'expired');
        continue;
      }
      if (!isNetworkComputer(machine)) {
        await finishDelivery(item, 'refused', text('The target computer is no longer authorized in this Annex Network.', true), 'peer_revoked');
        continue;
      }
      if (!item.body.epoch) {
        await finishDelivery(item, 'indeterminate', text('This pending delivery predates durable claims and pairing-bound identities. Earlier input acceptance cannot be proven; automatic redelivery is disabled.', true), 'legacy_delivery_unverified');
        continue;
      }
      if (item.body.epoch && deliveryHash(item.body.epoch) !== deliveryHash(outgoingEpoch(machine))) {
        const attempted = deliveries.get().deliveries.find((r) => r.callId === item.id)!.attempts > 0;
        await finishDelivery(item, attempted ? 'indeterminate' : 'refused', text('This delivery belongs to an earlier network pairing. No input was sent under the new authorization; any earlier acceptance is unconfirmed.', true), 'pairing_changed');
        continue;
      }
      const authorization = authorize ? await authorize(item) : { allowed: false as const, reason: 'Sender authorization is unavailable; this delivery cannot be sent.' };
      if (generation !== lifecycle) return;
      if (authorization.allowed === false) {
        await finishDelivery(item, 'refused', text(authorization.reason, true), 'authorization_revoked');
        continue;
      }
      if (!session.connected(machine)) return;
      const status = deliveries.get().deliveries.find((r) => r.callId === item.id)!;
      const delay = Date.parse(status.nextAttemptAt ?? '') - Date.now();
      if (delay > 0) { retryLater(machine, delay); return; }
      let supported: boolean;
      try { supported = await session.supportsDurableDelivery(machine); }
      catch (err) {
        tel.exception(Object.assign(new Error('annex_delivery_capability_failed'), { stack: undefined }), { origin: 'main', handled: true });
        if (generation !== lifecycle) return;
        appLog('core:annex', 'warn', 'Could not negotiate durable agent delivery', { meta: { error: err instanceof Error ? err.message : String(err) } });
        await deliveries.update((file) => {
          Object.assign(file.deliveries.find((r) => r.callId === item.id)!, { state: 'retry_later', reason: 'capability_check_unavailable', nextAttemptAt: new Date(Date.now() + RETRY_MS).toISOString() });
        });
        retryLater(machine);
        return;
      }
      if (generation !== lifecycle) return;
      if (!supported) {
        await finishDelivery(item, status.attempts ? 'indeterminate' : 'refused', text('The other computer does not support durable delivery. Update it before sending new work. No input was sent by this attempt; any earlier acceptance is unconfirmed.', true), 'durable_delivery_unsupported');
        continue;
      }
      await deliveries.update((file) => {
        const saved = file.deliveries.find((r) => r.callId === item.id)!;
        saved.state = 'sending';
        saved.attempts++;
        saved.updatedAt = new Date().toISOString();
      });
      if (generation !== lifecycle) return;
      const currentAuthorization = await authorize!(item);
      if (generation !== lifecycle) return;
      if (currentAuthorization.allowed === false) {
        await finishDelivery(item, 'refused', text(currentAuthorization.reason, true), 'authorization_revoked');
        continue;
      }
      if (!isNetworkComputer(machine) || deliveryHash(item.body.epoch) !== deliveryHash(outgoingEpoch(machine))) {
        await finishDelivery(item, 'refused', text('The network pairing changed before input was sent.', true), 'pairing_changed');
        continue;
      }
      if (!session.connected(machine)) return;
      let reason = 'transport_unavailable';
      let response: { status: number; body: unknown } | undefined;
      try {
        response = await session.post(machine, '/api/v1/network/agent-call', item.body as unknown as Record<string, unknown>);
      } catch (err) {
        tel.exception(Object.assign(new Error('annex_delivery_transport_failed'), { stack: undefined }), { origin: 'main', handled: true });
        appLog('core:annex', 'warn', 'A durable agent delivery attempt failed', { meta: { callId: item.id, error: err instanceof Error ? err.message : String(err) } });
      }
      if (generation !== lifecycle) return;
      if (response) {
        const receipt = receiptOf(response.body, item.id);
        const answer = (response.body as { result?: McpToolResult } | null)?.result;
        if (receipt?.state === 'delivered' && response.status === 200 && answer && !answer.isError && Array.isArray(answer.content)) {
          await finishDelivery(item, 'delivered', answer);
          continue;
        }
        if (receipt?.state === 'indeterminate') {
          await finishDelivery(item, 'indeterminate', text(receipt.reason ?? 'The receiver restarted during delivery. It will not run this call again; inspect the target before sending new work.', true), receipt.reason ?? 'receiver_interrupted');
          continue;
        }
        if (response.status >= 200 && response.status < 300 && (!receipt || receipt.state === 'delivered')) {
          await finishDelivery(item, 'indeterminate', text('The other computer answered without a valid durable receiving-tool receipt. Input may already have been accepted; automatic redelivery is disabled.', true), receipt ? 'invalid_durable_receipt' : 'missing_durable_receipt');
          continue;
        }
        if (receipt?.state === 'refused' || (response.status !== 200 && receipt?.state !== 'retry_later' && !transient(response.status, response.body, item.queuedAt))) {
          const message = (response.body as { message?: string } | null)?.message;
          await finishDelivery(item, 'refused', answer ?? text(message ?? receipt?.reason ?? 'The other computer refused this delivery.', true), receipt?.reason ?? `http_${response.status}`);
          continue;
        }
        reason = receipt?.reason ?? (answer?.isError ? 'tool_retry_later' : `http_${response.status}`);
      }
      const retry = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** Math.min(status.attempts, 6));
      await deliveries.update((file) => {
        const saved = file.deliveries.find((r) => r.callId === item.id)!;
        Object.assign(saved, { state: 'retry_later', reason, nextAttemptAt: new Date(Date.now() + retry).toISOString(), updatedAt: new Date().toISOString() });
      });
      if (generation !== lifecycle) return;
      retryLater(machine, retry);
      return;
    }

  } finally {
    if (generation === lifecycle) flushing.delete(machine);
  }
}

// ── Receiving ──────────────────────────────────────────────────────────────

export type AgentCallRefusal = { status: 400 | 403 | 404 | 429 | 503; error: string; message: string; delivery?: AnnexDeliveryReceipt };
export type AgentCallOutcome = { result: McpToolResult; delivery?: AnnexDeliveryReceipt } | AgentCallRefusal;

/** Call ids run here lately, running or done, so a sender's retry after a lost answer isn't run twice. */
const seenCalls = new Map<string, { hash: string; outcome: Promise<AgentCallOutcome> }>();

function parseBody(raw: unknown): AgentCallBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const from = b.from as Record<string, unknown> | undefined;
  const str = (v: unknown, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (b.v !== AGENT_CALL_VERSION || !str(b.callId) || !str(b.to) || !str(b.tool, 100)) return null;
  if (!from || !str(from.agentId) || String(from.agentId).includes('@') || !str(from.name)) return null;
  if (from.projectName !== undefined && !str(from.projectName)) return null;
  if (!b.args || typeof b.args !== 'object' || Array.isArray(b.args)) return null;
  if (b.context !== undefined && !validContext(b.context)) return null;
  if (b.epoch !== undefined && (!b.epoch || typeof b.epoch !== 'object'
    || !str((b.epoch as AnnexDeliveryEpoch).sender) || !str((b.epoch as AnnexDeliveryEpoch).receiver)
    || Object.keys(b.epoch).some((k) => !['sender', 'receiver'].includes(k)))) return null;
  return {
    v: AGENT_CALL_VERSION, callId: b.callId as string, to: b.to as string, tool: b.tool as string, args: b.args as Record<string, unknown>,
    from: { agentId: from.agentId as string, name: from.name as string, ...(from.projectName !== undefined && { projectName: from.projectName as string }) },
    ...(b.context !== undefined && { context: b.context as AnnexCallContext }),
    ...(b.epoch !== undefined && { epoch: b.epoch as AnnexDeliveryEpoch }),
  };
}

function validContext(raw: unknown): raw is AnnexCallContext {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const c = raw as Record<string, unknown>;
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200;
  return id(c.rootId) && Number.isSafeInteger(c.depth) && Number(c.depth) >= 0 && Number(c.depth) <= ANNEX_CALL_MAX_DEPTH
    && (c.parentId === undefined || id(c.parentId)) && Object.keys(c).every((k) => ['rootId', 'depth', 'parentId'].includes(k));
}

/**
 * A call from an agent on `senderMachine` (the pinned peer that sent it, a
 * computer in the network) to one of this machine's agents. Runs it when this
 * machine's store has the user's link for that direction and the tool isn't
 * turned off on it.
 */
export async function receiveAgentCall(senderMachine: string, raw: unknown, now = Date.now()): Promise<AgentCallOutcome> {
  const generation = lifecycle;
  const store = deliveries;
  const body = parseBody(raw);
  if (!body) return { status: 400, error: 'invalid_call', message: 'The call was not in a form this computer reads.' };
  const machine = senderMachine.toLowerCase();
  const self = selfFingerprint();
  if (!isNetworkComputer(machine)) return { status: 403, error: 'peer_revoked', message: 'That computer is not authorized in this Annex Network.' };
  const currentEpoch = outgoingEpoch(machine);
  if (body.epoch && (body.epoch.sender !== currentEpoch.receiver || body.epoch.receiver !== currentEpoch.sender)) {
    return { status: 403, error: 'pairing_changed', message: 'That delivery belongs to an earlier network pairing.' };
  }
  const to = parseAgentAddress(body.to);
  if (!self || !routeOf(to, self).local) return { status: 404, error: 'wrong_machine', message: 'That agent is not on this computer.' };
  const dispatcher = remoteDispatcher?.isTarget(to.agentId) ? remoteDispatcher : undefined;
  if (!(dispatcher ? DISPATCHER_CALL_TOOLS : AGENT_CALL_TOOLS).has(body.tool)) return { status: 403, error: 'tool_not_allowed', message: `${body.tool} can't be used from another computer for that target.` };
  if (dispatcher && !dispatcher.isAvailable(to.agentId)) return { status: 403, error: 'dispatcher_unavailable', message: 'That Dispatcher is not available for federation calls.' };
  const from: ConnectionEnd = { agentId: body.from.agentId, machineId: machine };
  const direction = getConnectionDirection(from, { agentId: to.agentId });
  // The same answer whether or not the agent exists, as for local wires.
  if (!dispatcher && !direction?.link && !activeAgentLinks(direction).length) return { status: 403, error: 'not_connected', message: 'That agent is not connected to you on its computer.' };
  if (!dispatcher && direction?.disabledTools.includes(body.tool)) return { status: 403, error: 'tool_denied', message: `${body.tool} is turned off on this connection.` };
  if (federationDirection(from, { agentId: to.agentId }) && !FEDERATION_TOOLS.has(body.tool)) return { status: 403, error: 'tool_denied', message: 'That tool is fixed off on controller connections.' };
  const key = `${machine}/${deliveryHash(currentEpoch)}/${body.callId}`;
  const hash = payloadHash(body);
  let saved: ReceiverDelivery | undefined;
  try { saved = store.get().inbox.find((r) => r.key === key); }
  catch (err) {
    tel.exception(Object.assign(new Error('annex_delivery_receipt_store_failed'), { stack: undefined }), { origin: 'main', handled: true });
    return receiverStoreFailure(err);
  }
  if (saved && saved.payloadHash !== hash) return { status: 400, error: 'idempotency_conflict', message: 'This call id already names different content.' };
  const seen = seenCalls.get(key);
  if (seen) return seen.hash === hash ? seen.outcome : { status: 400, error: 'idempotency_conflict', message: 'This call id is already running with different content.' };
  if (saved && saved.state !== 'retry_later') return replayReceipt(body, saved);
  if (!hit(`rate:${machine}/${body.from.agentId}>${to.agentId}`, RATE_LIMIT.windowMs, RATE_LIMIT.calls, now)) {
    return { status: 429, error: 'rate_limited', message: 'Too many calls on this connection. Wait a minute and try again.' };
  }
  if (LOOP_TOOLS.has(body.tool) && !hit(pairKey({ machine, agentId: body.from.agentId }, { machine: self, agentId: to.agentId }), LOOP_LIMIT.windowMs, LOOP_LIMIT.messages, now)) {
    return { status: 429, error: 'loop_limited', message: LOOP_MESSAGE };
  }
  const run = runTool;
  if (!run && !dispatcher) return { status: 404, error: 'unavailable', message: 'Agents on this computer can’t be reached yet.' };
  const callerId = formatAgentAddress({ agentId: body.from.agentId, machine });
  appLog('core:annex', 'info', 'Agent call from another machine', { meta: { tool: body.tool, targetAgent: to.agentId } });
  const running = (async (): Promise<AgentCallOutcome> => {
    const target = await describe(to.agentId);
    const caller: RemoteCaller = {
      name: body.from.name,
      machineName: annexPeers.listPeers().find((p) => p.fingerprint.toLowerCase() === machine)?.alias || 'another computer',
      ...(body.from.projectName && { projectName: body.from.projectName }),
      ...(target?.name && { targetName: target.name }),
      machineId: machine, agentId: body.from.agentId, deliveryId: body.callId, context: body.context ?? { rootId: body.callId, depth: 0 },
    };
    try {
      await store.update((file) => {
        const existing = file.inbox.find((r) => r.key === key);
        const at = new Date().toISOString();
        if (existing) { existing.state = 'claimed'; existing.updatedAt = at; delete existing.result; delete existing.reason; }
        else file.inbox.push({ key, payloadHash: hash, state: 'claimed', createdAt: at, updatedAt: at });
      });
    } catch (err) {
      tel.exception(Object.assign(new Error('annex_delivery_receipt_store_failed'), { stack: undefined }), { origin: 'main', handled: true });
      return receiverStoreFailure(err);
    }
    // Both the description lookup and the durable claim yielded: revocation
    // during either must stop the side effect, even for an in-flight call.
    const current = getConnectionDirection(from, { agentId: to.agentId });
    let result: AgentToolRunResult;
    if (generation !== lifecycle || !isNetworkComputer(machine) || deliveryHash(currentEpoch) !== deliveryHash(outgoingEpoch(machine))
      || (dispatcher ? !dispatcher.isTarget(to.agentId) || !dispatcher.isAvailable(to.agentId) : (!current?.link && !activeAgentLinks(current).length) || current.disabledTools.includes(body.tool))) {
      result = { ...text('The connection was revoked before this call ran.', true), annexDelivery: { state: 'refused', reason: 'authorization_revoked' } };
    } else {
      try {
        result = await remoteCallers.run(caller, () => dispatcher
          ? dispatcher.receive({ origin: { machineId: machine, machineName: caller.machineName, agentId: body.from.agentId, agentName: body.from.name }, targetId: to.agentId, deliveryId: body.callId, cause: caller.context, tool: body.tool, args: body.args })
          : run!(body.tool, to.agentId, callerId, body.args));
      }
      catch (err) {
        tel.exception(Object.assign(new Error('annex_delivery_receiver_tool_failed'), { stack: undefined }), { origin: 'main', handled: true });
        appLog('core:annex', 'error', 'A receiving agent tool failed after its durable claim', { meta: { callId: body.callId, error: err instanceof Error ? err.message : String(err) } });
        result = { ...text('The receiving tool failed after starting. Its side effect is unknown; this call will not be run again.', true), annexDelivery: { state: 'indeterminate', reason: 'tool_interrupted' } };
      }
    }
    // Unclassified errors may follow a partial side effect. Only an explicit
    // safe-to-retry marker can release the claim for another execution.
    const classified = result.annexDelivery?.state ?? (result.isError ? 'indeterminate' : 'delivered');
    const state = classified === 'delivered' && result.isError ? 'indeterminate' : classified;
    const reason = result.annexDelivery?.reason ?? (result.isError ? 'unclassified_tool_error' : undefined);
    const retained = boundedDeliveryResult({ content: result.content, ...(result.isError && { isError: true }) });
    try {
      await store.update((file) => {
        const record = file.inbox.find((r) => r.key === key)!;
        Object.assign(record, { state, result: retained, updatedAt: new Date().toISOString(), ...(reason && { reason }) });
      });
    } catch (err) {
      tel.exception(Object.assign(new Error('annex_delivery_receipt_store_failed'), { stack: undefined }), { origin: 'main', handled: true });
      return receiverStoreFailure(err);
    }
    const outcome = replayReceipt(body, store.get().inbox.find((r) => r.key === key)!);
    return !QUEUED_TOOLS.has(body.tool) && 'result' in outcome ? { ...outcome, result: { content: result.content, ...(result.isError && { isError: true }) } } : outcome;
  })();
  seenCalls.set(key, { hash, outcome: running });
  try { return await running; }
  finally { if (seenCalls.get(key)?.outcome === running) seenCalls.delete(key); }
}

function receiverStoreFailure(err: unknown): AgentCallRefusal {
  logFlushError(err);
  return { status: 503, error: 'delivery_store_unavailable', message: 'The receiving computer could not persist a delivery receipt. Retry only with the same call id.' };
}

function replayReceipt(body: AgentCallBody, record: ReceiverDelivery): AgentCallOutcome {
  const state = record.state === 'claimed' ? 'indeterminate' : record.state;
  const reason = record.state === 'claimed' ? 'receiver_interrupted' : record.reason;
  const result = record.result ?? text('The receiver restarted during this call. It will not run it again because input may already have been accepted. Inspect the target before sending new work.', true);
  return {
    result,
    delivery: { callId: body.callId, state, receiptAt: record.updatedAt, ...(reason && { reason }) },
  };
}

// ── Keeping both machines' copies of a direction ───────────────────────────

/** A direction as sent between machines: both ends name their machine. */
export interface WireDirection {
  from: { agentId: string; machine: string; name?: string };
  to: { agentId: string; machine: string; name?: string };
  disabledTools: string[];
  link: boolean;
  /** New peers distinguish a user link from agent sources; absent means legacy link. */
  userLink?: boolean;
  agentLinks?: Array<{ agentId: string; machineId: string; createdAt: string; name?: string; removedAt?: string; removedByUser?: boolean }>;
  setByAgent?: string;
  toolsProtected?: boolean;
  updatedAt: string;
}

/** Names of agents on other machines, as their machine told this one. */
const names = createSettingsStore<{ version: number; names: Record<string, string> }>(
  'annex-agent-names.json',
  { version: 1, names: {} },
  undefined,
  { atomic: true, audit: { key: 'annex_agent_names' } },
);

export function remoteAgentName(address: string): string | undefined {
  return names.get()?.names?.[address];
}

async function learnNames(learned: Record<string, string>): Promise<void> {
  if (Object.keys(learned).length === 0) return;
  await names.update((file) => {
    const all = { ...(file.names ?? {}), ...learned };
    const keys = Object.keys(all);
    // The oldest go first once there are too many.
    for (const k of keys.slice(0, Math.max(0, keys.length - NAMES_MAX))) delete all[k];
    return { version: 1, names: all };
  });
}

/** Remember what an agent on another machine is called, as the person picked it. */
export async function rememberRemoteAgentName(address: string, name: string): Promise<void> {
  if (!name || name.length > 200) return;
  await learnNames({ [address]: name });
}

function absolute(end: ConnectionEnd, self: string): { agentId: string; machine: string } {
  return { agentId: end.agentId, machine: (end.machineId ?? self).toLowerCase() };
}

function relative(end: { agentId: string; machine: string }, self: string): ConnectionEnd {
  return end.machine.toLowerCase() === self ? { agentId: end.agentId } : { agentId: end.agentId, machineId: end.machine.toLowerCase() };
}

/** Only the other endpoint receives this direction; sources are never relayed. */
function peersFor(d: Pick<ConnectionDirection, 'from' | 'to' | 'agentLinks'>, self: string): string[] {
  return [...new Set([d.from.machineId, d.to.machineId]
    .filter((machine): machine is string => !!machine && machine.toLowerCase() !== self).map((machine) => machine.toLowerCase()))];
}

async function toWire(d: ConnectionDirection, self: string): Promise<WireDirection> {
  const nameOf = async (end: ConnectionEnd) => (end.machineId
    ? remoteAgentName(formatAgentAddress({ agentId: end.agentId, machine: end.machineId }))
    : (await describe(end.agentId))?.name);
  const from = absolute(d.from, self);
  const to = absolute(d.to, self);
  const fromName = await nameOf(d.from);
  const toName = await nameOf(d.to);
  let toolsProtected: boolean | undefined;
  if (!d.from.machineId && d.agentLinks?.length) {
    const { collectSourcesByPair } = await import('./persisted-bindings');
    const { bySource, failed } = await collectSourcesByPair();
    const targetId = d.to.machineId ? formatAgentAddress({ agentId: d.to.agentId, machine: d.to.machineId }) : d.to.agentId;
    const key = `${d.from.agentId}\u0000${targetId}`;
    toolsProtected = !!d.link || !d.setByAgent || failed.length > 0 || [...bySource].some(([id, keys]) => id !== 'network-agent-connections' && keys.has(key));
  }
  return {
    from: { ...from, ...(fromName && { name: fromName }) },
    to: { ...to, ...(toName && { name: toName }) },
    disabledTools: !d.from.machineId && !d.to.machineId && !localWakeOn(d) ? [...new Set([...d.disabledTools, WAKE_TOOL])] : d.disabledTools, link: !!d.link || !!activeAgentLinks(d).length, userLink: !!d.link,
    agentLinks: d.agentLinks ?? [], ...(d.setByAgent && { setByAgent: d.setByAgent }), ...(toolsProtected !== undefined && { toolsProtected }), updatedAt: d.updatedAt,
  };
}

let listDirections: () => ConnectionDirection[] = () => listAllConnectionDirections();

/** One sync at a time per machine; a change during one sends again after it, and callers wait for the last pass. */
const syncing = new Map<string, Promise<boolean>>();
const syncAgain = new Set<string>();

/**
 * Sends `machine` every direction this one has with it, and takes the newer of
 * what it answers with: its own share, so both copies meet even when only one
 * of the two can reach the other. Resolves whether the last pass got through.
 */
export function syncDirectionsWith(machine: string): Promise<boolean> {
  const running = syncing.get(machine);
  if (running) { syncAgain.add(machine); return running; }
  const run = (async () => {
    let ok = false;
    try {
      do {
        syncAgain.delete(machine);
        ok = await exchangeShare(machine);
      } while (syncAgain.has(machine));
      return ok;
    } finally {
      syncing.delete(machine);
    }
  })();
  syncing.set(machine, run);
  return run;
}

/** This machine's directions with `machine`, as sent: the most recent first, at most one request's worth. */
async function shareFor(machine: string, self: string): Promise<WireDirection[]> {
  const share = listDirections().filter((d) => peersFor(d, self).includes(machine))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return Promise.all(share.slice(0, DIRECTIONS_PER_REQUEST).map((d) => toWire(d, self)));
}

async function exchangeShare(machine: string): Promise<boolean> {
  const self = selfFingerprint();
  if (!self || !transport?.connected(machine) || !isNetworkComputer(machine)) return false;
  const publication = captureControllerPublication(machine);
  const owner = federation;
  try {
    const directions = await shareFor(machine, self);
    if (!publication.current()) return false;
    const response = await transport.post(machine, '/api/v1/network/connections', { v: AGENT_CALL_VERSION, directions: directions as unknown as Record<string, unknown>[], ...(owner && { controller: owner.local(), epoch: publication.epoch }), ...(owner?.extra && { extra: owner.extra.local() }) });
    if (response.status !== 200 || !publication.current()) return false;
    const answer = response.body as { controller?: unknown; epoch?: unknown; extra?: unknown } | null;
    if ((answer?.epoch !== undefined || (owner && answer?.controller !== undefined)) && !publicationEpochMatches(answer?.epoch, publication.epoch)) return false;
    if (owner && answer?.controller !== undefined) {
      await owner.learn(machine, answer.controller, publication);
    }
    // The lead (#3351) only under the same authenticated pairing as the controller.
    if (owner?.extra && answer?.extra !== undefined && publicationEpochMatches(answer.epoch, publication.epoch)) {
      await owner.extra.learn(machine, answer.extra, publication);
    }
    if (!publication.current()) return false;
    const theirs = (response.body as { directions?: unknown } | null)?.directions;
    if (Array.isArray(theirs) && theirs.length > 0) await receiveDirections(machine, { v: AGENT_CALL_VERSION, directions: theirs });
    return true;
  } catch (err) {
    // telemetry-exempt: logged; the next connect or change sends them again.
    appLog('core:annex', 'warn', 'Could not exchange connections with another machine', { meta: { error: err instanceof Error ? err.message : String(err) } });
    return false;
  }
}

/** What this machine answers a sync from `machine` with: its own share, for the sender to take the newer of. */
export async function shareForAnswer(machine: string): Promise<WireDirection[]> {
  const self = selfFingerprint();
  return self && isNetworkComputer(machine) ? shareFor(machine.toLowerCase(), self) : [];
}

/**
 * Directions `senderMachine` (a computer in the network) says it has with this
 * one. Only directions between an agent here and one on the sender's machine
 * are taken, and only for agents here that exist; the newer copy wins.
 */
export async function receiveDirections(senderMachine: string, raw: unknown, now = Date.now(), authenticated?: FederationPublicationGuard): Promise<{ applied: number } | AgentCallRefusal> {
  const self = selfFingerprint();
  const machine = senderMachine.toLowerCase();
  const list = (raw as { v?: unknown; directions?: unknown } | null);
  if (!self || !list || list.v !== AGENT_CALL_VERSION || !Array.isArray(list.directions) || list.directions.length > DIRECTIONS_PER_REQUEST) {
    return { status: 400, error: 'invalid_connections', message: 'The connections were not in a form this computer reads.' };
  }
  const publication = authenticated ?? captureControllerPublication(machine);
  const metadata = raw as { controller?: unknown; epoch?: unknown; extra?: unknown };
  if (!publication.current() || (metadata.epoch !== undefined && !publicationEpochMatches(metadata.epoch, publication.epoch))) {
    return { status: 403, error: 'pairing_changed', message: 'The network pairing changed during this connection exchange.' };
  }
  if (federation && metadata.controller !== undefined) {
    if (!publicationEpochMatches(metadata.epoch, publication.epoch)) return { status: 400, error: 'invalid_controller_epoch', message: 'Controller publication requires its authenticated network pairing.' };
    await federation.learn(machine, metadata.controller, publication);
    if (!publication.current()) return { status: 403, error: 'pairing_changed', message: 'The network pairing changed before controller publication committed.' };
  }
  if (federation?.extra && metadata.extra !== undefined && publicationEpochMatches(metadata.epoch, publication.epoch)) {
    await federation.extra.learn(machine, metadata.extra, publication);
    if (!publication.current()) return { status: 403, error: 'pairing_changed', message: 'The network pairing changed before the lead record committed.' };
  }
  let applied = 0;
  // Links count toward the cap; a link turned off (a deleted agent's, say) doesn't.
  let kept = listDirections().filter((d) => peersFor(d, self).includes(machine) && (!!d.link || !!activeAgentLinks(d).length)).length;
  const learned: Record<string, string> = {};
  for (const entry of list.directions as WireDirection[]) {
    const ok = entry && entry.from && entry.to && typeof entry.from.agentId === 'string' && typeof entry.to.agentId === 'string'
      && typeof entry.from.machine === 'string' && typeof entry.to.machine === 'string' && Array.isArray(entry.disabledTools)
      && entry.from.agentId.length <= 200 && entry.to.agentId.length <= 200
      && typeof entry.updatedAt === 'string' && !Number.isNaN(Date.parse(entry.updatedAt))
      && !entry.from.agentId.includes('@') && !entry.to.agentId.includes('@');
    if (!ok) continue;
    const machines = [entry.from.machine.toLowerCase(), entry.to.machine.toLowerCase()];
    if (machines.some((m) => m !== self && !isNetworkComputer(m))) continue;
    const legacyPair = machines.includes(self) && machines.includes(machine);
    // Both this computer and the authenticated sender must be endpoints.
    if (!legacyPair) continue;
    const from = relative(entry.from, self);
    const to = relative(entry.to, self);
    const localEnds = [from, to].filter((end) => !end.machineId);
    if (federationDirection(from, to)) continue;
    const current = getConnectionDirection(from, to);
    if (typeof entry.link !== 'boolean') continue;
    const userLink = typeof entry.userLink === 'boolean' ? entry.userLink : entry.link;
    const agentLinks = Array.isArray(entry.agentLinks) ? entry.agentLinks.filter((link) => {
      if (!link || typeof link.agentId !== 'string' || !link.agentId || link.agentId.length > 200
        || typeof link.machineId !== 'string' || (link.machineId.toLowerCase() !== self && !isNetworkComputer(link.machineId.toLowerCase()))
        || typeof link.createdAt !== 'string' || Number.isNaN(Date.parse(link.createdAt))) return false;
      if (link.machineId.toLowerCase() === machine) return true;
      if (typeof link.removedAt !== 'string' || Number.isNaN(Date.parse(link.removedAt))) return false;
      // A non-creator can remove a source as the user, or clear an existing
      // user-removal tombstone when this endpoint explicitly reconnects.
      return link.removedByUser === true || !!current?.agentLinks?.some((saved) => saved.agentId === link.agentId
        && saved.machineId === link.machineId.toLowerCase() && saved.removedByUser);
    }).slice(0, 50).map((link) => ({
      agentId: link.agentId, machineId: link.machineId.toLowerCase(),
      createdAt: Date.parse(link.createdAt) > now + CLOCK_SKEW_MS ? new Date(now).toISOString() : link.createdAt,
      ...(typeof link.name === 'string' && link.name.length <= 200 && { name: link.name }),
      ...(typeof link.removedAt === 'string' && !Number.isNaN(Date.parse(link.removedAt)) && { removedAt: Date.parse(link.removedAt) > now + CLOCK_SKEW_MS ? new Date(now).toISOString() : link.removedAt }),
      ...(link.removedByUser === true && { removedByUser: true }),
    })) : [];
    const active = !!userLink || agentLinks.some((link) => !link.removedAt);
    if (active && !entry.link) continue; // Both the legacy flag and the source list must agree.
    // A link only for an agent here that exists; a link turned off only matters where there's one to turn off.
    if (localEnds.length === 0 && !current) continue;
    if (active || agentLinks.length > 0) {
      if ((await Promise.all(localEnds.map((end) => describe(end.agentId)))).some((found) => !found)) continue;
    } else if (!current) continue;
    if (active && !current?.link && !activeAgentLinks(current).length && kept >= DIRECTIONS_PER_MACHINE) continue;
    if (!publication.current()) return { status: 403, error: 'pairing_changed', message: 'The network pairing changed during this connection exchange.' };
    const updatedAt = Date.parse(entry.updatedAt) > now + CLOCK_SKEW_MS ? new Date(now).toISOString() : entry.updatedAt;
    const tools = [...new Set(entry.disabledTools.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 100))].slice(0, 50);
    // An agent-authored update can add its source, but cannot overwrite a person's source or saved switches.
    const agentAuthored = typeof entry.setByAgent === 'string' && agentLinks.some((l) => l.agentId === entry.setByAgent && l.machineId === machine && !l.removedAt);
    const untrustedAgentClaim = typeof entry.setByAgent === 'string' && !agentAuthored;
    let protectUserTools = untrustedAgentClaim || (!!current && (agentAuthored && (current.setByAgent !== entry.setByAgent || !!current.link)));
    let protectedLive: { disabledTools?: string[]; enabledTools?: string[] } | undefined;
    if (untrustedAgentClaim && !current) continue;
    if (agentAuthored && !from.machineId) {
      const { collectSourcesByPair } = await import('./persisted-bindings');
      const { bySource, failed } = await collectSourcesByPair();
      const targetId = to.machineId ? formatAgentAddress({ agentId: to.agentId, machine: to.machineId }) : to.agentId;
      const key = `${from.agentId}\u0000${targetId}`;
      if (failed.length || [...bySource].some(([id, keys]) => id !== 'network-agent-connections' && keys.has(key))) {
        protectUserTools = true;
        const { bindingManager } = await import('./clubhouse-mcp/binding-manager');
        protectedLive = bindingManager.getBindingsForAgent(from.agentId).find((binding) => binding.targetId === targetId);
        if (!current && !protectedLive) continue; // An unreadable source must not have its switches guessed.
      }
    }
    if (!publication.current()) return { status: 403, error: 'pairing_changed', message: 'The network pairing changed during connection source inspection.' };
    const effectiveUserLink = protectUserTools || !legacyPair ? !!current?.link : userLink;
    const wrote = await putConnectionDirection({
      from, to, disabledTools: protectUserTools ? current?.disabledTools ?? protectedLive?.disabledTools ?? [] : tools,
      ...(!from.machineId && !to.machineId && (protectUserTools ? localWakeOn(current, protectedLive?.enabledTools) : !tools.includes(WAKE_TOOL)) && { enabledTools: [WAKE_TOOL] }),
      ...(effectiveUserLink && { link: { createdAt: current?.link?.createdAt ?? updatedAt } }),
      ...(agentLinks.length && { agentLinks }),
      ...(entry.from.machine.toLowerCase() === machine && typeof entry.toolsProtected === 'boolean' && { agentToolsProtected: entry.toolsProtected }),
      ...(!protectUserTools && agentAuthored && typeof entry.setByAgent === 'string' && entry.setByAgent.length <= 200 && { setByAgent: entry.setByAgent }),
      ...(protectUserTools && current?.setByAgent && { setByAgent: current.setByAgent }),
      updatedAt: protectUserTools && current ? current.updatedAt : updatedAt,
    }, { allowUserReconnect: true });
    if (!wrote) continue;
    applied++;
    if (active && !current?.link && !activeAgentLinks(current).length) kept++;
    for (const remoteEnd of [entry.from, entry.to].filter((end) => end.machine.toLowerCase() !== self)) {
      if (typeof remoteEnd.name === 'string' && remoteEnd.name.length > 0 && remoteEnd.name.length <= 200) learned[formatAgentAddress({ agentId: remoteEnd.agentId, machine: remoteEnd.machine })] = remoteEnd.name;
    }
  }
  await learnNames(learned);
  return { applied };
}

// ── Startup ────────────────────────────────────────────────────────────────

export interface StartAgentCallsOptions {
  transport: AgentCallTransport;
  runTool: AgentToolRunner;
  describeLocalAgent: DescribeAgent;
  /** Outgoing display name only; never used to establish a local connection endpoint. */
  nameOfLocalSender?: (agentId: string) => string | undefined;
  /** Every direction in the store (tests pass their own). */
  listDirections?: () => ConnectionDirection[];
  /** Recheck the sender's live grants and connection before every queued attempt. */
  authorizeQueuedCall?: (item: OutboxItem) => Promise<DeliveryAuthorization>;
  /** Idempotent by callId: queue a sender notice and record action history. */
  onDeliveryFailure?: (notice: AnnexDeliveryFailure) => Promise<boolean | void>;
  /** Tests may reopen the same persisted store to simulate another process. */
  deliveryStore?: AnnexDeliveryStore;
  /** Fixed controller capability; never selected by agent arguments or editable tool names. */
  remoteDispatcher?: DispatcherAgentCallReceiver;
  federation?: {
    local(): unknown; learn(machine: string, raw: unknown, guard: FederationPublicationGuard): Promise<void>;
    /** More federation state on the same exchange, as `extra` (the lead, #3351), learned under the same guard. */
    extra?: { local(): unknown; learn(machine: string, raw: unknown, guard: FederationPublicationGuard): Promise<void> };
  };
}

export function startAgentCalls(options: StartAgentCallsOptions): () => void {
  const generation = ++lifecycle;
  transport = options.transport;
  runTool = options.runTool;
  describeLocalAgent = options.describeLocalAgent;
  nameOfLocalSender = options.nameOfLocalSender;
  if (options.deliveryStore) deliveries = options.deliveryStore;
  authorizeQueuedCall = options.authorizeQueuedCall;
  onDeliveryFailure = options.onDeliveryFailure;
  remoteDispatcher = options.remoteDispatcher;
  federation = options.federation;
  if (options.listDirections) listDirections = options.listDirections;
  const offConnected = options.transport.onConnected((machine) => { void syncThenFlush(machine); });
  // A change here to a direction with another machine is sent to it at once, when connected.
  const offChanged = onConnectionGrantsChanged((from, to) => {
    const self = selfFingerprint();
    const direction = getConnectionDirection(from, to);
    if (self && direction) for (const machine of peersFor(direction, self)) void syncDirectionsWith(machine);
  });
  void (async () => {
    await notifyFailures();
    const members = federation ? annexPeers.listPeers().filter((p) => p.role === 'member' && p.kind !== 'phone').map((p) => p.fingerprint.toLowerCase()) : [];
    for (const machine of new Set([...members, ...deliveries.get().outbox.map((i) => i.machine)])) await syncThenFlush(machine);
  })().catch(logFlushError);
  return () => {
    if (generation !== lifecycle) return;
    lifecycle++;
    offConnected();
    offChanged();
    transport = null;
    runTool = null;
    describeLocalAgent = describeNothing;
    nameOfLocalSender = undefined;
    authorizeQueuedCall = undefined;
    onDeliveryFailure = undefined;
    remoteDispatcher = undefined;
    federation = undefined;
    listDirections = () => listAllConnectionDirections();
    _resetAgentCallsForTesting();
  };
}

/** For tests: no messages waiting. */
export async function _clearOutboxForTesting(): Promise<void> {
  await deliveries.clearForTesting();
}

/** For tests. */
export function _resetAgentCallsForTesting(): void {
  limits.clear();
  seenCalls.clear();
  flushing.clear();
  syncing.clear();
  syncAgain.clear();
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  if (noticeRetryTimer) clearTimeout(noticeRetryTimer);
  noticeRetryTimer = undefined;
  notifyingFailures = undefined;
}
