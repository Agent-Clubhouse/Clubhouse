/**
 * Agents across machines (#3064, Annex Network stage 7).
 *
 * An agent's connection to an agent on another machine is a binding whose
 * target is that agent's address (`<agentId>@<machine>`, agent-address.ts).
 * Calling one of its tools runs nowhere here: after this machine's own checks
 * (the caller's grants, the wire's disabled tools), the call goes to the
 * target's machine over the pinned connection, which checks it against its
 * own connection store and runs it with the same tool code a local call uses.
 *
 * - The receiving machine is the gate (D129): it runs a call only when it has
 *   the user's link for that direction and the tool isn't turned off there.
 * - Loop and rate limits apply per link, on the receiving machine.
 * - The receiver sees the sender's name and machine, never "You".
 * - A machine that's offline: messages wait here and go when it's back;
 *   reads say it's offline; other calls are refused.
 * - Each direction that involves another machine is kept on both: the sender
 *   needs it for its tools, the receiver for its check. Every connect sends
 *   the other machine what this one has, and the newer side wins.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { formatAgentAddress, parseAgentAddress, routeOf } from '../../shared/agent-address';
import { CONNECTION_TOOLS, type AgentAddress as ConnectionEnd, type ConnectionDirection } from '../../shared/connection-grants';
import type { McpToolResult } from './clubhouse-mcp/types';
import * as annexIdentity from './annex-identity';
import * as annexPeers from './annex-peers';
import { appLog } from './log-service';
import { createSettingsStore } from './settings-store';
import {
  getConnectionDirection, listAllConnectionDirections, onConnectionGrantsChanged, putConnectionDirection,
} from './connection-grants-store';

export const AGENT_CALL_VERSION = 1;

/** The tools another machine's agent may call here, when its link allows them (D232). */
export const AGENT_CALL_TOOLS: ReadonlySet<string> = new Set([...CONNECTION_TOOLS.map((t) => t.tool), 'wake_agent']);
/** Tools whose call waits for an offline machine; the rest answer at once. */
const QUEUED_TOOLS = new Set(['send_message', 'send_file']);
const READ_TOOLS = new Set(['get_status', 'read_output', 'check_connectivity']);

export const AGENT_CALL_MAX_BYTES = 512 * 1024;
/** Per link, on the receiving machine (D233). */
export const RATE_LIMIT = { calls: 30, windowMs: 60_000 };
/** Messages both ways between one pair of agents, before the pair is paused for the rest of the window (D233). */
export const LOOP_LIMIT = { messages: 40, windowMs: 10 * 60_000 };
const OUTBOX_MAX = 200;
const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

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

let transport: AgentCallTransport | null = null;
let runTool: AgentToolRunner | null = null;
/** A local agent's name and project, for the receiver's sender label. */
type DescribeAgent = (agentId: string) => Promise<{ name: string; projectName?: string } | undefined>;
const describeNothing: DescribeAgent = async () => undefined;
let describeLocalAgent: DescribeAgent = describeNothing;

const selfFingerprint = (): string | undefined => annexIdentity.getIdentity()?.fingerprint.toLowerCase();

function text(message: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: message }], ...(isError && { isError: true }) };
}

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
export async function forwardAgentCall(callerId: string, targetId: string, targetName: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const { agentId: to } = parseAgentAddress(targetId);
  const machine = remoteMachineOf(targetId);
  if (!machine || !transport) return text('That agent is on another machine, which this one is not connected to.', true);
  const machineName = transport.machineName(machine) ?? 'the other computer';
  const self = await describeLocalAgent(callerId).catch((): undefined => undefined);
  const body: AgentCallBody = {
    v: AGENT_CALL_VERSION,
    callId: randomUUID(),
    from: { agentId: callerId, name: self?.name ?? callerId, ...(self?.projectName && { projectName: self.projectName }) },
    to,
    tool,
    args,
  };
  if (Buffer.byteLength(JSON.stringify(body)) > AGENT_CALL_MAX_BYTES) return text('That is too large to send to another computer. Send a shorter message, or a file it can read there.', true);

  if (!transport.connected(machine)) {
    if (QUEUED_TOOLS.has(tool)) {
      const queued = await queue(machine, body);
      if (!queued) return text(`${machineName} is offline and too many messages are already waiting for it. Try again once it's back.`, true);
      const taskId = typeof args.task_id === 'string' ? ` task_id=${args.task_id}.` : '';
      return text(`${targetName} is on ${machineName}, which is offline. The message waits here and is delivered when ${machineName} is back.${taskId}`);
    }
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
    if (items.length >= OUTBOX_MAX) return { version: 1, items };
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

let flushing = new Set<string>();

/** Sends what waited for `machine`, in order; stops at the first that can't be sent, to keep the order. */
export async function flushOutbox(machine: string): Promise<void> {
  if (flushing.has(machine) || !transport) return;
  flushing.add(machine);
  try {
    for (const item of waitingFor(machine)) {
      if (!transport.connected(machine)) return;
      try {
        const response = await transport.post(machine, '/api/v1/network/agent-call', item.body as unknown as Record<string, unknown>);
        // A refusal is final (the link went, the agent was deleted): sent, and not tried again.
        if (response.status >= 500) return;
        if (response.status !== 200) {
          appLog('core:annex', 'info', 'A waiting agent message was refused by the other machine', { meta: { tool: item.body.tool, status: response.status } });
        }
      } catch {
        // telemetry-exempt: the connection dropped; the rest wait for the next connect.
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

const limits = new Map<string, number[]>();

function hit(key: string, windowMs: number, max: number, now: number): boolean {
  const times = (limits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (times.length >= max) { limits.set(key, times); return false; }
  times.push(now);
  limits.set(key, times);
  return true;
}

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
 * A call from an agent on `senderMachine` (the pinned peer that sent it) to one
 * of this machine's agents. Runs it when this machine's store has the user's
 * link for that direction and the tool isn't turned off on it.
 */
export async function receiveAgentCall(senderMachine: string, raw: unknown, now = Date.now()): Promise<{ result: McpToolResult } | AgentCallRefusal> {
  const body = parseBody(raw);
  if (!body) return { status: 400, error: 'invalid_call', message: 'The call was not in a form this computer reads.' };
  const machine = senderMachine.toLowerCase();
  const to = parseAgentAddress(body.to);
  if (!routeOf(to, selfFingerprint()).local) return { status: 404, error: 'wrong_machine', message: 'That agent is not on this computer.' };
  if (!AGENT_CALL_TOOLS.has(body.tool)) return { status: 403, error: 'tool_not_allowed', message: `${body.tool} can't be used from another computer.` };
  const from: ConnectionEnd = { agentId: body.from.agentId, machineId: machine };
  const direction = getConnectionDirection(from, { agentId: to.agentId });
  // The same answer whether or not the agent exists, as for local wires.
  if (!direction?.link) return { status: 403, error: 'not_connected', message: 'That agent is not connected to you on its computer.' };
  if (direction.disabledTools.includes(body.tool)) return { status: 403, error: 'tool_denied', message: `${body.tool} is turned off on this connection.` };
  const link = `${machine}/${body.from.agentId}>${to.agentId}`;
  if (!hit(`rate:${link}`, RATE_LIMIT.windowMs, RATE_LIMIT.calls, now)) {
    return { status: 429, error: 'rate_limited', message: 'Too many calls on this connection. Wait a minute and try again.' };
  }
  if (QUEUED_TOOLS.has(body.tool)) {
    const pair = [`${machine}/${body.from.agentId}`, to.agentId].sort().join('<>');
    if (!hit(`loop:${pair}`, LOOP_LIMIT.windowMs, LOOP_LIMIT.messages, now)) {
      return { status: 429, error: 'loop_limited', message: 'These two agents have sent each other many messages in a short time, so this connection is paused for a few minutes.' };
    }
  }
  if (!runTool) return { status: 404, error: 'unavailable', message: 'Agents on this computer can’t be reached yet.' };
  const target = await describeLocalAgent(to.agentId).catch((): undefined => undefined);
  const caller: RemoteCaller = {
    name: body.from.name,
    machineName: annexPeers.listPeers().find((p) => p.fingerprint.toLowerCase() === machine)?.alias || 'another computer',
    ...(body.from.projectName && { projectName: body.from.projectName }),
    ...(target?.name && { targetName: target.name }),
  };
  const callerId = formatAgentAddress({ agentId: body.from.agentId, machine });
  appLog('core:annex', 'info', 'Agent call from another machine', { meta: { tool: body.tool, targetAgent: to.agentId } });
  const result = await remoteCallers.run(caller, () => runTool!(body.tool, to.agentId, callerId, body.args));
  return { result };
}

// ── Keeping both machines' copies of a direction ───────────────────────────

/** A direction as sent between machines: both ends name their machine. */
interface WireDirection {
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

/** Remember what an agent on another machine is called, as the person picked it. */
export async function rememberRemoteAgentName(address: string, name: string): Promise<void> {
  if (!name || name.length > 200) return;
  await names.update((file) => ({ version: 1, names: { ...(file.names ?? {}), [address]: name } }));
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
    : (await describeLocalAgent(end.agentId).catch((): undefined => undefined))?.name);
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

/** Sends `machine` every direction this one has with it. */
export async function syncDirectionsWith(machine: string): Promise<void> {
  const self = selfFingerprint();
  if (!self || !transport?.connected(machine)) return;
  const directions = await Promise.all(allDirections().filter((d) => otherMachine(d) === machine).map((d) => toWire(d, self)));
  if (directions.length === 0) return;
  try {
    await transport.post(machine, '/api/v1/network/connections', { v: AGENT_CALL_VERSION, directions: directions as unknown as Record<string, unknown>[] });
  } catch (err) {
    // telemetry-exempt: logged; the next connect sends them again.
    appLog('core:annex', 'warn', 'Could not send connections to another machine', { meta: { error: err instanceof Error ? err.message : String(err) } });
  }
}

let listDirections: () => ConnectionDirection[] = () => listAllConnectionDirections();
function allDirections(): ConnectionDirection[] {
  return listDirections();
}

/**
 * Directions `senderMachine` says it has with this one. Only directions between
 * an agent here and one on the sender's machine are taken; the newer copy wins.
 */
export async function receiveDirections(senderMachine: string, raw: unknown): Promise<{ applied: number } | AgentCallRefusal> {
  const self = selfFingerprint();
  const machine = senderMachine.toLowerCase();
  const list = (raw as { v?: unknown; directions?: unknown } | null);
  if (!self || !list || list.v !== AGENT_CALL_VERSION || !Array.isArray(list.directions) || list.directions.length > 500) {
    return { status: 400, error: 'invalid_connections', message: 'The connections were not in a form this computer reads.' };
  }
  let applied = 0;
  const learned: Record<string, string> = {};
  for (const entry of list.directions as WireDirection[]) {
    const ok = entry && entry.from && entry.to && typeof entry.from.agentId === 'string' && typeof entry.to.agentId === 'string'
      && typeof entry.from.machine === 'string' && typeof entry.to.machine === 'string' && Array.isArray(entry.disabledTools)
      && typeof entry.updatedAt === 'string' && !Number.isNaN(Date.parse(entry.updatedAt))
      && !entry.from.agentId.includes('@') && !entry.to.agentId.includes('@');
    if (!ok) continue;
    const ends = [entry.from.machine.toLowerCase(), entry.to.machine.toLowerCase()].sort().join(' ');
    // One end here and the other on the sender's machine: nothing else is the sender's to say.
    if (ends !== [machine, self].sort().join(' ')) continue;
    const from = relative(entry.from, self);
    const to = relative(entry.to, self);
    const current = getConnectionDirection(from, to);
    if (current && Date.parse(current.updatedAt) >= Date.parse(entry.updatedAt)) continue;
    const tools = entry.disabledTools.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 100);
    await putConnectionDirection({ from, to, disabledTools: tools, ...(entry.link && { link: { createdAt: current?.link?.createdAt ?? entry.updatedAt } }), updatedAt: entry.updatedAt });
    applied++;
    const remoteEnd = entry.from.machine.toLowerCase() === self ? entry.to : entry.from;
    if (typeof remoteEnd.name === 'string' && remoteEnd.name.length <= 200) learned[formatAgentAddress({ agentId: remoteEnd.agentId, machine: remoteEnd.machine })] = remoteEnd.name;
  }
  if (Object.keys(learned).length > 0) await names.update((file) => ({ version: 1, names: { ...(file.names ?? {}), ...learned } }));
  return { applied };
}

// ── Startup ────────────────────────────────────────────────────────────────

export interface StartAgentCallsOptions {
  transport: AgentCallTransport;
  runTool: AgentToolRunner;
  describeLocalAgent: DescribeAgent;
  /** Every direction in the store (tests pass their own). */
  listDirections?: () => ConnectionDirection[];
}

export function startAgentCalls(options: StartAgentCallsOptions): () => void {
  transport = options.transport;
  runTool = options.runTool;
  describeLocalAgent = options.describeLocalAgent;
  if (options.listDirections) listDirections = options.listDirections;
  const offConnected = options.transport.onConnected((machine) => {
    void syncDirectionsWith(machine).then(() => flushOutbox(machine));
  });
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
    listDirections = () => listAllConnectionDirections();
    limits.clear();
    flushing = new Set();
  };
}

/** For tests. */
export function _resetAgentCallsForTesting(): void {
  limits.clear();
  flushing = new Set();
}
