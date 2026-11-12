import { createHash } from 'crypto';
import type {
  AnnexCallContext, AnnexDeliveryEpoch, AnnexDeliveryProtocolName, AnnexProtocolApprovalReference,
  AnnexProtocolSourceCall, AuthenticatedAnnexOrigin,
} from '../../shared/annex-delivery';
import type { AgentToolRunResult } from './annex-agent-calls';
import type { DurableAgentCall } from './annex-delivery-store';

export type { AnnexDeliveryProtocolName } from '../../shared/annex-delivery';
export const ANNEX_PROTOCOL_MAX_BYTES = 512 * 1024;
export const ANNEX_PROTOCOL_CONTEXT_MAX_BYTES = 16 * 1024;

export interface AnnexProtocolEnvelope extends DurableAgentCall {
  protocol: AnnexDeliveryProtocolName;
  commandId: string;
  context: AnnexCallContext;
  epoch: AnnexDeliveryEpoch;
}

export interface AnnexProtocolLocalContext {
  senderMachine: string;
  sourceCall: AnnexProtocolSourceCall;
  localAuthorization?: AnnexProtocolApprovalReference;
}

export interface AnnexProtocolOutgoing {
  readonly machine: string;
  readonly senderMachine: string;
  readonly sourceCall: Readonly<AnnexProtocolSourceCall>;
  readonly wirePayloadHash: string;
  readonly body: Immutable<AnnexProtocolEnvelope>;
}

export interface AnnexProtocolIncoming {
  readonly origin: Readonly<AuthenticatedAnnexOrigin>;
  readonly receiverMachine: string;
  readonly wirePayloadHash: string;
  readonly body: Immutable<AnnexProtocolEnvelope>;
}

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

export type AnnexProtocolAuthorization = { allowed: true } | { allowed: false; reason: string };

export interface AnnexDeliveryProtocol {
  name: AnnexDeliveryProtocolName;
  tools: Readonly<Record<string, 'durable' | 'read'>>;
  authorizeOutgoing(request: AnnexProtocolOutgoing, localAuthorization?: Readonly<AnnexProtocolApprovalReference>): Promise<AnnexProtocolAuthorization>;
  checkOutgoing(request: AnnexProtocolOutgoing, localAuthorization?: Readonly<AnnexProtocolApprovalReference>): AnnexProtocolAuthorization;
  authorizeIncoming(request: AnnexProtocolIncoming): AnnexProtocolAuthorization;
  receive(request: AnnexProtocolIncoming): Promise<AgentToolRunResult>;
}

export interface AnnexProtocolCall {
  protocol: AnnexDeliveryProtocolName;
  machine: string;
  callerId: string;
  targetId: string;
  tool: string;
  args: Record<string, unknown>;
  commandId: string;
  context?: AnnexCallContext;
  sourceCall: AnnexProtocolSourceCall;
}

const tools: Readonly<Record<AnnexDeliveryProtocolName, Readonly<Record<string, 'durable' | 'read'>>>> = {
  federation: { get_status: 'read', check_connectivity: 'read', send_message: 'durable', send_file: 'durable', hand_off_request: 'durable' },
  handoff: { offer: 'durable', snapshot: 'durable', cancel: 'durable', get: 'read', capacity: 'read' },
};
const registrations = new Map<AnnexDeliveryProtocolName, Readonly<AnnexDeliveryProtocol>>();
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const keysOnly = (value: object, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));

export function isAnnexDeliveryProtocolName(value: unknown): value is AnnexDeliveryProtocolName {
  return typeof value === 'string' && own(tools, value);
}

export function annexProtocolToolMode(name: AnnexDeliveryProtocolName, tool: string): 'durable' | 'read' | undefined {
  return own(tools[name], tool) ? tools[name][tool] : undefined;
}

/** Registration is internal and deliberately absent from production startup. */
export function registerAnnexDeliveryProtocol(protocol: AnnexDeliveryProtocol): () => void {
  if (!isAnnexDeliveryProtocolName(protocol.name) || registrations.has(protocol.name)) throw new Error('Unknown or already registered Annex delivery protocol.');
  const allowed = tools[protocol.name];
  if (!record(protocol.tools) || Object.keys(protocol.tools).length !== Object.keys(allowed).length
    || Object.entries(protocol.tools).some(([tool, mode]) => !own(allowed, tool) || allowed[tool] !== mode)
    || ['authorizeOutgoing', 'checkOutgoing', 'authorizeIncoming', 'receive'].some((key) => typeof protocol[key as keyof AnnexDeliveryProtocol] !== 'function')) {
    throw new Error('An Annex protocol requires every fixed tool mode and explicit async claim, current-scope checks and receiver.');
  }
  const registered = Object.freeze({ ...protocol, tools: Object.freeze({ ...protocol.tools }) });
  registrations.set(protocol.name, registered);
  return () => { if (registrations.get(protocol.name) === registered) registrations.delete(protocol.name); };
}

export function annexDeliveryProtocol(name: AnnexDeliveryProtocolName): Readonly<AnnexDeliveryProtocol> | undefined {
  return registrations.get(name);
}

export function annexProtocolVersions(): Partial<Record<AnnexDeliveryProtocolName, 1>> {
  const versions: Partial<Record<AnnexDeliveryProtocolName, 1>> = {};
  for (const name of registrations.keys()) versions[name] = 1;
  return versions;
}

/**
 * JSON.stringify alone drops properties and coerces unsupported values. An
 * approved scope must instead reject them, without invoking accessors/toJSON.
 */
export function snapshotAnnexProtocolJson(value: unknown): unknown {
  const active = new Set<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 100) throw new Error('Annex protocol JSON nesting exceeds its limit.');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input) && !Object.is(input, -0)) return input;
    if (!input || typeof input !== 'object') throw new Error('Annex protocol arguments must contain only lossless JSON values.');
    if (active.has(input)) throw new Error('Annex protocol arguments cannot contain cycles.');
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error('Annex protocol arguments must contain only plain JSON objects and arrays.');
    }
    active.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== 'string' || (array && key === 'length' ? false : !descriptors[key].enumerable || !own(descriptors[key], 'value')))) {
      throw new Error('Annex protocol arguments cannot contain symbols, accessors or hidden properties.');
    }
    let output: unknown;
    if (array) {
      if (keys.length !== input.length + 1) throw new Error('Annex protocol arrays cannot contain holes or extra properties.');
      const entries: unknown[] = [];
      for (let index = 0; index < input.length; index++) {
        if (!own(input, index)) throw new Error('Annex protocol arrays cannot contain holes.');
        entries.push(visit(descriptors[String(index)].value, depth + 1));
      }
      output = entries;
    } else {
      output = Object.fromEntries(Object.keys(descriptors).sort().map((key) => [key, visit(descriptors[key].value, depth + 1)]));
    }
    active.delete(input);
    return Object.freeze(output);
  };
  return visit(value, 0);
}

function isCause(value: unknown): value is AnnexCallContext {
  return record(value) && keysOnly(value, ['rootId', 'depth', 'parentId']) && string(value.rootId)
    && Number.isSafeInteger(value.depth) && Number(value.depth) >= 0 && Number(value.depth) <= 8
    && (value.parentId === undefined || string(value.parentId));
}

function isSourceCall(value: unknown): value is AnnexProtocolSourceCall {
  return record(value) && keysOnly(value, ['toolName', 'callKey']) && string(value.toolName, 2000) && string(value.callKey, 4000);
}

function isLocalContext(value: unknown): value is AnnexProtocolLocalContext {
  return record(value) && keysOnly(value, ['senderMachine', 'sourceCall', 'localAuthorization'])
    && string(value.senderMachine) && isSourceCall(value.sourceCall)
    && (value.localAuthorization === undefined || (record(value.localAuthorization)
      && keysOnly(value.localAuthorization, ['requestId']) && string(value.localAuthorization.requestId)));
}

function isCall(value: unknown): value is AnnexProtocolCall {
  return record(value) && keysOnly(value, ['protocol', 'machine', 'callerId', 'targetId', 'tool', 'args', 'commandId', 'context', 'sourceCall'])
    && isAnnexDeliveryProtocolName(value.protocol) && string(value.machine) && string(value.callerId) && !value.callerId.includes('@')
    && string(value.targetId) && !value.targetId.includes('@') && string(value.tool, 100) && !!annexProtocolToolMode(value.protocol, value.tool)
    && record(value.args) && string(value.commandId) && (value.context === undefined || isCause(value.context)) && isSourceCall(value.sourceCall);
}

export function snapshotAnnexProtocolCall(value: unknown): AnnexProtocolCall {
  const call = snapshotAnnexProtocolJson(value);
  if (!isCall(call)) throw new Error('Invalid Main-local Annex protocol preparation input.');
  return call;
}

function isEnvelope(value: unknown): value is AnnexProtocolEnvelope {
  if (!record(value) || !keysOnly(value, ['v', 'callId', 'from', 'to', 'tool', 'args', 'context', 'epoch', 'protocol', 'commandId'])) return false;
  const { from, context, epoch } = value;
  return value.v === 1 && string(value.callId) && string(value.commandId) && isAnnexDeliveryProtocolName(value.protocol)
    && string(value.to) && !value.to.includes('@') && string(value.tool, 100) && !!annexProtocolToolMode(value.protocol, value.tool)
    && record(from) && keysOnly(from, ['agentId', 'name', 'projectName']) && string(from.agentId) && !from.agentId.includes('@')
    && string(from.name) && (from.projectName === undefined || string(from.projectName))
    && record(value.args) && isCause(context)
    && record(epoch) && keysOnly(epoch, ['sender', 'receiver']) && string(epoch.sender) && string(epoch.receiver)
    && epoch.sender !== 'legacy' && epoch.receiver !== 'legacy';
}

export function snapshotAnnexProtocolEnvelope(value: unknown): AnnexProtocolEnvelope {
  const body = snapshotAnnexProtocolJson(value);
  if (!isEnvelope(body)) throw new Error('Invalid full Annex protocol envelope or fixed operation.');
  if (Buffer.byteLength(JSON.stringify(body)) > ANNEX_PROTOCOL_MAX_BYTES) throw new Error('The complete Annex protocol envelope exceeds 512 KiB.');
  return body;
}

export function annexProtocolWireHash(body: AnnexProtocolEnvelope): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function snapshotAnnexProtocolContext(value: unknown): AnnexProtocolLocalContext {
  const context = snapshotAnnexProtocolJson(value);
  if (!isLocalContext(context) || Buffer.byteLength(JSON.stringify(context)) > ANNEX_PROTOCOL_CONTEXT_MAX_BYTES) {
    throw new Error('Invalid bounded Main-local Annex protocol context.');
  }
  return context;
}
