/** Bounded, passive display facts for one live runtime open; no transcript or command authority. */
import type { ChatDriverId, PermissionLevel } from './capabilities';
import { CHAT_DRIVER_IDS, PERMISSION_LEVELS } from './capabilities';
import type { ChatEventDataMap, ChatMcpServer, TokenUsage, UsageLimit } from './events';
import type { ContextLimits } from '../context-window';
import type { ChatProviderInventory } from './provider-inventory';
import type { ChatProviderSkills } from './provider-skills';

export interface DisplayUsage { tokens?: TokenUsage; costUsd?: number; costIsEstimate?: boolean }
export interface ChatDetailsValues {
  cliVersion?: string;
  model?: string | null;
  models?: Array<{ id: string; label: string }>;
  effort?: { value: string | null; isDefault: boolean };
  level?: PermissionLevel;
  capabilities?: { subagents: 'full' | 'ids_only' | 'none'; usage: 'cost' | 'tokens' | 'context' | 'none'; limits: boolean };
  contextLimits?: ContextLimits;
  mcpServers?: ChatMcpServer[];
  skills?: ChatProviderSkills & { reportedAt: number };
  inventory?: ChatProviderInventory & { reportedAt: number; skillsReportedAt?: number; mcpToolsReportedAt?: number };
  subagents?: ChatEventDataMap['subagent'][];
  sessionUsage?: DisplayUsage;
  turnUsage?: DisplayUsage;
  turnTotal?: TokenUsage;
  context?: { used: number; size: number; window?: 'input' | 'total' };
  limits?: UsageLimit[];
}
export const CHAT_DETAILS_FIELDS = ['cliVersion', 'model', 'models', 'effort', 'level', 'capabilities', 'contextLimits', 'mcpServers', 'skills', 'inventory', 'subagents', 'sessionUsage', 'turnUsage', 'turnTotal', 'context', 'limits'] as const;
export type ChatDetailsField = typeof CHAT_DETAILS_FIELDS[number];
export const CHAT_DETAILS_MAX_BYTES = 64 * 1024;
export const CHAT_DETAILS_LIST_LIMIT = 64;
export interface ChatDetailsEvidence {
  version: 1;
  /** Opaque display generation, independent of the authentication nonce, changed at each driver open. */
  runId: string;
  agentId: string;
  sessionId: string;
  nativeSessionId: string | null;
  providerId: string;
  driver: ChatDriverId;
  startedAt: number;
  startSeq: number;
  readAt: number;
  lastSeq: number;
  /** All events from this runtime open were observed; not completeness of a resumed conversation. */
  completeFromStart: boolean;
  values: ChatDetailsValues;
  observedAt: Partial<Record<ChatDetailsField, number>>;
  omitted: Partial<Record<ChatDetailsField, number>>;
}
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const keys = (x: Record<string, unknown>, allowed: readonly string[]) => Object.keys(x).every((k) => allowed.includes(k));
const text = (x: unknown): x is string => typeof x === 'string' && x.length <= 512 && !/[\x00-\x1f\x7f]/.test(x);
const number = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const optional = (x: Record<string, unknown>, k: string, check: (v: unknown) => boolean) => x[k] === undefined || check(x[k]);
const tokens = (x: unknown) => record(x) && keys(x, ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning', 'total']) && Object.values(x).every(number);
const usage = (x: unknown) => record(x) && keys(x, ['tokens', 'costUsd', 'costIsEstimate']) && optional(x, 'tokens', tokens) && optional(x, 'costUsd', number) && optional(x, 'costIsEstimate', (v) => typeof v === 'boolean');
const list = (x: unknown, check: (v: unknown) => boolean) => Array.isArray(x) && x.length <= CHAT_DETAILS_LIST_LIMIT && x.every(check);
const nullableNumber = (x: unknown) => x === null || number(x);
const validators: Record<ChatDetailsField, (v: unknown) => boolean> = {
  cliVersion: text,
  model: (x) => x === null || text(x),
  models: (x) => list(x, (m) => record(m) && keys(m, ['id', 'label']) && text(m.id) && text(m.label)),
  effort: (x) => record(x) && keys(x, ['value', 'isDefault']) && (x.value === null || text(x.value)) && typeof x.isDefault === 'boolean',
  level: (x) => PERMISSION_LEVELS.includes(x as PermissionLevel),
  capabilities: (x) => record(x) && keys(x, ['subagents', 'usage', 'limits']) && ['full', 'ids_only', 'none'].includes(x.subagents as string) && ['cost', 'tokens', 'context', 'none'].includes(x.usage as string) && typeof x.limits === 'boolean',
  contextLimits: (x) => record(x) && keys(x, ['effectiveTokens', 'compactAtTokens', 'reservedTokens', 'note']) && ['effectiveTokens', 'compactAtTokens', 'reservedTokens'].every((k) => nullableNumber(x[k])) && optional(x, 'note', (v) => v === null || text(v)),
  mcpServers: (x) => list(x, (m) => record(m) && keys(m, ['name', 'status', 'error']) && text(m.name) && ['connected', 'pending', 'needs_auth', 'failed', 'disabled', 'unknown'].includes(m.status as string) && optional(m, 'error', text)),
  skills: (x) => record(x) && keys(x, ['provider', 'driver', 'source', 'nativeSessionId', 'names', 'reportedAt']) && x.provider === 'claude-code' && ['claude_agent_sdk', 'claude_stream_json'].includes(x.driver as string) && x.source === 'system/init' && text(x.nativeSessionId) && (x.names === null || list(x.names, text)) && number(x.reportedAt),
  inventory: (x) => record(x) && keys(x, ['provider', 'driver', 'source', 'nativeSessionId', 'skills', 'mcpTools', 'reportedAt', 'skillsReportedAt', 'mcpToolsReportedAt']) && text(x.nativeSessionId) && number(x.reportedAt)
    && (x.provider === 'claude-code' && ['claude_agent_sdk', 'claude_stream_json'].includes(x.driver as string) && x.source === 'system/init' || x.provider === 'copilot' && x.driver === 'copilot_sdk' && x.source === 'session.skills_loaded')
    && ['skillsReportedAt', 'mcpToolsReportedAt'].every((k) => optional(x, k, number))
    && (x.skills === undefined || number(x.skillsReportedAt)) && (x.mcpTools === undefined || number(x.mcpToolsReportedAt))
    && ['skills', 'mcpTools'].every((k) => optional(x, k, (v) => v === null || list(v, text))),
  subagents: (x) => list(x, (s) => record(s) && keys(s, ['subagentId', 'name', 'description', 'status', 'parentToolCallId', 'nativeSessionId', 'toolCount', 'usage']) && text(s.subagentId) && text(s.name) && ['running', 'completed', 'failed', 'cancelled'].includes(s.status as string) && ['description', 'parentToolCallId', 'nativeSessionId'].every((k) => optional(s, k, text)) && optional(s, 'toolCount', number) && optional(s, 'usage', tokens)),
  sessionUsage: usage, turnUsage: usage, turnTotal: tokens,
  context: (x) => record(x) && keys(x, ['used', 'size', 'window']) && number(x.used) && number(x.size) && optional(x, 'window', (v) => v === 'input' || v === 'total'),
  limits: (x) => list(x, (l) => record(l) && keys(l, ['window', 'utilization', 'status', 'resetsAt']) && text(l.window) && optional(l, 'utilization', number) && optional(l, 'resetsAt', number) && optional(l, 'status', (v) => ['ok', 'warning', 'exceeded'].includes(v as string))),
};
export const isChatDetailsValue = <K extends ChatDetailsField>(field: K, value: unknown): value is NonNullable<ChatDetailsValues[K]> => validators[field](value);
/** Reject unbounded/unknown structure at the desktop read boundary, not just TypeScript casts. */
export function isChatDetailsEvidence(value: unknown): value is ChatDetailsEvidence {
  if (!record(value) || !keys(value, ['version', 'runId', 'agentId', 'sessionId', 'nativeSessionId', 'providerId', 'driver', 'startedAt', 'startSeq', 'readAt', 'lastSeq', 'completeFromStart', 'values', 'observedAt', 'omitted'])) return false;
  if (value.version !== 1 || ![value.runId, value.agentId, value.sessionId, value.providerId].every((s) => text(s) && s.length > 0) || !(value.nativeSessionId === null || text(value.nativeSessionId)) || !CHAT_DRIVER_IDS.includes(value.driver as ChatDriverId) || !number(value.startedAt) || !Number.isSafeInteger(value.startSeq) || (value.startSeq as number) < 1 || !number(value.readAt) || !Number.isSafeInteger(value.lastSeq) || (value.lastSeq as number) < 0 || typeof value.completeFromStart !== 'boolean') return false;
  if (!record(value.values) || !record(value.observedAt) || !record(value.omitted) || ![value.values, value.observedAt, value.omitted].every((v) => keys(v, CHAT_DETAILS_FIELDS))) return false;
  if (!Object.entries(value.values).every(([k, v]) => validators[k as ChatDetailsField](v) && number((value.observedAt as Record<string, unknown>)[k]))) return false;
  if (!Object.values(value.observedAt).every(number) || !Object.values(value.omitted).every((n) => number(n) && Number.isSafeInteger(n))) return false;
  // Values are display text bounded above; UTF-8 is at most four bytes per code point.
  return JSON.stringify(value).length * 4 <= CHAT_DETAILS_MAX_BYTES;
}
