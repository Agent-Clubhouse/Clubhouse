import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import * as path from 'path';
import type { ChatCapabilities, ChatDriverId, PermissionLevel } from '../../../shared/chat/capabilities';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../shared/chat/capabilities';
import type {
  ChatErrorCode,
  ChatEventDraft,
  ContentBlock as ChatContentBlock,
  PermissionOption as ChatPermissionOption,
  ToolCallContent as ChatToolCallContent,
  TokenUsage,
  TurnStopReason as ChatStopReason,
} from '../../../shared/chat/events';
import type { AcpDriverCapabilities } from './acp-capabilities';
import type { AcpPermissionLevels, AcpSessionEvent, AcpSessionState } from './acp-session';
import type {
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionConfigOption,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
  TurnUsage,
} from './acp-schema';

/**
 * Translate an ACP driver's capability record into the chat contract's,
 * starting from MINIMAL_CHAT_CAPABILITIES. `state` (after session/new or load)
 * says whether models are switchable; `levels` comes from the agent profile.
 */
export function toChatCapabilities(
  caps: AcpDriverCapabilities,
  state?: Readonly<AcpSessionState>,
  levels?: AcpPermissionLevels,
): ChatCapabilities {
  const hasModelSwitch = state
    ? state.configOptions.some((o) => o.category === 'model' || o.id === 'model') || !!state.legacyModels
    : caps.configOptions;
  return {
    ...MINIMAL_CHAT_CAPABILITIES,
    steer: false,
    queue: 'client',
    interrupt: true,
    resume: caps.resume === 'resume' ? 'native' : caps.resume === 'load' ? 'replay' : 'none',
    planApproval: false,
    questions: false,
    // Copilot exposes subagent ids in an unverified format; claim nothing until it's checked.
    subagents: 'none',
    usage: caps.usage.cost ? 'cost' : caps.usage.turnTokens ? 'tokens' : caps.usage.context ? 'context' : 'none',
    limits: false,
    images: caps.prompt.image,
    slashCommands: caps.slashCommands,
    modelSwitch: hasModelSwitch ? 'live' : 'none',
    liveLevels: levels?.live ?? [],
    login: caps.login === 'terminal' ? 'terminal' : caps.login === 'agent' ? 'api' : 'none',
    // Stable ACP v1 has no system prompt field (the client system prompt is still unstable).
    systemPrompt: false,
  };
}

/** Contract content → ACP prompt blocks. Files and paths go as file:// resource links. */
export function toAcpPrompt(content: ChatContentBlock[]): ContentBlock[] {
  return content.map((block): ContentBlock => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'image':
        if (block.data) return { type: 'image', data: block.data, mimeType: block.mimeType, ...(block.uri && { uri: block.uri }) };
        return fileLink(block.path ?? block.uri ?? '', block.mimeType);
      case 'resource':
        return block.text !== undefined
          ? { type: 'resource', resource: { uri: block.uri, text: block.text, ...(block.mimeType && { mimeType: block.mimeType }) } }
          : { type: 'resource_link', uri: block.uri, name: block.uri, ...(block.mimeType && { mimeType: block.mimeType }) };
      case 'file':
        return fileLink(block.path);
    }
  });
}

function fileLink(target: string, mimeType?: string): ContentBlock {
  const isUri = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
  return {
    type: 'resource_link',
    uri: isUri ? target : pathToFileURL(target).href,
    name: path.basename(target) || target,
    ...(mimeType && { mimeType }),
  };
}

/**
 * MCP servers keyed by name → ACP's list. Accepts `{ command, args, env }`
 * (stdio) and `{ type: 'http' | 'sse', url, headers }`. Anything else is
 * returned in `skipped` so the caller can log it.
 */
export function toAcpMcpServers(servers: Record<string, unknown> | undefined): { servers: McpServer[]; skipped: string[] } {
  const out: McpServer[] = [];
  const skipped: string[] = [];
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const s = raw as Record<string, unknown> | null;
    if (s && typeof s.command === 'string') {
      out.push({
        name,
        command: s.command,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        env: pairs(s.env),
      });
    } else if (s && typeof s.url === 'string' && (s.type === 'http' || s.type === 'sse' || s.type === undefined)) {
      out.push({ type: s.type === 'sse' ? 'sse' : 'http', name, url: s.url, headers: pairs(s.headers) });
    } else {
      skipped.push(name);
    }
  }
  return { servers: out, skipped };
}

function pairs(v: unknown): Array<{ name: string; value: string }> {
  if (!v || typeof v !== 'object') return [];
  if (Array.isArray(v)) return v.filter((p) => p && typeof p.name === 'string').map((p) => ({ name: p.name, value: String(p.value ?? '') }));
  return Object.entries(v as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value) }));
}

/** ACP's "authentication required" JSON-RPC error. */
const ACP_AUTH_REQUIRED = -32000;

function turnErrorCode(errorKind: string | undefined, rpcCode: number | undefined): ChatErrorCode {
  if (errorKind === 'process_exited') return 'process_exited';
  if (errorKind === 'rpc') return rpcCode === ACP_AUTH_REQUIRED ? 'auth_required' : 'protocol_error';
  return 'unknown';
}

const STOP_REASONS: Record<string, ChatStopReason> = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  max_turn_requests: 'max_turns',
  refusal: 'refusal',
  cancelled: 'cancelled',
  error: 'error',
};

function toTokenUsage(u: TurnUsage | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  const out: TokenUsage = {
    ...(u.inputTokens !== undefined && { input: u.inputTokens }),
    ...(u.cachedReadTokens !== undefined && { cachedInput: u.cachedReadTokens }),
    ...(u.cachedWriteTokens !== undefined && { cacheWrite: u.cachedWriteTokens }),
    ...(u.outputTokens !== undefined && { output: u.outputTokens }),
    ...(u.thoughtTokens !== undefined && { reasoning: u.thoughtTokens }),
    ...(u.totalTokens !== undefined && { total: u.totalTokens }),
  };
  return Object.keys(out).length ? out : undefined;
}

function toolContent(content: ToolCallContent[] | null | undefined, rawOutput?: unknown): ChatToolCallContent[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const diffs = content.filter((c) => c.type === 'diff').length;
  // Copilot puts a git-style unified diff in rawOutput.detailedContent; attach it when unambiguous.
  const detailed = (rawOutput as { detailedContent?: unknown } | undefined)?.detailedContent;
  const unified = diffs === 1 && typeof detailed === 'string' && detailed.includes('@@') ? detailed : undefined;
  const out: ChatToolCallContent[] = [];
  for (const c of content) {
    if (c.type === 'diff') {
      out.push({
        type: 'diff',
        path: c.path,
        ...(c.oldText != null && c.oldText !== '' && { oldText: c.oldText }),
        newText: c.newText,
        ...(unified && { unifiedDiff: unified }),
      });
    } else if (c.type === 'content') {
      const text = blockText(c.content);
      if (text !== undefined) out.push({ type: 'text', text });
    }
    // `terminal` content references a client terminal; Clubhouse serves none, so there's nothing to show.
  }
  return out;
}

function blockText(block: ContentBlock): string | undefined {
  switch (block.type) {
    case 'text': return block.text;
    case 'resource_link': return block.uri;
    case 'resource': return 'text' in block.resource ? block.resource.text : block.resource.uri;
    default: return undefined;
  }
}

function locations(locs: ToolCall['locations'] | null | undefined) {
  return Array.isArray(locs) ? locs.map((l) => ({ path: l.path, ...(typeof l.line === 'number' && { line: l.line }) })) : undefined;
}

function permissionOption(o: PermissionOption): ChatPermissionOption {
  const kind = (['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const).includes(o.kind) ? o.kind : 'other';
  return { optionId: o.optionId, kind, label: o.name };
}

function selectValue(options: SessionConfigOption[], match: (o: SessionConfigOption) => boolean): string | undefined {
  const o = options.find(match);
  return o?.type === 'select' ? o.currentValue : undefined;
}

/**
 * Stateful translation of one ACP session's events into chat contract drafts.
 *
 * - Replayed history from `session/load` is dropped: Clubhouse's transcript
 *   owns history. State updates during replay (commands, modes, options) still map.
 * - ACP chunks rarely carry a messageId, so ids are minted per turn: a new
 *   agent message or thought starts whenever something else came in between.
 * - Unknown updates become `protocol_unknown`.
 */
export class AcpChatEventMapper {
  /** Distinguishes this driver session's ids from earlier ones in the same (resumed) chat session. */
  private readonly idPrefix = randomUUID().slice(0, 8);
  private turn = 0;
  private turnId: string | undefined;
  private turnStartedAt = 0;
  private seqInTurn = 0;
  private lastKind: 'message' | 'thought' | 'other' = 'other';
  private messageId = '';
  private thoughtId = '';
  private model: string | undefined;
  private effort: string | undefined;
  private level: PermissionLevel | undefined;
  private readonly permissionKinds = new Map<string, Map<string, PermissionOption['kind']>>();

  constructor(
    private readonly driver: ChatDriverId,
    private readonly levels?: AcpPermissionLevels,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seed model/effort/level from the session state so only changes are reported. */
  prime(state: Readonly<AcpSessionState>): void {
    this.model = this.currentModel(state);
    this.effort = selectValue(state.configOptions, (o) => o.category === 'thought_level');
    this.level = this.levels?.current(state);
  }

  map(event: AcpSessionEvent, state: Readonly<AcpSessionState>): ChatEventDraft[] {
    switch (event.type) {
      case 'turn_started': {
        this.turn++;
        this.turnId = `turn-${this.idPrefix}-${this.turn}`;
        this.turnStartedAt = this.now();
        this.seqInTurn = 0;
        this.lastKind = 'other';
        return [this.scoped({ type: 'turn_started', data: { trigger: 'prompt' } })];
      }
      case 'turn_ended': {
        const out: ChatEventDraft[] = [];
        const tokens = toTokenUsage(event.usage);
        let stopReason = STOP_REASONS[event.stopReason];
        if (!stopReason) {
          stopReason = 'end_turn';
          out.push({ type: 'protocol_unknown', data: { driver: this.driver, kind: 'field', name: `stopReason:${event.rawStopReason ?? event.stopReason}` } });
        }
        if (event.stopReason === 'error') {
          const code = turnErrorCode(event.errorKind, event.rpcCode);
          out.push(this.scoped({
            type: 'error',
            data: { code, message: event.error ?? 'turn failed', fatal: code === 'process_exited' },
          }));
        }
        if (tokens) out.push(this.scoped({ type: 'usage', data: { scope: 'turn', tokens } }));
        out.push(this.scoped({
          type: 'turn_ended',
          data: { stopReason, durationMs: this.now() - this.turnStartedAt, ...(tokens && { usage: tokens }) },
        }));
        this.turnId = undefined;
        return out;
      }
      case 'permission_request': {
        this.permissionKinds.set(event.requestId, new Map(event.options.map((o) => [o.optionId, o.kind])));
        this.lastKind = 'other';
        const tc = event.toolCall;
        return [this.scoped({
          type: 'permission_request',
          data: {
            requestId: event.requestId,
            title: tc.title ?? 'Permission requested',
            toolCallId: tc.toolCallId,
            ...(tc.name && { toolName: tc.name }),
            ...(tc.rawInput !== undefined && { rawInput: tc.rawInput }),
            options: event.options.map(permissionOption),
          },
        })];
      }
      case 'permission_resolved': {
        const kinds = this.permissionKinds.get(event.requestId);
        this.permissionKinds.delete(event.requestId);
        const outcome = event.outcome;
        if (outcome.outcome === 'cancelled') {
          return [this.scoped({ type: 'permission_resolved', data: { requestId: event.requestId, decision: 'cancelled', by: 'user' } })];
        }
        const kind = kinds?.get(outcome.optionId);
        return [this.scoped({
          type: 'permission_resolved',
          data: {
            requestId: event.requestId,
            optionId: outcome.optionId,
            decision: kind?.startsWith('reject') ? 'deny' : 'allow',
            by: 'user',
          },
        })];
      }
      case 'unknown_update':
        return [{ type: 'protocol_unknown', data: { driver: this.driver, kind: 'field', name: `session/update:${event.kind}` } }];
      case 'unknown_method':
        return [{ type: 'protocol_unknown', data: { driver: this.driver, kind: event.kind, name: event.method } }];
      case 'update':
        return this.mapUpdate(event.update, event.replay, state);
      case 'exit':
        return [];
    }
  }

  private mapUpdate(u: SessionUpdate, replay: boolean, state: Readonly<AcpSessionState>): ChatEventDraft[] {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (replay || u.content.type !== 'text') return [];
        const thought = u.sessionUpdate === 'agent_thought_chunk';
        const kind = thought ? 'thought' : 'message';
        if (this.lastKind !== kind) {
          const id = u.messageId ?? `${this.turnId ?? `session-${this.idPrefix}`}-${thought ? 'thought' : 'msg'}-${++this.seqInTurn}`;
          if (thought) this.thoughtId = id; else this.messageId = id;
        }
        this.lastKind = kind;
        return [this.scoped(thought
          ? { type: 'agent_thought_chunk', data: { messageId: this.thoughtId, text: u.content.text } }
          : { type: 'agent_message_chunk', data: { messageId: this.messageId, text: u.content.text } })];
      }
      case 'user_message_chunk':
        // Clubhouse records user messages itself when it sends them; agents only echo them on replay.
        return [];
      case 'tool_call': {
        if (replay) return [];
        this.lastKind = 'other';
        return [this.scoped({
          type: 'tool_call',
          data: {
            toolCallId: u.toolCallId,
            kind: u.kind ?? 'other',
            title: u.title,
            status: u.status ?? 'pending',
            ...(u.name && { toolName: u.name }),
            ...(u.rawInput !== undefined && { rawInput: u.rawInput }),
            ...(u.locations && { locations: locations(u.locations) }),
            ...(u.content && { content: toolContent(u.content, u.rawOutput) }),
          },
        })];
      }
      case 'tool_call_update': {
        if (replay) return [];
        this.lastKind = 'other';
        const tu = u as ToolCallUpdate;
        const content = toolContent(tu.content, tu.rawOutput);
        return [this.scoped({
          type: 'tool_call_update',
          data: {
            toolCallId: tu.toolCallId,
            ...(tu.status && { status: tu.status }),
            ...(tu.title && { title: tu.title }),
            ...(content && { content, contentMode: 'replace' as const }),
            ...(tu.rawOutput !== undefined && { rawOutput: tu.rawOutput }),
          },
        })];
      }
      case 'plan':
        if (replay) return [];
        return [this.scoped({
          type: 'plan',
          data: { entries: u.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority })) },
        })];
      case 'available_commands_update':
        return [{
          type: 'commands_available',
          data: {
            commands: u.availableCommands.map((c) => ({
              name: c.name,
              ...(c.description && { description: c.description }),
              ...(c.input?.hint && { inputHint: c.input.hint }),
            })),
          },
        }];
      case 'current_mode_update':
      case 'config_option_update':
        return this.configChanges(state, u.sessionUpdate === 'current_mode_update' ? u.currentModeId : undefined);
      case 'usage_update':
        return [{
          type: 'usage',
          data: {
            scope: 'session',
            context: { used: u.used, size: u.size },
            ...(u.cost && u.cost.currency.toUpperCase() === 'USD' && { costUsd: u.cost.amount }),
          },
        }];
      case 'notice':
        return [{
          type: 'notice',
          data: {
            level: u.severity === 'warning' || u.severity === 'error' ? 'warn' : 'info',
            code: 'agent_notice',
            message: u.description ? `${u.title}: ${u.description}` : u.title,
          },
        }];
      case 'compaction_update':
        return [{
          type: 'notice',
          data: {
            level: u.status === 'failed' ? 'warn' : 'info',
            code: `compaction_${u.status}`,
            message: u.error ?? `Context compaction ${String(u.status).replace('_', ' ')}`,
          },
        }];
      case 'session_info_update':
        return u.title ? [{ type: 'session_info', data: { title: u.title } }] : [];
      case 'compaction_summary_chunk':
        // Known and harmless; the contract has no slot for the summary text.
        return [];
    }
  }

  private configChanges(state: Readonly<AcpSessionState>, nativeMode?: string): ChatEventDraft[] {
    const out: ChatEventDraft[] = [];
    const model = this.currentModel(state);
    const effort = selectValue(state.configOptions, (o) => o.category === 'thought_level');
    if (model && (model !== this.model || effort !== this.effort)) {
      out.push({ type: 'model_changed', data: { modelId: model, ...(effort && { effort }) } });
    }
    this.model = model;
    this.effort = effort;

    const level = this.levels?.current(state);
    if (level && level !== this.level) {
      const mode = nativeMode ?? state.modes?.currentModeId;
      out.push({ type: 'mode_changed', data: { level, ...(mode && { nativeMode: mode }) } });
    }
    this.level = level;
    return out;
  }

  private currentModel(state: Readonly<AcpSessionState>): string | undefined {
    return selectValue(state.configOptions, (o) => o.category === 'model')
      ?? selectValue(state.configOptions, (o) => o.id === 'model')
      ?? state.legacyModels?.currentModelId;
  }

  private scoped(draft: ChatEventDraft): ChatEventDraft {
    return this.turnId ? { ...draft, turnId: this.turnId } : draft;
  }
}
