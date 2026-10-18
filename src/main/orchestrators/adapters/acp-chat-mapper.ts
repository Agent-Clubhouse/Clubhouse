import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import * as path from 'path';
import type { ChatCapabilities, ChatDriverId, PermissionLevel } from '../../../shared/chat/capabilities';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../shared/chat/capabilities';
import type {
  ChatErrorCode,
  ChatEventDraft,
  ChatModelOption,
  ContentBlock as ChatContentBlock,
  PermissionOption as ChatPermissionOption,
  ToolCallContent as ChatToolCallContent,
  TokenUsage,
  TurnStopReason as ChatStopReason,
} from '../../../shared/chat/events';
import type { AcpDriverCapabilities } from './acp-capabilities';
import type { AcpAgentProfile, AcpPermissionLevels, AcpSessionEvent, AcpSessionState, AcpTask } from './acp-session';
import type {
  ContentBlock,
  McpServer,
  Meta,
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
    effortSwitch: (state ? state.configOptions.some((o) => o.category === 'thought_level') : caps.configOptions) ? 'live' : 'none',
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
 * (stdio) and `{ type?, url, headers }` (SSE when type is 'sse', else HTTP). Anything else is
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
    } else if (s && typeof s.url === 'string') {
      // 'sse' is SSE; anything else with a URL ('http', 'streamable-http', unset) is HTTP.
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

/** Paths a tool call touches: its locations and its diffs. */
function toolPaths(locs: ToolCall['locations'] | null | undefined, content: ToolCallContent[] | null | undefined): string[] {
  return [
    ...(Array.isArray(locs) ? locs.map((l) => l.path) : []),
    ...(Array.isArray(content) ? content.flatMap((c) => (c.type === 'diff' ? [c.path] : [])) : []),
  ];
}

/**
 * Files an apply_patch-style raw input touches. Copilot's apply_patch sends
 * only a string, `*** Begin Patch\n*** Add File: /abs/path\n+line…`; the diff
 * comes later on the tool_call_update. For an added file, `added` is its text.
 */
export function patchFiles(rawInput: unknown): Array<{ path: string; added?: string }> {
  if (typeof rawInput !== 'string' || !rawInput.includes('*** ')) return [];
  const files: Array<{ path: string; added?: string }> = [];
  let adding: { path: string; lines: string[] } | undefined;
  const flush = () => {
    if (adding) files.push({ path: adding.path, added: adding.lines.join('\n') + (adding.lines.length ? '\n' : '') });
    adding = undefined;
  };
  for (const line of rawInput.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/.exec(line);
    if (header) {
      flush();
      if (header[1] === 'Add') adding = { path: header[2], lines: [] };
      else if (header[1] === 'Update') files.push({ path: header[2] });
    } else if (line.startsWith('*** ')) {
      flush();
    } else if (adding) {
      adding.lines.push(line.startsWith('+') ? line.slice(1) : line);
    }
  }
  flush();
  return files;
}

/** The new text of the diff for `path`, when the tool call has one. */
function diffNewText(content: ToolCallContent[] | null | undefined, path: string): string | undefined {
  const diff = Array.isArray(content) ? content.find((c) => c.type === 'diff' && c.path === path) : undefined;
  return diff && diff.type === 'diff' ? diff.newText : undefined;
}

/** A plan file's text, if it can be read and is a sensible size. */
function readSmallFile(file: string): string | undefined {
  try {
    if (fs.statSync(file).size > 512 * 1024) return undefined;
    return fs.readFileSync(file, 'utf8');
  } catch { // telemetry-exempt: a plan file that can't be read falls back to the diff
    return undefined;
  }
}

/** Whether a title has any letter or digit (Copilot sometimes sends "."). */
function readable(title: string | null | undefined): title is string {
  return !!title && /[\p{L}\p{N}]/u.test(title);
}

/** A readable tool card title: Copilot sometimes sends "." (#2177). */
function toolTitle(title: string | null | undefined, name: string | null | undefined, kind: ToolCall['kind']): string {
  if (readable(title)) return title;
  if (name && /[\p{L}\p{N}]/u.test(name)) return name;
  const kindTitles: Partial<Record<NonNullable<ToolCall['kind']>, string>> = {
    read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', execute: 'Run command', think: 'Think', fetch: 'Fetch', switch_mode: 'Switch mode',
  };
  return (kind && kindTitles[kind]) ?? 'Tool';
}

/** A file path in a permission request's raw input (Copilot: `fileName`; others: `path`). */
function rawInputPath(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const r = rawInput as Record<string, unknown>;
  return [r.fileName, r.path, r.file_path].find((v): v is string => typeof v === 'string' && v.length > 0);
}

/** A unified diff in a permission request's raw input (Copilot sends `diff`), as diff content. */
function rawInputPreview(rawInput: unknown): ChatToolCallContent[] | undefined {
  const path = rawInputPath(rawInput);
  const diff = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>).diff : undefined;
  if (!path || typeof diff !== 'string' || !diff.includes('@@')) return undefined;
  return [{ type: 'diff', path, unifiedDiff: diff }];
}

function locations(locs: ToolCall['locations'] | null | undefined) {
  return Array.isArray(locs) ? locs.map((l) => ({ path: l.path, ...(typeof l.line === 'number' && { line: l.line }) })) : undefined;
}

function permissionOption(o: PermissionOption): ChatPermissionOption {
  const kind = (['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const).includes(o.kind) ? o.kind : 'other';
  return { optionId: o.optionId, kind, label: o.name };
}

function flatOptions(option: SessionConfigOption | undefined): Array<{ value: string; name: string; description?: string | null; _meta?: Meta }> {
  if (option?.type !== 'select' || !Array.isArray(option.options)) return [];
  type Flat = { value: string; name: string; description?: string | null; _meta?: Meta };
  return (option.options as unknown as Array<Flat & { options?: Flat[] }>).flatMap((o) => (Array.isArray(o.options) ? o.options : [o]));
}

/**
 * The model and effort choices a session offers, for the UI's pickers. Models
 * come from the `model` config option (deduped by the profile already) or
 * the legacy model list.
 */
export function sessionChoices(
  state: Readonly<AcpSessionState>,
  modelCostHint?: AcpAgentProfile['modelCostHint'],
): { models?: ChatModelOption[]; efforts?: string[] } {
  const modelOption = state.configOptions.find((o) => o.category === 'model') ?? state.configOptions.find((o) => o.id === 'model');
  const fromOption = flatOptions(modelOption).map((o) => ({ id: o.value, name: o.name, description: o.description, meta: o._meta }));
  const fromLegacy = (state.legacyModels?.availableModels ?? []).map((m) => ({ id: m.modelId, name: m.name, description: m.description, meta: m._meta }));
  const models = (fromOption.length ? fromOption : fromLegacy).map((m): ChatModelOption => {
    const costHint = modelCostHint?.(m.meta ?? undefined);
    return {
      id: m.id,
      label: m.name,
      ...(m.description && m.description !== m.name && { description: m.description }),
      ...(costHint && { costHint }),
    };
  });
  const efforts = flatOptions(state.configOptions.find((o) => o.category === 'thought_level')).map((o) => o.value);
  return { ...(models.length && { models }), ...(efforts.length && { efforts }) };
}

function modelChanged(modelId: string, effort: string | undefined, isDefault: boolean): ChatEventDraft {
  return { type: 'model_changed', data: { modelId, ...(effort && { effort }), ...(isDefault && { effortIsDefault: true }) } };
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
  /** Path and content of each tool call seen, for the permission request that follows it. */
  private readonly toolCalls = new Map<string, {
    locations?: ReturnType<typeof locations>;
    content?: ChatToolCallContent[];
    /** The card title shown, when the call got a tool card (not a plan write). */
    title?: string;
    name?: string | null;
    kind?: ToolCall['kind'];
  }>();
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
  /** ACP has no "default" effort: the session's starting level counts as it until one is chosen. */
  private effortPinned: boolean;
  private reportedDefault: boolean | undefined;
  /** The last turn's reported usage, to spot a repeat (see turn_ended). */
  private lastUsageKey: string | undefined;
  private level: PermissionLevel | undefined;

  private choicesKey = '';
  private commandsKey = '';
  private readonly levels?: AcpPermissionLevels;
  private readonly modelCostHint?: AcpAgentProfile['modelCostHint'];
  private readonly profile?: Pick<AcpAgentProfile, 'planFilePath' | 'tasksAfterToolCall' | 'contextWindow'>;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  /** Tool calls that write the agent's plan file, by id → the file. */
  private readonly planWrites = new Map<string, string>();
  /** Raw input of each tool call, for tasksAfterToolCall when it completes. */
  private readonly toolInputs = new Map<string, unknown>();
  private tasks: AcpTask[] = [];
  private planMarkdown = '';

  constructor(
    private readonly driver: ChatDriverId,
    opts: {
      profile?: Pick<AcpAgentProfile, 'permissionLevels' | 'modelCostHint' | 'planFilePath' | 'tasksAfterToolCall' | 'contextWindow'>;
      /** The agent's environment, for locating its plan file. */
      env?: Record<string, string | undefined>;
      now?: () => number;
      /** The session was started with a chosen effort, so it isn't the agent's default. */
      effortPinned?: boolean;
    } = {},
  ) {
    this.effortPinned = opts.effortPinned ?? false;
    this.levels = opts.profile?.permissionLevels;
    this.modelCostHint = opts.profile?.modelCostHint;
    this.profile = opts.profile;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
  }

  /**
   * An effort was chosen in the session, so it's no longer the agent's default.
   * Reports the change when the agent's own update didn't already.
   */
  pinEffort(state: Readonly<AcpSessionState>): ChatEventDraft[] {
    this.effortPinned = true;
    return this.configChanges(state);
  }

  /** Seed model/effort/level/choices from the session state so only changes are reported. */
  prime(state: Readonly<AcpSessionState>): void {
    this.model = this.currentModel(state);
    this.effort = selectValue(state.configOptions, (o) => o.category === 'thought_level');
    this.reportedDefault = !!this.effort && !this.effortPinned;
    this.level = this.levels?.current(state);
    this.choicesKey = JSON.stringify(sessionChoices(state, this.modelCostHint));
  }

  /** The session facts the driver reports once setup is done. */
  initialInfo(state: Readonly<AcpSessionState>, cliVersion?: string): ChatEventDraft {
    const model = this.currentModel(state);
    return {
      type: 'session_info',
      data: {
        ...(state.sessionId && { nativeSessionId: state.sessionId }),
        ...(cliVersion && { cliVersion }),
        ...(state.title && { title: state.title }),
        ...(model && { model }),
        ...sessionChoices(state, this.modelCostHint),
        ...(this.levels?.names && { levelNames: this.levels.names }),
      },
    };
  }

  /** The agent's plan file for this session among `paths`, if any. */
  private planFileAmong(paths: string[], state: Readonly<AcpSessionState>): string | undefined {
    if (!paths.length || !this.profile?.planFilePath) return undefined;
    return this.profile.planFilePath(paths, { sessionId: state.sessionId, env: this.env });
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
        // Copilot answers a local command such as /context with the previous
        // prompt's usage unchanged (#2180); an exact repeat is no usage.
        const usageKey = event.usage ? JSON.stringify(event.usage) : undefined;
        const repeated = usageKey !== undefined && usageKey === this.lastUsageKey;
        if (usageKey !== undefined) this.lastUsageKey = usageKey;
        const tokens = repeated ? undefined : toTokenUsage(event.usage);
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
        this.lastKind = 'other';
        const tc = event.toolCall;
        // Copilot's request carries a generic title ("Create file") and no
        // content; the tool_call it belongs to has the path and diff (#2159).
        const known = this.toolCalls.get(tc.toolCallId);
        const locs = locations(tc.locations) ?? known?.locations;
        const content = toolContent(tc.content) ?? known?.content ?? rawInputPreview(tc.rawInput);
        const description = locs?.length
          ? locs.map((l) => (l.line !== undefined ? `${l.path}:${l.line}` : l.path)).join(', ')
          : rawInputPath(tc.rawInput);
        return [this.scoped({
          type: 'permission_request',
          data: {
            requestId: event.requestId,
            title: tc.title ?? 'Permission requested',
            ...(description && { description }),
            ...(content?.length && { content }),
            toolCallId: tc.toolCallId,
            ...(tc.name && { toolName: tc.name }),
            ...(tc.rawInput !== undefined && { rawInput: tc.rawInput }),
            options: event.options.map(permissionOption),
          },
        })];
      }
      case 'permission_resolved': {
        // The chat runtime emits permission_resolved for every answer it gives (user or
        // Annex). Only a cancellation the driver caused (interrupt answers pending
        // requests 'cancelled') is news to it.
        if (event.outcome.outcome !== 'cancelled') return [];
        return [this.scoped({ type: 'permission_resolved', data: { requestId: event.requestId, decision: 'cancelled', by: 'user' } })];
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
        const content = u.content ? toolContent(u.content, u.rawOutput) : undefined;
        if (u.rawInput !== undefined) this.toolInputs.set(u.toolCallId, u.rawInput);
        const patched = patchFiles(u.rawInput);
        const planFile = this.planFileAmong([...toolPaths(u.locations, u.content), ...patched.map((f) => f.path)], state);
        if (planFile) {
          // A write to the agent's plan file is the plan, not a workspace edit (#2176).
          this.toolCalls.set(u.toolCallId, { locations: locations(u.locations), content });
          this.planWrites.set(u.toolCallId, planFile);
          const markdown = diffNewText(u.content, planFile) ?? patched.find((f) => f.path === planFile)?.added ?? this.planMarkdown;
          this.planMarkdown = markdown;
          return [this.scoped({ type: 'plan_document', data: { planId: planFile, markdown, status: 'streaming', toolCallId: u.toolCallId } })];
        }
        const title = toolTitle(u.title, u.name, u.kind);
        this.toolCalls.set(u.toolCallId, { locations: locations(u.locations), content, title, name: u.name, kind: u.kind });
        return [this.scoped({
          type: 'tool_call',
          data: {
            toolCallId: u.toolCallId,
            kind: u.kind ?? 'other',
            title,
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
        const known = this.toolCalls.get(tu.toolCallId);
        let planFile = this.planWrites.get(tu.toolCallId);
        // The tool_call may not have named the plan file; its update's diff can (#2176).
        const lateCard = !planFile && known?.title !== undefined;
        if (!planFile) {
          planFile = this.planFileAmong([...toolPaths(tu.locations, tu.content), ...patchFiles(tu.rawInput).map((f) => f.path)], state);
          if (planFile) this.planWrites.set(tu.toolCallId, planFile);
        }
        if (planFile) {
          const out: ChatEventDraft[] = [];
          const diffText = diffNewText(tu.content ?? undefined, planFile);
          if (tu.status === 'completed' || tu.status === 'failed') {
            this.planWrites.delete(tu.toolCallId);
            this.toolInputs.delete(tu.toolCallId);
          }
          if (tu.status === 'completed') {
            // The file on disk is the whole plan, edits included; the diff is a fallback.
            const markdown = readSmallFile(planFile) ?? diffText ?? this.planMarkdown;
            this.planMarkdown = markdown;
            out.push(this.scoped({ type: 'plan_document', data: { planId: planFile, markdown, status: 'ready', toolCallId: tu.toolCallId } }));
          } else if (diffText !== undefined) {
            this.planMarkdown = diffText;
            out.push(this.scoped({ type: 'plan_document', data: { planId: planFile, markdown: diffText, status: 'streaming', toolCallId: tu.toolCallId } }));
          }
          // A card already shown for the call still needs to settle.
          if (lateCard && tu.status) out.push(this.scoped({ type: 'tool_call_update', data: { toolCallId: tu.toolCallId, status: tu.status } }));
          return out;
        }
        // A punctuation-only title never replaces a readable one (#2177).
        const title = !tu.title ? undefined
          : readable(tu.title) ? tu.title
          : known?.title ?? toolTitle(tu.title, tu.name ?? known?.name, tu.kind ?? known?.kind);
        const content = toolContent(tu.content, tu.rawOutput);
        const out: ChatEventDraft[] = [];
        if (tu.status === 'completed' && this.profile?.tasksAfterToolCall) {
          const tasks = this.profile.tasksAfterToolCall(this.toolInputs.get(tu.toolCallId) ?? tu.rawInput, this.tasks);
          if (tasks) {
            this.tasks = tasks;
            out.push(this.scoped({ type: 'plan', data: { entries: tasks.map((t) => ({ id: t.id, content: t.content, status: t.status })) } }));
          }
        }
        if (tu.status === 'completed' || tu.status === 'failed') this.toolInputs.delete(tu.toolCallId);
        return [...out, this.scoped({
          type: 'tool_call_update',
          data: {
            toolCallId: tu.toolCallId,
            ...(tu.status && { status: tu.status }),
            ...(title && { title }),
            ...(content && { content, contentMode: 'replace' as const }),
            ...(tu.rawOutput !== undefined && { rawOutput: tu.rawOutput }),
          },
        })];
      }
      case 'plan':
        if (replay) return [];
        this.tasks = u.entries.map((e, i) => ({ id: String(i), content: e.content, status: e.status }));
        return [this.scoped({
          type: 'plan',
          data: { entries: u.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority })) },
        })];
      case 'available_commands_update': {
        const commands = u.availableCommands.map((c) => ({
          name: c.name,
          ...(c.description && { description: c.description }),
          ...(c.input?.hint && { inputHint: c.input.hint }),
        }));
        // Agents resend the same list (Copilot does on every session/load); report changes only.
        const key = JSON.stringify(commands);
        if (key === this.commandsKey) return [];
        this.commandsKey = key;
        return [{ type: 'commands_available', data: { commands } }];
      }
      case 'current_mode_update':
      case 'config_option_update':
        return this.configChanges(state, u.sessionUpdate === 'current_mode_update' ? u.currentModeId : undefined);
      case 'usage_update':
        return [{
          type: 'usage',
          data: {
            scope: 'session',
            context: { used: u.used, size: u.size, ...(this.profile?.contextWindow === 'input' && { window: 'input' as const }) },
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
    const isDefault = !!effort && !this.effortPinned;
    if (model && (model !== this.model || effort !== this.effort || isDefault !== this.reportedDefault)) {
      out.push(modelChanged(model, effort, isDefault));
      this.reportedDefault = isDefault;
    }
    this.model = model;
    this.effort = effort;

    const choices = sessionChoices(state, this.modelCostHint);
    const choicesKey = JSON.stringify(choices);
    if (choicesKey !== this.choicesKey) {
      // Absent means unchanged, so a list that went away is sent as [] to clear it.
      const previous = JSON.parse(this.choicesKey || '{}') as ReturnType<typeof sessionChoices>;
      const changed = (key: 'models' | 'efforts') => JSON.stringify(choices[key]) !== JSON.stringify(previous[key]);
      out.push({
        type: 'session_info',
        data: {
          ...(changed('models') && { models: choices.models ?? [] }),
          ...(changed('efforts') && { efforts: choices.efforts ?? [] }),
        },
      });
    }
    this.choicesKey = choicesKey;

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
