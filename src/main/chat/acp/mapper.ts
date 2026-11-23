/**
 * Translation between ACP shapes and the chat contract, with no transport or
 * process state. The driver owns lifecycle; this file only maps values.
 */

import { pathToFileURL } from 'url';
import type {
  AvailableCommand as ChatCommand,
  ChatEventDraft,
  ChatModelOption,
  ChatQuestion,
  ChatQuestionAnswers,
  ContentBlock as ChatContentBlock,
  PermissionOption as ChatPermissionOption,
  PlanEntry as ChatPlanEntry,
  ToolCallContent as ChatToolCallContent,
  ToolCallStatus as ChatToolCallStatus,
  ToolKind as ChatToolKind,
  TurnStopReason,
} from '../../../shared/chat/events';
import type { ChatDriverId } from '../../../shared/chat/capabilities';
import type { McpHttpEndpoint } from '../../../shared/chat/runtime';
import { selectOption, type AcpNegotiated } from './capabilities';
import {
  ACP_SESSION_UPDATE_KINDS,
  ACP_TOOL_CALL_STATUSES,
  ACP_TOOL_KINDS,
  type ContentBlock,
  type CreateElicitationRequest,
  type ElicitationProperty,
  type ElicitationValue,
  type McpServer,
  type PermissionOption,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionUpdate,
  type StopReason,
  type ToolCallContent,
  type ToolCallFields,
} from './protocol';

// ── Prompts ────────────────────────────────────────────────────────────────

/**
 * Chat content as ACP prompt blocks. Text and resource links are baseline;
 * images and embedded resources only go as such when `promptCapabilities`
 * allows them, and otherwise as a link to the file.
 */
export function toAcpPrompt(content: ChatContentBlock[], prompt: AcpNegotiated['prompt']): ContentBlock[] {
  return content.map((block): ContentBlock => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'image':
        if (prompt.image && block.data) return { type: 'image', data: block.data, mimeType: block.mimeType };
        if (!block.path && !block.uri) throw new Error("This agent can't take images, and the image has no file to link to");
        return link(block.path ?? block.uri!, block.name, block.mimeType);
      case 'resource':
        if (prompt.embeddedContext && block.text !== undefined) {
          return { type: 'resource', resource: { uri: block.uri, text: block.text, ...(block.mimeType && { mimeType: block.mimeType }) } };
        }
        return { type: 'resource_link', uri: block.uri, name: block.uri, ...(block.mimeType && { mimeType: block.mimeType }) };
      case 'file':
        return link(block.path, block.name);
    }
  });
}

function link(target: string, name?: string, mimeType?: string): ContentBlock {
  const uri = /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target) ? target : pathToFileURL(target).href;
  return { type: 'resource_link', uri, name: name ?? target.split(/[\\/]/).pop() ?? target, ...(mimeType && { mimeType }) };
}

// ── MCP servers ────────────────────────────────────────────────────────────

/**
 * `ChatDriverStartOptions.mcpServers` as ACP McpServer entries. Stdio is
 * baseline. An entry with an HTTP endpoint goes as HTTP only when the agent
 * advertised `mcpCapabilities.http`; header values are read from `env` by
 * name, so secrets never sit in the options object. Entries that fit neither
 * come back in `skipped`.
 */
export function toAcpMcpServers(
  servers: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> | undefined,
  endpoints: Record<string, McpHttpEndpoint> | undefined,
  mcp: AcpNegotiated['mcp'],
): { servers: McpServer[]; skipped: string[] } {
  const out: McpServer[] = [];
  const skipped: string[] = [];
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const endpoint = endpoints?.[name];
    if (endpoint && mcp.http) {
      const headers = Object.entries(endpoint.headersFromEnv ?? {})
        .map(([header, varName]) => ({ name: header, value: env?.[varName] }))
        .filter((h): h is { name: string; value: string } => typeof h.value === 'string');
      out.push({ type: 'http', name, url: endpoint.url, headers });
    } else if (typeof s.command === 'string') {
      out.push({ name, command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: pairs(s.env) });
    } else if (typeof s.url === 'string' && (s.type === 'sse' ? mcp.sse : mcp.http)) {
      out.push({ type: s.type === 'sse' ? 'sse' : 'http', name, url: s.url, headers: pairs(s.headers) });
    } else {
      skipped.push(name);
    }
  }
  return { servers: out, skipped };
}

function pairs(v: unknown): Array<{ name: string; value: string }> {
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([name, value]) => ({ name, value }));
}

// ── Turn outcomes ──────────────────────────────────────────────────────────

const STOP_REASONS: Record<StopReason, TurnStopReason> = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  max_turn_requests: 'max_turns',
  refusal: 'refusal',
  cancelled: 'cancelled',
};

/** The provider's reported stop reason, or undefined for one the pinned schema doesn't define. */
export function toStopReason(reason: unknown): TurnStopReason | undefined {
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(STOP_REASONS, reason) ? STOP_REASONS[reason as StopReason] : undefined;
}

// ── Permissions ────────────────────────────────────────────────────────────

export function toPermissionOptions(options: readonly PermissionOption[]): ChatPermissionOption[] {
  return options.map((o) => ({ optionId: o.optionId, kind: o.kind, label: o.name }));
}

// ── Session updates ────────────────────────────────────────────────────────

const KNOWN_KINDS: ReadonlySet<string> = new Set(ACP_SESSION_UPDATE_KINDS);
const TOOL_KINDS: ReadonlySet<string> = new Set(ACP_TOOL_KINDS);
const TOOL_STATUSES: ReadonlySet<string> = new Set(ACP_TOOL_CALL_STATUSES);

function toolKind(kind: unknown): ChatToolKind {
  // The schema deserializes an unknown kind to the default, `other`.
  return typeof kind === 'string' && TOOL_KINDS.has(kind) ? kind as ChatToolKind : 'other';
}

function toolStatus(status: unknown): ChatToolCallStatus | undefined {
  return typeof status === 'string' && TOOL_STATUSES.has(status) ? status as ChatToolCallStatus : undefined;
}

export function toToolContent(content: ToolCallContent[] | null | undefined): ChatToolCallContent[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: ChatToolCallContent[] = [];
  for (const c of content) {
    if (c?.type === 'diff' && typeof c.path === 'string') {
      out.push({ type: 'diff', path: c.path, ...(typeof c.oldText === 'string' && { oldText: c.oldText }), newText: c.newText });
    } else if (c?.type === 'content' && c.content?.type === 'text') {
      out.push({ type: 'text', text: c.content.text });
    }
    // Terminal content needs the client terminal capability, which Clubhouse
    // doesn't advertise; other content blocks have no tool-output form yet.
  }
  return out;
}

function locations(fields: ToolCallFields) {
  return Array.isArray(fields.locations)
    ? fields.locations.filter((l) => typeof l?.path === 'string').map((l) => ({ path: l.path, ...(typeof l.line === 'number' && { line: l.line }) }))
    : undefined;
}

function flatOptions(option: Extract<SessionConfigOption, { type: 'select' }>): SessionConfigSelectOption[] {
  return option.options.flatMap((o) => ('group' in o ? o.options : [o]));
}

/** Picker lists from the session's config options (`session_info.models` / `efforts`). */
export function configChoices(options: readonly SessionConfigOption[]): { models: ChatModelOption[]; efforts: string[] } {
  const model = selectOption(options, 'model');
  const effort = selectOption(options, 'thought_level');
  return {
    models: model ? flatOptions(model).map((o) => ({ id: o.value, label: o.name, ...(o.description && { description: o.description }) })) : [],
    efforts: effort ? flatOptions(effort).map((o) => o.value) : [],
  };
}

export function currentModel(options: readonly SessionConfigOption[]): { modelId?: string; effort?: string } {
  return {
    ...(selectOption(options, 'model') && { modelId: selectOption(options, 'model')!.currentValue }),
    ...(selectOption(options, 'thought_level') && { effort: selectOption(options, 'thought_level')!.currentValue }),
  };
}

/** What a mapped update did to session facts, for the driver to fold in. */
export interface UpdateEffects {
  configOptions?: SessionConfigOption[];
  commands?: boolean;
  usage?: boolean;
}

/**
 * Maps `session/update` payloads to drafts. Keeps only what message grouping
 * needs: chunks of one kind in a row belong to one message unless the agent
 * gives message ids.
 */
export class AcpUpdateMapper {
  private run: { kind: string; messageId: string } | undefined;
  private counter = 0;

  constructor(private readonly driverId: ChatDriverId) {}

  /** Start a new message for the next chunk (a turn boundary). */
  breakRun(): void {
    this.run = undefined;
  }

  map(raw: unknown): { drafts: ChatEventDraft[]; effects: UpdateEffects } {
    const update = raw as SessionUpdate | { sessionUpdate?: unknown } | null;
    const kind = update && typeof update === 'object' && typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
    if (!kind || !KNOWN_KINDS.has(kind)) {
      return { drafts: [{ type: 'protocol_unknown', data: { driver: this.driverId, kind: 'field', name: `session/update:${kind ?? '(missing)'}` } }], effects: {} };
    }
    const u = update as SessionUpdate;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (u.content?.type !== 'text' || typeof u.content.text !== 'string') return { drafts: [], effects: {} };
        const messageId = this.messageId(u.sessionUpdate, u.messageId);
        return {
          drafts: [u.sessionUpdate === 'agent_message_chunk'
            ? { type: 'agent_message_chunk', data: { messageId, text: u.content.text } }
            : { type: 'agent_thought_chunk', data: { messageId, text: u.content.text } }],
          effects: {},
        };
      }
      case 'tool_call': {
        if (typeof u.toolCallId !== 'string') return { drafts: [], effects: {} };
        this.breakRun();
        const content = toToolContent(u.content);
        const locs = locations(u);
        return {
          drafts: [{
            type: 'tool_call',
            data: {
              toolCallId: u.toolCallId,
              kind: toolKind(u.kind),
              title: typeof u.title === 'string' && u.title ? u.title : u.name ?? 'Tool call',
              status: toolStatus(u.status) ?? 'pending',
              ...(typeof u.name === 'string' && { toolName: u.name }),
              ...(u.rawInput !== undefined && { rawInput: u.rawInput }),
              ...(locs?.length && { locations: locs }),
              ...(content?.length && { content }),
            },
          }],
          effects: {},
        };
      }
      case 'tool_call_update': {
        if (typeof u.toolCallId !== 'string') return { drafts: [], effects: {} };
        const status = toolStatus(u.status);
        const content = toToolContent(u.content);
        return {
          drafts: [{
            type: 'tool_call_update',
            data: {
              toolCallId: u.toolCallId,
              ...(status && { status }),
              ...(typeof u.title === 'string' && { title: u.title }),
              ...(content && { content }),
              ...(u.rawOutput !== undefined && { rawOutput: u.rawOutput }),
            },
          }],
          effects: {},
        };
      }
      case 'plan': {
        if (!Array.isArray(u.entries)) return { drafts: [], effects: {} };
        const entries: ChatPlanEntry[] = u.entries
          .filter((e) => typeof e?.content === 'string')
          .map((e) => ({ content: e.content, status: e.status, ...(e.priority && { priority: e.priority }) }));
        return { drafts: [{ type: 'plan', data: { entries } }], effects: {} };
      }
      case 'available_commands_update': {
        if (!Array.isArray(u.availableCommands)) return { drafts: [], effects: {} };
        const commands: ChatCommand[] = u.availableCommands
          .filter((c) => typeof c?.name === 'string')
          .map((c) => ({ name: c.name, ...(c.description && { description: c.description }), ...(c.input?.hint && { inputHint: c.input.hint }) }));
        return { drafts: [{ type: 'commands_available', data: { commands } }], effects: { commands: commands.length > 0 } };
      }
      case 'config_option_update':
        return Array.isArray(u.configOptions) ? { drafts: [], effects: { configOptions: u.configOptions } } : { drafts: [], effects: {} };
      case 'session_info_update':
        return typeof u.title === 'string' ? { drafts: [{ type: 'session_info', data: { title: u.title } }], effects: {} } : { drafts: [], effects: {} };
      case 'usage_update': {
        if (typeof u.used !== 'number' || typeof u.size !== 'number') return { drafts: [], effects: {} };
        return {
          drafts: [{
            type: 'usage',
            data: {
              scope: 'session',
              context: { used: u.used, size: u.size },
              ...(u.cost?.currency === 'USD' && typeof u.cost.amount === 'number' && { costUsd: u.cost.amount }),
            },
          }],
          effects: { usage: true },
        };
      }
      case 'user_message_chunk':
        // The agent echoing the user's own words; the runtime already wrote them.
        return { drafts: [], effects: {} };
      default:
        // Known to the pinned schema but not mapped: mode changes (levels are
        // provider policy), and kinds gated on client capabilities Clubhouse
        // doesn't advertise (plan edits, notices, compaction, subagents,
        // session messages). Reported rather than dropped silently.
        return { drafts: [{ type: 'protocol_unknown', data: { driver: this.driverId, kind: 'field', name: `session/update:${kind}` } }], effects: {} };
    }
  }

  private messageId(kind: string, native: string | null | undefined): string {
    if (typeof native === 'string' && native) {
      this.run = { kind, messageId: `acp-${native}` };
      return this.run.messageId;
    }
    if (this.run?.kind !== kind) this.run = { kind, messageId: `acp-m${++this.counter}` };
    return this.run.messageId;
  }
}

// ── Questions (form elicitation) ───────────────────────────────────────────

const BOOLEAN_OPTIONS = [{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }];

/**
 * A form elicitation as chat questions, one per property, or undefined when
 * a property has a type chat can't ask for.
 */
export function toChatQuestions(req: CreateElicitationRequest): ChatQuestion[] | undefined {
  const props = Object.entries(req.requestedSchema?.properties ?? {});
  if (props.length === 0) {
    return [{ id: 'confirm', prompt: req.message, options: [{ id: 'accept', label: 'OK' }], allowFreeText: false }];
  }
  const questions: ChatQuestion[] = [];
  for (const [id, p] of props) {
    const prompt = props.length === 1 ? req.message : p.title ?? id;
    const header = props.length === 1 ? p.title ?? undefined : undefined;
    const base = { id, prompt, ...(header && { header }) };
    switch (p.type) {
      case 'string': {
        const options = p.oneOf?.map((o) => ({ id: o.const, label: o.title ?? o.const })) ?? p.enum?.map((v) => ({ id: v, label: v }));
        questions.push(options?.length ? { ...base, options, allowFreeText: false } : { ...base, allowFreeText: true });
        break;
      }
      case 'boolean':
        questions.push({ ...base, options: BOOLEAN_OPTIONS, allowFreeText: false });
        break;
      case 'number':
      case 'integer':
        questions.push({ ...base, allowFreeText: true });
        break;
      case 'array': {
        const options = p.items?.anyOf?.map((o) => ({ id: o.const, label: o.title ?? o.const })) ?? p.items?.enum?.map((v) => ({ id: v, label: v }));
        if (!options?.length) return undefined;
        questions.push({ ...base, options, multiSelect: true, allowFreeText: false });
        break;
      }
      default:
        return undefined;
    }
  }
  return questions;
}

/** Chat answers as elicitation `content`, typed per the requested schema; undefined when one doesn't fit. */
export function toElicitationContent(req: CreateElicitationRequest, answers: ChatQuestionAnswers): Record<string, ElicitationValue> | undefined {
  const out: Record<string, ElicitationValue> = {};
  for (const [id, p] of Object.entries(req.requestedSchema?.properties ?? {})) {
    const answer = answers[id];
    if (answer === undefined || answer === '') continue;
    const value = typedAnswer(p, answer);
    if (value === undefined) return undefined;
    out[id] = value;
  }
  return out;
}

function typedAnswer(p: ElicitationProperty, answer: string | string[]): ElicitationValue | undefined {
  const one = Array.isArray(answer) ? answer[0] : answer;
  switch (p.type) {
    case 'string': return one;
    case 'boolean': return one === 'true' ? true : one === 'false' ? false : undefined;
    case 'number': return Number.isFinite(Number(one)) ? Number(one) : undefined;
    case 'integer': return Number.isInteger(Number(one)) ? Number(one) : undefined;
    case 'array': return Array.isArray(answer) ? answer : [answer];
    default: return undefined;
  }
}
