import { formatAgentAddress, isMachineFingerprint } from './agent-address';
import { DEFAULT_DISPATCHER_NAME } from './dispatcher-name';

/** Membership owns these links; neither agents nor the connection editor may widen them. */
export const DISPATCHER_FEDERATION_TOOLS = [
  'get_status', 'check_connectivity', 'send_message', 'send_file', 'hand_off_request',
] as const;

export type DispatcherFederationTool = typeof DISPATCHER_FEDERATION_TOOLS[number];
export type DispatcherFederationPresence = 'online' | 'working' | 'asleep' | 'offline' | 'unavailable';
export type DispatcherFederationLinkState = 'active' | 'paused' | 'tripped' | 'unavailable';
export type DispatcherFederationTrip = 'causal_depth' | 'rate_limit' | 'queue_limit';

export interface DispatcherFederationIdentity {
  controllerId: string;
  name: string;
  enabled: boolean;
  running: boolean;
  working: boolean;
}

export function dispatcherFederationIdentity(state: {
  agentId: string | null;
  config: { name: string } | null;
  enabled: boolean;
  running: boolean;
  requestsUnderWay: number;
}): DispatcherFederationIdentity | undefined {
  return state.agentId ? {
    controllerId: state.agentId, name: state.config?.name || DEFAULT_DISPATCHER_NAME,
    enabled: state.enabled, running: state.running, working: state.requestsUnderWay > 0,
  } : undefined;
}

/** An authoritative membership/presence snapshot, not fields read from an agent's message. */
export interface DispatcherFederationMember {
  machineId: string;
  machineName: string;
  role: 'member' | 'controller' | 'satellite';
  kind: 'desktop' | 'phone';
  connected: boolean;
  lastSeen?: string;
  dispatcher?: DispatcherFederationIdentity;
  /** Last authenticated routing identity; not evidence that the controller is currently available. */
  controller?: Pick<DispatcherFederationIdentity, 'controllerId' | 'name'>;
}

export interface DispatcherFederationPeer {
  machineId: string;
  machineName: string;
  name: string;
  /** Absent until this member has announced its controller. Never guess its id. */
  address?: string;
  presence: DispatcherFederationPresence;
  link: DispatcherFederationLinkState;
  reason?: 'local_dispatcher_off' | 'dispatcher_off' | 'status_unknown' | DispatcherFederationTrip;
  lastSeen?: string;
}

/** The origin established by the authenticated receiving transport, separately from the payload. */
export interface DispatcherFederationOrigin {
  machineId: string;
  machineName: string;
  agentId: string;
  agentName: string;
}

/** Persisted with the receiving request, so a later CLI turn cannot reset a reply's depth. */
export interface DispatcherFederationCause {
  rootId: string;
  depth: number;
  parentId?: string;
}

export interface DispatcherRemoteRequestOrigin extends DispatcherFederationOrigin {
  requestId: string;
  cause: DispatcherFederationCause;
}

export type DispatcherFederationOutcome = 'under_way' | 'waiting_user' | 'answered' | 'declined' | 'failed' | 'completed';
export type DispatcherRemoteTriage = 'now' | 'next_check_in' | 'needs_user' | 'decline';

export interface DispatcherFederationReply {
  requestId: string;
  outcome: DispatcherFederationOutcome;
}

export type DispatcherFederationPayload =
  | { tool: 'get_status' }
  | { tool: 'check_connectivity' }
  | { tool: 'send_message'; message: string; taskId?: string; reply?: DispatcherFederationReply }
  | { tool: 'send_file'; content: string; filename?: string; taskId?: string }
  | { tool: 'hand_off_request'; request: string; requestId: string };

export type DispatcherFederationParseResult =
  | { ok: true; payload: DispatcherFederationPayload }
  | { ok: false; code: 'tool_not_allowed' | 'invalid_args'; message: string };

export const FEDERATION_TEXT_MAX = 16_000;
export const FEDERATION_FILE_MAX = 128_000;
export const FEDERATION_CAUSAL_DEPTH_MAX = 8;

export function isDispatcherFederationTool(tool: string): tool is DispatcherFederationTool {
  return DISPATCHER_FEDERATION_TOOLS.some((allowed) => allowed === tool);
}

/** Labels are constructed from structured origin, never by interpreting the message's words. */
export function dispatcherFederationLabel(origin: Pick<DispatcherFederationOrigin, 'agentName' | 'machineName'>): string {
  return `${origin.agentName || DEFAULT_DISPATCHER_NAME} on ${origin.machineName}`;
}

export function dispatcherFederationPeers(
  localMachineId: string,
  localEnabled: boolean,
  members: readonly DispatcherFederationMember[],
  trips: ReadonlyMap<string, DispatcherFederationTrip> = new Map(),
): DispatcherFederationPeer[] {
  const peers = new Map<string, DispatcherFederationPeer>();
  for (const member of members) {
    const machineId = member.machineId.toLowerCase();
    if (member.role !== 'member' || member.kind !== 'desktop' || machineId === localMachineId.toLowerCase()) continue;
    const dispatcher = member.connected ? member.dispatcher : undefined;
    const identity = member.dispatcher ?? member.controller;
    const trip = trips.get(machineId);
    const reason = !localEnabled ? 'local_dispatcher_off'
      : dispatcher?.enabled === false ? 'dispatcher_off'
      : trip ?? (!identity || (member.connected && !dispatcher) ? 'status_unknown' : undefined);
    const unavailable = reason === 'local_dispatcher_off' || reason === 'dispatcher_off' || reason === 'status_unknown';
    const link: DispatcherFederationLinkState = unavailable ? 'unavailable' : trip ? 'tripped' : member.connected ? 'active' : 'paused';
    // Disconnected snapshots are historical: a previously working controller is not still working now.
    const presence: DispatcherFederationPresence = !member.connected ? 'offline'
      : dispatcher?.enabled === false ? 'unavailable'
      : !dispatcher ? 'unavailable'
      : dispatcher.working ? 'working' : dispatcher.running ? 'online' : 'asleep';
    peers.set(machineId, {
      machineId, machineName: member.machineName, name: identity?.name || DEFAULT_DISPATCHER_NAME,
      ...(identity?.controllerId && { address: formatAgentAddress({ agentId: identity.controllerId, machine: machineId }) }),
      presence, link, ...(reason && { reason }), ...(member.lastSeen && { lastSeen: member.lastSeen }),
    });
  }
  return [...peers.values()].sort((a, b) => a.machineId.localeCompare(b.machineId));
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function optionalText(value: unknown, max: number): value is string | undefined {
  return value === undefined || text(value, max);
}

/** Remote snapshots are wire input even when a TypeScript interface describes them. */
export function isDispatcherFederationIdentity(value: unknown): value is DispatcherFederationIdentity {
  return object(value) && text(value.controllerId, 200) && !value.controllerId.includes('@')
    && text(value.name, 200) && typeof value.enabled === 'boolean'
    && typeof value.running === 'boolean' && typeof value.working === 'boolean';
}

export function isDispatcherFederationCause(value: unknown): value is DispatcherFederationCause {
  return object(value) && text(value.rootId, 100) && Number.isSafeInteger(value.depth)
    && typeof value.depth === 'number' && value.depth >= 0
    && optionalText(value.parentId, 100);
}

export function isDispatcherRemoteRequestOrigin(value: unknown): value is DispatcherRemoteRequestOrigin {
  return object(value) && typeof value.machineId === 'string' && isMachineFingerprint(value.machineId)
    && text(value.machineName, 200) && text(value.agentId, 200) && !value.agentId.includes('@')
    && text(value.agentName, 200) && text(value.requestId, 100) && isDispatcherFederationCause(value.cause);
}

function reply(value: unknown): value is DispatcherFederationReply {
  return object(value) && onlyKeys(value, ['requestId', 'outcome']) && text(value.requestId, 100)
    && ['under_way', 'waiting_user', 'answered', 'declined', 'failed', 'completed'].includes(String(value.outcome));
}

/**
 * An exact allowlist on the receiving controller. This deliberately does not
 * accept permission answers, grants, settings, arbitrary tool names or origin.
 */
export function parseDispatcherFederationCall(tool: string, args: unknown): DispatcherFederationParseResult {
  if (!isDispatcherFederationTool(tool)) {
    return { ok: false, code: 'tool_not_allowed', message: `${tool} is never available on a controller link.` };
  }
  const invalid: DispatcherFederationParseResult = { ok: false, code: 'invalid_args', message: `Invalid arguments for ${tool} on a controller link.` };
  if (!object(args)) return invalid;
  switch (tool) {
    case 'get_status':
    case 'check_connectivity':
      return onlyKeys(args, []) ? { ok: true, payload: { tool } } : invalid;
    case 'send_message':
      if (!onlyKeys(args, ['message', 'task_id', 'force_submit', 'federation_reply'])
        || !text(args.message, FEDERATION_TEXT_MAX) || !optionalText(args.task_id, 100)
        || (args.force_submit !== undefined && args.force_submit !== true)
        || (args.federation_reply !== undefined && !reply(args.federation_reply))) return invalid;
      return {
        ok: true, payload: {
          tool, message: args.message, ...(args.task_id && { taskId: args.task_id }),
          ...(args.federation_reply && { reply: args.federation_reply as DispatcherFederationReply }),
        },
      };
    case 'send_file':
      if (!onlyKeys(args, ['content', 'filename', 'task_id']) || !text(args.content, FEDERATION_FILE_MAX)
        || !optionalText(args.task_id, 100) || !optionalText(args.filename, 100)) return invalid;
      if (typeof args.filename === 'string' && (/[\\/]/.test(args.filename)
        || [...args.filename].some((char) => char.charCodeAt(0) < 32)
        || args.filename === '.' || args.filename === '..')) return invalid;
      return { ok: true, payload: { tool, content: args.content, ...(args.filename && { filename: args.filename }), ...(args.task_id && { taskId: args.task_id }) } };
    case 'hand_off_request':
      return onlyKeys(args, ['request', 'origin_request_id']) && text(args.request, FEDERATION_TEXT_MAX) && text(args.origin_request_id, 100)
        ? { ok: true, payload: { tool, request: args.request, requestId: args.origin_request_id } } : invalid;
  }
}
