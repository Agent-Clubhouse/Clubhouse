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
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { formatAgentAddress, parseAgentAddress, routeOf } from '../../shared/agent-address';
import { CONNECTION_TOOLS, WAKE_TOOL, type AgentAddress as ConnectionEnd, type ConnectionDirection } from '../../shared/connection-grants';
import type { McpToolResult } from './clubhouse-mcp/types';
import * as annexIdentity from './annex-identity';
import * as annexPeers from './annex-peers';
import { appLog } from './log-service';
import { createSettingsStore } from './settings-store';
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
const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const RETRY_MS = 60_000;
/** Directions sent per request, and kept with any one other machine. */
export const DIRECTIONS_PER_REQUEST = 200;
const DIRECTIONS_PER_MACHINE = 1000;
const NAMES_MAX = 2000;
/** A copy dated further ahead than this is taken as made now: another machine's clock can't pin it forever. */
const CLOCK_SKEW_MS = 5 * 60_000;
const SEEN_CALLS_MAX = 2000;
/** How long a queued message refused as "not connected" is tried again, in case the link hasn't arrived there yet. */
const NOT_CONNECTED_GRACE_MS = 10 * 60_000;

// ── Who is calling ──────────────────────────────────────────────────────────

/** The sender of a call that came from another machine, while its tool runs here. */
export interface RemoteCaller {
  name: string;
  machineName: string;
  projectName?: string;
  /** The name of the agent here it's calling, for the tool's answer. */
  targetName?: string;
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
  /** The name this machine knows `machine` by. */
  machineName(machine: string): string | undefined;
  /** Called each time a connection to a machine opens. */
  onConnected(listener: (machine: string) => void): () => void;
}

/** Runs one of this machine's agent tools for a caller, as a local wire call would. */
export type AgentToolRunner = (tool: string, targetId: string, callerId: string, args: Record<string, unknown>) => Promise<McpToolResult>;

type DescribeAgent = (agentId: string) => Promise<{ name: string; projectName?: string } | undefined>;
const describeNothing: DescribeAgent = async () => undefined;

let transport: AgentCallTransport | null = null;
let runTool: AgentToolRunner | null = null;
let describeLocalAgent: DescribeAgent = describeNothing;
let nameOfLocalSender: ((agentId: string) => string | undefined) | undefined;

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

interface OutboxItem {
  id: string;
  machine: string;
  body: AgentCallBody;
  queuedAt: string;
}

const outbox = createSettingsStore<{ version: number; items: OutboxItem[] }>(
  'annex-agent-outbox.json',
  { version: 1, items: [] },
  undefined,
  { atomic: true, audit: { key: 'annex_agent_outbox' } },
);

export interface AgentCallBody {
  v: number;
  callId: string;
  from: { agentId: string; name: string; projectName?: string };
  to: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * A wire call to an agent on another machine. Called once this machine's checks
 * passed; the other machine checks it again against its own store.
 */
export async function forwardAgentCall(callerId: string, targetId: string, targetName: string, tool: string, args: Record<string, unknown>, now = Date.now()): Promise<McpToolResult> {
  const { agentId: to } = parseAgentAddress(targetId);
  const machine = remoteMachineOf(targetId);
  const self = selfFingerprint();
  if (!machine || !self || !transport) return text('That agent is on another machine, which this one is not connected to.', true);
  const machineName = transport.machineName(machine) ?? 'the other computer';
  if (!isNetworkComputer(machine)) return text(`${machineName} is not in this computer's Annex Network, so its agents can't be reached from here.`, true);
  const sender = await describe(callerId);
  const body: AgentCallBody = {
    v: AGENT_CALL_VERSION,
    callId: randomUUID(),
    from: { agentId: callerId, name: nameOfLocalSender?.(callerId) ?? sender?.name ?? callerId, ...(sender?.projectName && { projectName: sender.projectName }) },
    to,
    tool,
    args,
  };
  if (Buffer.byteLength(JSON.stringify(body)) > AGENT_CALL_MAX_BYTES) return text('That is too large to send to another computer. Send a shorter message, or a file it can read there.', true);

  // Counted here too, so the limit holds for messages both ways (D233).
  if (LOOP_TOOLS.has(tool) && !hit(pairKey({ machine: self, agentId: callerId }, { machine, agentId: to }), LOOP_LIMIT.windowMs, LOOP_LIMIT.messages, now)) return text(LOOP_MESSAGE, true);
  if (QUEUED_TOOLS.has(tool)) {
    // Behind what's already waiting for that machine, so messages keep their order.
    const online = transport.connected(machine);
    if (!online || waitingFor(machine).length > 0) {
      const queued = await queue(machine, body);
      if (!queued) return text(`Too many messages are already waiting for ${machineName}. Try again once it's back.`, true);
      if (online) void flushOutbox(machine).catch(() => { /* telemetry-exempt: a failed flush retries on its own */ });
      const taskId = typeof args.task_id === 'string' ? ` task_id=${args.task_id}.` : '';
      return online
        ? text(`Queued for ${targetName} on ${machineName}, behind messages already on their way.${taskId}`)
        : text(`${targetName} is on ${machineName}, which is offline. The message waits here and is delivered when ${machineName} is back.${taskId}`);
    }
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

async function queue(machine: string, body: AgentCallBody): Promise<boolean> {
  let ok = false;
  await outbox.update((file) => {
    const items = fresh(file.items);
    if (items.filter((i) => i.machine === machine).length >= OUTBOX_MAX_PER_MACHINE) return { version: 1, items };
    ok = true;
    return { version: 1, items: [...items, { id: body.callId, machine, body, queuedAt: new Date().toISOString() }] };
  });
  return ok;
}

function fresh(items: unknown): OutboxItem[] {
  const now = Date.now();
  return (Array.isArray(items) ? items : []).filter((i: OutboxItem) =>
    i && typeof i.machine === 'string' && i.body && now - Date.parse(i.queuedAt) < OUTBOX_MAX_AGE_MS);
}

/** Messages waiting for `machine`, in the order they were sent. */
export function waitingFor(machine: string): OutboxItem[] {
  return fresh(outbox.get()?.items).filter((i) => i.machine === machine);
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

function retryLater(machine: string): void {
  if (retryTimers.has(machine)) return;
  retryTimers.set(machine, setTimeout(() => {
    retryTimers.delete(machine);
    void syncThenFlush(machine);
  }, RETRY_MS));
}

/** Connections first, so the other machine has the links its messages need; then what waited. */
async function syncThenFlush(machine: string): Promise<void> {
  try {
    if (await syncDirectionsWith(machine)) await flushOutbox(machine);
    else if (waitingFor(machine).length > 0) retryLater(machine);
  } catch (err) {
    // telemetry-exempt: logged; the next connect or retry tries again.
    appLog('core:annex', 'warn', 'Could not catch up with another machine', { meta: { error: err instanceof Error ? err.message : String(err) } });
  }
}

/**
 * Sends what waited for `machine`, in order. A transient answer stops the
 * flush, keeping the rest, and tries again a minute later; a refusal is final.
 * The receiver ignores a call id it has run, so a retry after a lost answer
 * doesn't deliver twice.
 */
export async function flushOutbox(machine: string): Promise<void> {
  if (flushing.has(machine) || !transport) return;
  flushing.add(machine);
  try {
    for (;;) {
      const item = waitingFor(machine)[0];
      if (!item || !transport?.connected(machine)) return;
      try {
        const response = await transport.post(machine, '/api/v1/network/agent-call', item.body as unknown as Record<string, unknown>);
        if (transient(response.status, response.body, item.queuedAt)) { retryLater(machine); return; }
        if (response.status !== 200) {
          appLog('core:annex', 'info', 'A waiting agent message was refused by the other machine', { meta: { tool: item.body.tool, status: response.status } });
        }
      } catch {
        // telemetry-exempt: the connection dropped or timed out; the rest wait for a retry.
        retryLater(machine);
        return;
      }
      await outbox.update((file) => ({ version: 1, items: fresh(file.items).filter((i) => i.id !== item.id) }));
    }
  } finally {
    flushing.delete(machine);
  }
}

// ── Receiving ──────────────────────────────────────────────────────────────

export type AgentCallRefusal = { status: 400 | 403 | 404 | 429; error: string; message: string };

/** Call ids run here lately, running or done, so a sender's retry after a lost answer isn't run twice. */
const seenCalls = new Map<string, Promise<McpToolResult>>();

function parseBody(raw: unknown): AgentCallBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const from = b.from as Record<string, unknown> | undefined;
  const str = (v: unknown, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (b.v !== AGENT_CALL_VERSION || !str(b.callId) || !str(b.to) || !str(b.tool, 100)) return null;
  if (!from || !str(from.agentId) || String(from.agentId).includes('@') || !str(from.name)) return null;
  if (from.projectName !== undefined && !str(from.projectName)) return null;
  if (!b.args || typeof b.args !== 'object' || Array.isArray(b.args)) return null;
  return {
    v: AGENT_CALL_VERSION, callId: b.callId as string, to: b.to as string, tool: b.tool as string, args: b.args as Record<string, unknown>,
    from: { agentId: from.agentId as string, name: from.name as string, ...(from.projectName !== undefined && { projectName: from.projectName as string }) },
  };
}

/**
 * A call from an agent on `senderMachine` (the pinned peer that sent it, a
 * computer in the network) to one of this machine's agents. Runs it when this
 * machine's store has the user's link for that direction and the tool isn't
 * turned off on it.
 */
export async function receiveAgentCall(senderMachine: string, raw: unknown, now = Date.now()): Promise<{ result: McpToolResult } | AgentCallRefusal> {
  const body = parseBody(raw);
  if (!body) return { status: 400, error: 'invalid_call', message: 'The call was not in a form this computer reads.' };
  const machine = senderMachine.toLowerCase();
  const self = selfFingerprint();
  const to = parseAgentAddress(body.to);
  if (!self || !routeOf(to, self).local) return { status: 404, error: 'wrong_machine', message: 'That agent is not on this computer.' };
  if (!AGENT_CALL_TOOLS.has(body.tool)) return { status: 403, error: 'tool_not_allowed', message: `${body.tool} can't be used from another computer.` };
  const seen = seenCalls.get(`${machine}/${body.callId}`);
  if (seen) return { result: await seen };
  const from: ConnectionEnd = { agentId: body.from.agentId, machineId: machine };
  const direction = getConnectionDirection(from, { agentId: to.agentId });
  // The same answer whether or not the agent exists, as for local wires.
  if (!direction?.link) return { status: 403, error: 'not_connected', message: 'That agent is not connected to you on its computer.' };
  if (direction.disabledTools.includes(body.tool)) return { status: 403, error: 'tool_denied', message: `${body.tool} is turned off on this connection.` };
  if (!hit(`rate:${machine}/${body.from.agentId}>${to.agentId}`, RATE_LIMIT.windowMs, RATE_LIMIT.calls, now)) {
    return { status: 429, error: 'rate_limited', message: 'Too many calls on this connection. Wait a minute and try again.' };
  }
  if (LOOP_TOOLS.has(body.tool) && !hit(pairKey({ machine, agentId: body.from.agentId }, { machine: self, agentId: to.agentId }), LOOP_LIMIT.windowMs, LOOP_LIMIT.messages, now)) {
    return { status: 429, error: 'loop_limited', message: LOOP_MESSAGE };
  }
  const run = runTool;
  if (!run) return { status: 404, error: 'unavailable', message: 'Agents on this computer can’t be reached yet.' };
  const callerId = formatAgentAddress({ agentId: body.from.agentId, machine });
  appLog('core:annex', 'info', 'Agent call from another machine', { meta: { tool: body.tool, targetAgent: to.agentId } });
  // Recorded before anything is awaited: a retry that arrives meanwhile waits for this run's answer.
  const running = (async () => {
    const target = await describe(to.agentId);
    const caller: RemoteCaller = {
      name: body.from.name,
      machineName: annexPeers.listPeers().find((p) => p.fingerprint.toLowerCase() === machine)?.alias || 'another computer',
      ...(body.from.projectName && { projectName: body.from.projectName }),
      ...(target?.name && { targetName: target.name }),
    };
    return remoteCallers.run(caller, () => run(body.tool, to.agentId, callerId, body.args));
  })();
  seenCalls.set(`${machine}/${body.callId}`, running);
  if (seenCalls.size > SEEN_CALLS_MAX) seenCalls.delete(seenCalls.keys().next().value as string);
  return { result: await running };
}

// ── Keeping both machines' copies of a direction ───────────────────────────

/** A direction as sent between machines: both ends name their machine. */
export interface WireDirection {
  from: { agentId: string; machine: string; name?: string };
  to: { agentId: string; machine: string; name?: string };
  disabledTools: string[];
  link: boolean;
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

/** The other machine a direction involves, if exactly one end is elsewhere. */
function otherMachine(d: Pick<ConnectionDirection, 'from' | 'to'>): string | null {
  if (d.from.machineId && !d.to.machineId) return d.from.machineId.toLowerCase();
  if (d.to.machineId && !d.from.machineId) return d.to.machineId.toLowerCase();
  return null;
}

async function toWire(d: ConnectionDirection, self: string): Promise<WireDirection> {
  const nameOf = async (end: ConnectionEnd) => (end.machineId
    ? remoteAgentName(formatAgentAddress({ agentId: end.agentId, machine: end.machineId }))
    : (await describe(end.agentId))?.name);
  const from = absolute(d.from, self);
  const to = absolute(d.to, self);
  const fromName = await nameOf(d.from);
  const toName = await nameOf(d.to);
  return {
    from: { ...from, ...(fromName && { name: fromName }) },
    to: { ...to, ...(toName && { name: toName }) },
    disabledTools: d.disabledTools, link: !!d.link, updatedAt: d.updatedAt,
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
  const share = listDirections().filter((d) => otherMachine(d) === machine)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return Promise.all(share.slice(0, DIRECTIONS_PER_REQUEST).map((d) => toWire(d, self)));
}

async function exchangeShare(machine: string): Promise<boolean> {
  const self = selfFingerprint();
  if (!self || !transport?.connected(machine) || !isNetworkComputer(machine)) return false;
  try {
    const directions = await shareFor(machine, self);
    const response = await transport.post(machine, '/api/v1/network/connections', { v: AGENT_CALL_VERSION, directions: directions as unknown as Record<string, unknown>[] });
    if (response.status !== 200) return false;
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
export async function receiveDirections(senderMachine: string, raw: unknown, now = Date.now()): Promise<{ applied: number } | AgentCallRefusal> {
  const self = selfFingerprint();
  const machine = senderMachine.toLowerCase();
  const list = (raw as { v?: unknown; directions?: unknown } | null);
  if (!self || !list || list.v !== AGENT_CALL_VERSION || !Array.isArray(list.directions) || list.directions.length > DIRECTIONS_PER_REQUEST) {
    return { status: 400, error: 'invalid_connections', message: 'The connections were not in a form this computer reads.' };
  }
  let applied = 0;
  // Links count toward the cap; a link turned off (a deleted agent's, say) doesn't.
  let kept = listDirections().filter((d) => otherMachine(d) === machine && !!d.link).length;
  const learned: Record<string, string> = {};
  for (const entry of list.directions as WireDirection[]) {
    const ok = entry && entry.from && entry.to && typeof entry.from.agentId === 'string' && typeof entry.to.agentId === 'string'
      && typeof entry.from.machine === 'string' && typeof entry.to.machine === 'string' && Array.isArray(entry.disabledTools)
      && entry.from.agentId.length <= 200 && entry.to.agentId.length <= 200
      && typeof entry.updatedAt === 'string' && !Number.isNaN(Date.parse(entry.updatedAt))
      && !entry.from.agentId.includes('@') && !entry.to.agentId.includes('@');
    if (!ok) continue;
    const ends = [entry.from.machine.toLowerCase(), entry.to.machine.toLowerCase()].sort().join(' ');
    // One end here and the other on the sender's machine: nothing else is the sender's to say.
    if (ends !== [machine, self].sort().join(' ')) continue;
    const from = relative(entry.from, self);
    const to = relative(entry.to, self);
    const localEnd = from.machineId ? to : from;
    const current = getConnectionDirection(from, to);
    // A link only for an agent here that exists; a link turned off only matters where there's one to turn off.
    if (entry.link ? !(await describe(localEnd.agentId)) : !current) continue;
    if (entry.link && !current?.link && kept >= DIRECTIONS_PER_MACHINE) continue;
    const updatedAt = Date.parse(entry.updatedAt) > now + CLOCK_SKEW_MS ? new Date(now).toISOString() : entry.updatedAt;
    const tools = [...new Set(entry.disabledTools.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 100))].slice(0, 50);
    const wrote = await putConnectionDirection({
      from, to, disabledTools: tools,
      ...(entry.link && { link: { createdAt: current?.link?.createdAt ?? updatedAt } }),
      updatedAt,
    });
    if (!wrote) continue;
    applied++;
    if (entry.link && !current?.link) kept++;
    const remoteEnd = entry.from.machine.toLowerCase() === self ? entry.to : entry.from;
    if (typeof remoteEnd.name === 'string' && remoteEnd.name.length > 0 && remoteEnd.name.length <= 200) {
      learned[formatAgentAddress({ agentId: remoteEnd.agentId, machine: remoteEnd.machine })] = remoteEnd.name;
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
}

export function startAgentCalls(options: StartAgentCallsOptions): () => void {
  transport = options.transport;
  runTool = options.runTool;
  describeLocalAgent = options.describeLocalAgent;
  nameOfLocalSender = options.nameOfLocalSender;
  if (options.listDirections) listDirections = options.listDirections;
  const offConnected = options.transport.onConnected((machine) => { void syncThenFlush(machine); });
  // A change here to a direction with another machine is sent to it at once, when connected.
  const offChanged = onConnectionGrantsChanged((from, to) => {
    const machine = otherMachine({ from, to });
    if (machine) void syncDirectionsWith(machine);
  });
  return () => {
    offConnected();
    offChanged();
    transport = null;
    runTool = null;
    describeLocalAgent = describeNothing;
    nameOfLocalSender = undefined;
    listDirections = () => listAllConnectionDirections();
    _resetAgentCallsForTesting();
  };
}

/** For tests: no messages waiting. */
export async function _clearOutboxForTesting(): Promise<void> {
  await outbox.update(() => ({ version: 1, items: [] }));
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
}
