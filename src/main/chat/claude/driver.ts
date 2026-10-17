import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { MINIMAL_CHAT_CAPABILITIES, type ChatCapabilities, type ChatDriverId, type PermissionLevel } from '../../../shared/chat/capabilities';
import type {
  ChatErrorCode,
  ChatEventDraft,
  ChatQuestion,
  ChatQuestionAnswers,
  ContentBlock,
  MessageDelivery,
  PermissionOption,
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
  TurnStopReason,
} from '../../../shared/chat/events';
import type {
  ChatDriver,
  ChatDriverProbe,
  ChatDriverSession,
  ChatDriverStartOptions,
  PermissionResponseExtras,
} from '../../../shared/chat/runtime';
import { AsyncQueue } from '../../orchestrators/adapters/async-queue';
import type { ClaudeChatEvent, ClaudePermissionMode, ClaudePermissionUpdate, ClaudeUsage } from './events';
import { ClaudeSdkTransport } from './sdk-transport';
import { ClaudeStreamTransport } from './stream-transport';
import type { ClaudeImageInput, ClaudeTransport, ClaudeTransportLog, ClaudeTransportOptions } from './transport';

export type ClaudeChatDriverId = Extract<ChatDriverId, 'claude_agent_sdk' | 'claude_stream_json'>;

const PROVIDER = 'claude-code';

// ── Permission ladder ───────────────────────────────────────────────────────

const LEVEL_TO_MODE: Record<PermissionLevel, ClaudePermissionMode> = {
  plan: 'plan',
  ask: 'default',
  auto_edit: 'acceptEdits',
  auto: 'auto',
  full_access: 'bypassPermissions',
};

/** Native mode → level. `dontAsk` (deny anything not pre-approved) and the CLI's `manual` alias sit on "ask". */
export function levelFromClaudeMode(mode: string): PermissionLevel {
  switch (mode) {
    case 'plan': return 'plan';
    case 'acceptEdits': return 'auto_edit';
    case 'auto': return 'auto';
    case 'bypassPermissions': return 'full_access';
    default: return 'ask';
  }
}

export function claudeModeFromLevel(level: PermissionLevel): ClaudePermissionMode {
  return LEVEL_TO_MODE[level];
}

/**
 * What Claude supports live. `full_access` (bypassPermissions) can only be
 * switched to when the session launched with it allowed, so it is live only
 * for sessions that started at that level.
 */
export function claudeCapabilities(startLevel: PermissionLevel): ChatCapabilities {
  return {
    ...MINIMAL_CHAT_CAPABILITIES,
    steer: true,
    queue: 'native',
    interrupt: true,
    resume: 'native',
    planApproval: true,
    // AskUserQuestion arrives as a can_use_tool request; it is surfaced as `question`.
    questions: true,
    subagents: 'full',
    usage: 'cost',
    limits: true,
    images: true,
    slashCommands: true,
    modelSwitch: 'live',
    // Claude takes --effort at launch only.
    effortSwitch: 'restart',
    liveLevels: startLevel === 'full_access'
      ? ['plan', 'ask', 'auto_edit', 'auto', 'full_access']
      : ['plan', 'ask', 'auto_edit', 'auto'],
    login: 'terminal',
    systemPrompt: true,
    // can_use_tool answers take a deny message and an updatedInput (respondPermission).
    permissionExtras: { denyMessage: true, updatedInput: true },
  };
}

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read', NotebookRead: 'read',
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  Glob: 'search', Grep: 'search', LS: 'search', ToolSearch: 'search',
  Bash: 'execute', BashOutput: 'execute', KillShell: 'execute', PowerShell: 'execute',
  WebFetch: 'fetch', WebSearch: 'fetch',
  EnterPlanMode: 'switch_mode', ExitPlanMode: 'switch_mode',
  TodoWrite: 'think', TaskCreate: 'think', TaskUpdate: 'think',
};

export function claudeToolKind(name: string): ToolKind {
  return TOOL_KINDS[name] ?? 'other';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function inputPath(input: Obj): string | undefined {
  return str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
}

export function claudeToolTitle(name: string, input: Obj, cwd: string): string {
  const p = inputPath(input);
  const shown = p && path.isAbsolute(p) && cwd ? path.relative(cwd, p) || p : p;
  switch (name) {
    case 'Bash': return str(input.description) ?? str(input.command) ?? 'Run command';
    case 'Read': return shown ? `Read ${shown}` : 'Read';
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return shown ? `Edit ${shown}` : 'Edit';
    case 'Write': return shown ? `Write ${shown}` : 'Write';
    case 'Grep': return input.pattern ? `Search for ${String(input.pattern)}` : 'Search';
    case 'Glob': return input.pattern ? `Find ${String(input.pattern)}` : 'Find files';
    case 'WebFetch': return str(input.url) ? `Fetch ${String(input.url)}` : 'Fetch';
    case 'WebSearch': return str(input.query) ? `Search the web for ${String(input.query)}` : 'Search the web';
    case 'Task': case 'Agent': return str(input.description) ?? 'Run subagent';
    case 'ExitPlanMode': return 'Plan ready for review';
    default: return name;
  }
}

function toolLocations(input: Obj): ToolCallLocation[] | undefined {
  const p = inputPath(input);
  return p ? [{ path: p }] : undefined;
}

/** Diff or terminal content from the CLI's typed tool_use_result, falling back to the result text. */
export function claudeToolContent(name: string, input: Obj, result: unknown, text: string, cwd: string): ToolCallContent[] | undefined {
  if (isObj(result)) {
    const filePath = str(result.filePath);
    if (filePath && typeof result.newString === 'string') {
      return [{ type: 'diff', path: filePath, oldText: str(result.oldString), newText: result.newString }];
    }
    if (filePath && typeof result.content === 'string' && (result.type === 'create' || result.type === 'update')) {
      return [{ type: 'diff', path: filePath, oldText: str(result.originalFile) ?? undefined, newText: result.content }];
    }
    if (name === 'Bash' && (typeof result.stdout === 'string' || typeof result.stderr === 'string')) {
      const output = [str(result.stdout), str(result.stderr)].filter(Boolean).join('\n');
      return [{ type: 'terminal', command: str(input.command), cwd, output }];
    }
  }
  return text ? [{ type: 'text', text }] : undefined;
}

function todoEntries(input: Obj): PlanEntry[] | undefined {
  if (!Array.isArray(input.todos)) return undefined;
  return input.todos.filter(isObj).map((t) => ({
    content: str(t.content) ?? '',
    status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
  }));
}

// ── Permissions ─────────────────────────────────────────────────────────────

export const CLAUDE_OPTION_ALLOW = 'allow';
export const CLAUDE_OPTION_ALLOW_ALWAYS = 'allow_always';
export const CLAUDE_OPTION_DENY = 'deny';

function describeSuggestion(s: ClaudePermissionUpdate): string | undefined {
  if (Array.isArray(s.rules)) {
    return s.rules.filter(isObj).map((r) => (r.ruleContent ? `${String(r.toolName)}(${String(r.ruleContent)})` : String(r.toolName))).join(', ');
  }
  if (s.type === 'setMode' && typeof s.mode === 'string') return `${s.mode} mode`;
  if (Array.isArray(s.directories)) return s.directories.join(', ');
  return undefined;
}

export function claudePermissionOptions(suggestions: ClaudePermissionUpdate[]): PermissionOption[] {
  const options: PermissionOption[] = [{ optionId: CLAUDE_OPTION_ALLOW, kind: 'allow_once', label: 'Allow' }];
  if (suggestions.length > 0) {
    const scope = suggestions.map(describeSuggestion).filter(Boolean).join('; ') || undefined;
    options.push({ optionId: CLAUDE_OPTION_ALLOW_ALWAYS, kind: 'allow_always', label: "Allow and don't ask again", scope });
  }
  options.push({ optionId: CLAUDE_OPTION_DENY, kind: 'reject_once', label: 'Deny' });
  return options;
}

// ── Questions ───────────────────────────────────────────────────────────────

/**
 * Claude's AskUserQuestion input (`questions: [{ question, header, options:
 * [{ label, description }], multiSelect }]`) as contract questions. The
 * question text is the id, because the answer goes back keyed by it.
 */
export function claudeQuestions(input: Obj): ChatQuestion[] | undefined {
  if (!Array.isArray(input.questions)) return undefined;
  const questions = input.questions.filter(isObj).map((q): ChatQuestion => {
    const prompt = str(q.question) ?? '';
    return {
      id: prompt,
      prompt,
      header: str(q.header),
      options: Array.isArray(q.options)
        ? q.options.filter(isObj).map((o) => ({ id: str(o.label) ?? '', label: str(o.label) ?? '', description: str(o.description) }))
        : undefined,
      multiSelect: q.multiSelect === true,
      // Claude's own UI always offers "Other" with free text.
      allowFreeText: true,
    };
  });
  return questions.length ? questions : undefined;
}

/** AskUserQuestion's approved input: the original plus `answers` keyed by question text. */
export function claudeQuestionInput(input: Obj, answers: ChatQuestionAnswers): Obj {
  const flat: Record<string, string> = {};
  for (const [id, a] of Object.entries(answers)) flat[id] = Array.isArray(a) ? a.join(', ') : a;
  return { ...input, answers: flat };
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Claude's assistant `error` kinds (SDKAssistantMessageError) → contract codes. */
const API_ERROR_CODES: Record<string, ChatErrorCode> = {
  authentication_failed: 'auth_required',
  oauth_org_not_allowed: 'auth_required',
  account_on_hold: 'auth_required',
  verification_required: 'auth_required',
  billing_error: 'auth_required',
  cloud_credential_error: 'auth_required',
  rate_limit: 'rate_limited',
  max_output_tokens: 'max_tokens',
};

/** The result's terminal_reason → contract codes, for failures without an assistant error. */
const TERMINAL_REASON_CODES: Record<string, ChatErrorCode> = {
  prompt_too_long: 'context_overflow',
  blocking_limit: 'rate_limited',
  rapid_refill_breaker: 'rate_limited',
  malformed_tool_use_exhausted: 'protocol_error',
};

/**
 * The single error code for a failed turn: the assistant's API error kind if
 * one arrived, else the terminal reason, else the model's stop reason.
 */
export function claudeTurnErrorCode(apiError: string | undefined, terminalReason?: string, stopReason?: string): ChatErrorCode {
  if (apiError) return API_ERROR_CODES[apiError] ?? 'unknown';
  if (terminalReason && TERMINAL_REASON_CODES[terminalReason]) return TERMINAL_REASON_CODES[terminalReason];
  if (stopReason === 'max_tokens') return 'max_tokens';
  if (stopReason === 'refusal') return 'refusal';
  return 'unknown';
}

/** Kinds that only occur inside a turn; one arriving while idle means a queued message started a turn. */
const TURN_OPENING_KINDS: ReadonlySet<ClaudeChatEvent['kind']> = new Set([
  'message_chunk', 'thought_chunk', 'message', 'thought', 'tool_call', 'tool_call_update', 'permission_request', 'turn_ended',
]);

// ── Images ──────────────────────────────────────────────────────────────────

const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** An image block as Claude input: inline data, or a local file read from `path` or a file: `uri`. */
export async function claudeImageInput(block: Extract<ContentBlock, { type: 'image' }>): Promise<ClaudeImageInput> {
  if (!IMAGE_TYPES.has(block.mimeType)) throw new Error(`Claude doesn't accept ${block.mimeType} images`);
  const mediaType = block.mimeType as ClaudeImageInput['mediaType'];
  if (block.data) return { mediaType, data: block.data };
  const file = block.path ?? (block.uri?.startsWith('file:') ? fileURLToPath(block.uri) : undefined);
  if (!file) throw new Error(`Claude chat can't attach an image from ${block.uri ?? 'nowhere'}: only inline data or local files`);
  return { mediaType, data: (await fsp.readFile(file)).toString('base64') };
}

const LIMIT_STATUS: Record<string, 'ok' | 'warning' | 'exceeded'> = {
  allowed: 'ok',
  allowed_warning: 'warning',
  rejected: 'exceeded',
};

// ── Usage ───────────────────────────────────────────────────────────────────

function tokens(u: ClaudeUsage | undefined) {
  if (!u) return undefined;
  return {
    input: u.inputTokens,
    cachedInput: u.cacheReadInputTokens,
    cacheWrite: u.cacheCreationInputTokens,
    output: u.outputTokens,
    total: u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens + u.outputTokens,
  };
}

/** Sum the CLI's cumulative per-model usage (main loop, subagents, compaction) into session tokens. */
function sessionTokens(modelUsage: Record<string, unknown> | undefined) {
  if (!modelUsage) return undefined;
  let input = 0, output = 0, cachedInput = 0, cacheWrite = 0;
  for (const m of Object.values(modelUsage)) {
    if (!isObj(m)) continue;
    input += typeof m.inputTokens === 'number' ? m.inputTokens : 0;
    output += typeof m.outputTokens === 'number' ? m.outputTokens : 0;
    cachedInput += typeof m.cacheReadInputTokens === 'number' ? m.cacheReadInputTokens : 0;
    cacheWrite += typeof m.cacheCreationInputTokens === 'number' ? m.cacheCreationInputTokens : 0;
  }
  return { input, output, cachedInput, cacheWrite, total: input + output + cachedInput + cacheWrite };
}

const LIMIT_WINDOWS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'week',
  seven_day_opus: 'week_opus',
  seven_day_sonnet: 'week_sonnet',
};

// ── Session ─────────────────────────────────────────────────────────────────

export type ClaudeTransportFactory = (id: ClaudeChatDriverId, opts: ClaudeTransportOptions) => ClaudeTransport;

const defaultTransportFactory: ClaudeTransportFactory = (id, opts) =>
  id === 'claude_agent_sdk' ? new ClaudeSdkTransport(opts) : new ClaudeStreamTransport(opts);

interface ToolInfo { name: string; input: Obj; parentToolCallId?: string }

/**
 * One chat session over a Claude transport, translated to the shared chat
 * contract. Stays thin: no envelopes, transcripts or lifecycle beyond what
 * the protocol reports (src/shared/chat/README.md).
 */
export class ClaudeChatDriverSession implements ChatDriverSession {
  readonly capabilities: ChatCapabilities;
  private readonly queue = new AsyncQueue<ChatEventDraft>();
  private readonly tools = new Map<string, ToolInfo>();
  private readonly pendingPermissions = new Map<string, ClaudePermissionUpdate[]>();
  /** AskUserQuestion requests, surfaced as `question`: requestId → tool input. */
  private readonly pendingQuestions = new Map<string, Obj>();
  /** Subagent names from task_started; later task_* messages don't repeat them. */
  private readonly subagentNames = new Map<string, string>();
  private turn = 0;
  private turnRunning = false;
  private interrupting = false;
  private closing = false;
  private level: PermissionLevel;
  private model: string | undefined;
  /** apiKeySource 'none' means a claude.ai login: dollars are API-price estimates. */
  private costIsEstimate = true;
  /**
   * total_cost_usd from the previous result. The CLI reports a running total
   * for the session, so a turn's cost is the difference. Unknown on the first
   * result of a resumed session, whose total includes the earlier turns.
   */
  private lastTotalCostUsd: number | undefined;
  /** An assistant API error seen in this turn, reported once when the turn ends. */
  private turnApiError: string | undefined;
  private pump: Promise<void> | null = null;

  constructor(
    readonly driverId: ClaudeChatDriverId,
    private readonly transport: ClaudeTransport,
    private readonly opts: ChatDriverStartOptions,
    private readonly log?: ClaudeTransportLog,
  ) {
    this.level = opts.level;
    this.model = opts.model;
    this.capabilities = claudeCapabilities(opts.level);
  }

  get nativeSessionId(): string | undefined {
    return this.transport.sessionId || this.opts.resumeNativeSessionId || undefined;
  }

  get events(): AsyncIterable<ChatEventDraft> {
    return this.queue;
  }

  async start(): Promise<void> {
    this.pump = this.drain();
    await this.transport.start();
  }

  async send(content: ContentBlock[], delivery: MessageDelivery): Promise<MessageDelivery> {
    const text = content
      .map((b) => (b.type === 'text' ? b.text : b.type === 'file' ? b.path : b.type === 'resource' ? b.text ?? b.uri : ''))
      .filter(Boolean)
      .join('\n');
    const images = await Promise.all(
      content.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image').map(claudeImageInput),
    );
    // Idle: whatever was asked, the message starts a turn.
    const actual: MessageDelivery = this.turnRunning ? delivery : 'prompt';
    if (!this.turnRunning) this.beginTurn('prompt');
    this.transport.send({
      text,
      images: images.length ? images : undefined,
      // 'next' folds the message into the running turn at the next tool boundary.
      // 'now' would make the CLI cut (interrupt) the turn and run the message alone.
      priority: actual === 'steer' ? 'next' : actual === 'queued' ? 'later' : undefined,
    });
    return actual;
  }

  async interrupt(): Promise<void> {
    if (this.turnRunning) this.interrupting = true;
    await this.transport.interrupt();
  }

  async respondPermission(requestId: string, optionId: string, extras?: PermissionResponseExtras): Promise<void> {
    const suggestions = this.pendingPermissions.get(requestId);
    if (!suggestions) throw new Error(`No pending Claude permission request ${requestId}`);
    this.pendingPermissions.delete(requestId);
    // e.g. a revised plan for ExitPlanMode
    const updatedInput = isObj(extras?.updatedInput) ? extras.updatedInput : undefined;
    if (optionId === CLAUDE_OPTION_ALLOW) {
      this.transport.respondToPermission(requestId, { behavior: 'allow', updatedInput });
    } else if (optionId === CLAUDE_OPTION_ALLOW_ALWAYS) {
      this.transport.respondToPermission(requestId, { behavior: 'allow', updatedInput, updatedPermissions: suggestions });
    } else if (optionId === CLAUDE_OPTION_DENY) {
      // A denial message tells Claude what to do instead.
      this.transport.respondToPermission(requestId, { behavior: 'deny', message: extras?.message || 'The user denied this request.' });
    } else {
      this.pendingPermissions.set(requestId, suggestions);
      throw new Error(`Unknown Claude permission option ${optionId}`);
    }
    this.push({
      type: 'permission_resolved',
      data: { requestId, optionId, decision: optionId === CLAUDE_OPTION_DENY ? 'deny' : 'allow', by: 'user' },
    }, true);
  }

  async answerQuestion(requestId: string, answers: ChatQuestionAnswers): Promise<void> {
    const input = this.pendingQuestions.get(requestId);
    if (!input) throw new Error(`No pending Claude question ${requestId}`);
    this.pendingQuestions.delete(requestId);
    this.transport.respondToPermission(requestId, { behavior: 'allow', updatedInput: claudeQuestionInput(input, answers) });
    this.push({ type: 'question_resolved', data: { requestId, answers } }, true);
  }

  async setLevel(level: PermissionLevel): Promise<void> {
    if (!this.capabilities.liveLevels.includes(level)) {
      throw new Error(`Claude can't switch to ${level} without restarting the session`);
    }
    await this.transport.setPermissionMode(claudeModeFromLevel(level));
    this.changeLevel(level, claudeModeFromLevel(level));
  }

  async setModel(modelId: string, effort?: string): Promise<void> {
    await this.transport.setModel(modelId === 'default' ? undefined : modelId);
    // effortSwitch is 'restart': the runtime passes the new effort at the next start.
    if (effort) this.log?.('info', '[claude-chat] Effort applies from the next session start', { effort });
    this.model = modelId;
    this.push({ type: 'model_changed', data: { modelId } });
  }

  async compact(): Promise<void> {
    if (!this.turnRunning) this.beginTurn('system');
    this.transport.send({ text: '/compact' });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.transport.close();
    await this.pump;
  }

  // ── Mapping ───────────────────────────────────────────────────────────────

  private get turnId(): string | undefined {
    return this.turn > 0 ? `turn-${this.turn}` : undefined;
  }

  /** Turn-scoped drafts get the running turn's id; outside a turn they go out session-scoped. */
  private push(draft: ChatEventDraft, turnScoped = false): void {
    this.queue.push(turnScoped && this.turnRunning && this.turnId ? { ...draft, turnId: this.turnId } as ChatEventDraft : draft);
  }

  private beginTurn(trigger: MessageDelivery | 'system'): void {
    this.turn += 1;
    this.turnRunning = true;
    this.interrupting = false;
    this.turnApiError = undefined;
    this.push({ type: 'turn_started', data: { trigger } }, true);
  }

  private changeLevel(level: PermissionLevel, nativeMode: string): void {
    if (level === this.level) return;
    this.level = level;
    this.push({ type: 'mode_changed', data: { level, nativeMode } });
  }

  private async drain(): Promise<void> {
    try {
      for await (const ev of this.transport.events) this.map(ev);
    } finally {
      this.queue.finish();
    }
  }

  private map(ev: ClaudeChatEvent): void {
    // A queued message can start a turn on its own once the previous one ends.
    if (TURN_OPENING_KINDS.has(ev.kind) && !this.turnRunning) this.beginTurn('queued');

    switch (ev.kind) {
      case 'initialized': {
        const cliVersion = str(ev.raw.claude_code_version);
        const mode = str(ev.raw.current_permission_mode);
        this.push({
          type: 'session_started',
          data: {
            driver: this.driverId,
            provider: PROVIDER,
            cwd: this.opts.cwd,
            resumed: !!this.opts.resumeNativeSessionId,
            nativeSessionId: this.nativeSessionId,
            cliVersion,
            model: this.model,
            level: mode ? levelFromClaudeMode(mode) : this.level,
            capabilities: this.capabilities,
          },
        });
        if (ev.commands.length) {
          this.push({
            type: 'commands_available',
            data: { commands: ev.commands.map((c) => ({ name: c.name, description: c.description, inputHint: c.argumentHint || undefined })) },
          });
        }
        return;
      }
      case 'session_started':
        // system/init only arrives with the first prompt: the native session id and resolved model are known now.
        this.costIsEstimate = ev.apiKeySource === undefined || ev.apiKeySource === 'none';
        this.push({
          type: 'session_info',
          data: { nativeSessionId: ev.sessionId || undefined, cliVersion: ev.cliVersion || undefined, model: ev.model || undefined },
        });
        if (ev.model && ev.model !== this.model) {
          this.model = ev.model;
          this.push({ type: 'model_changed', data: { modelId: ev.model } });
        }
        if (ev.permissionMode) this.changeLevel(levelFromClaudeMode(ev.permissionMode), ev.permissionMode);
        return;
      case 'user_message':
        // The chat runtime records what it sent; CLI echoes add nothing.
        return;
      case 'message_chunk':
      case 'thought_chunk':
      case 'message':
      case 'thought': {
        const messageId = ev.messageId ?? `turn-${this.turn}`;
        const type = ev.kind === 'message_chunk' ? 'agent_message_chunk'
          : ev.kind === 'thought_chunk' ? 'agent_thought_chunk'
          : ev.kind === 'message' ? 'agent_message' : 'agent_thought';
        // A subagent is identified by the Task tool call that started it (parent_tool_use_id).
        const data = ev.parentToolCallId ? { messageId, text: ev.text, subagentId: ev.parentToolCallId } : { messageId, text: ev.text };
        this.push({ type, data } as ChatEventDraft, true);
        return;
      }
      case 'tool_call': {
        this.tools.set(ev.toolCallId, { name: ev.name, input: ev.input, parentToolCallId: ev.parentToolCallId });
        this.push({
          type: 'tool_call',
          data: {
            toolCallId: ev.toolCallId,
            kind: claudeToolKind(ev.name),
            title: claudeToolTitle(ev.name, ev.input, this.opts.cwd),
            status: 'pending',
            toolName: ev.name,
            rawInput: ev.input,
            locations: toolLocations(ev.input),
            subagentId: ev.parentToolCallId,
          },
        }, true);
        if (ev.name === 'ExitPlanMode' && typeof ev.input.plan === 'string') {
          this.push({ type: 'plan_document', data: { planId: ev.toolCallId, markdown: ev.input.plan, status: 'ready', toolCallId: ev.toolCallId } }, true);
        }
        // A subagent's own todo list isn't the session's plan.
        const entries = ev.name === 'TodoWrite' && !ev.parentToolCallId ? todoEntries(ev.input) : undefined;
        if (entries) this.push({ type: 'plan', data: { entries } }, true);
        return;
      }
      case 'tool_call_update': {
        const tool = this.tools.get(ev.toolCallId) ?? { name: ev.name, input: {} };
        this.push({
          type: 'tool_call_update',
          data: {
            toolCallId: ev.toolCallId,
            status: ev.status,
            content: claudeToolContent(tool.name, tool.input, ev.result, ev.content, this.opts.cwd),
            rawOutput: ev.result,
            error: ev.status === 'failed' ? ev.content : undefined,
          },
        }, true);
        return;
      }
      case 'permission_request': {
        const questions = ev.toolName === 'AskUserQuestion' ? claudeQuestions(ev.input) : undefined;
        if (questions) {
          this.pendingQuestions.set(ev.requestId, ev.input);
          this.push({ type: 'question', data: { requestId: ev.requestId, questions, toolCallId: ev.toolCallId, subagentId: this.subagentOf(ev.toolCallId) } }, true);
          return;
        }
        this.pendingPermissions.set(ev.requestId, ev.suggestions);
        this.push({
          type: 'permission_request',
          data: {
            requestId: ev.requestId,
            title: ev.title ?? (ev.toolCallId && this.tools.has(ev.toolCallId)
              ? claudeToolTitle(ev.toolName, ev.input, this.opts.cwd)
              : ev.displayName ?? ev.toolName),
            description: ev.description ?? ev.decisionReason,
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            rawInput: ev.input,
            options: claudePermissionOptions(ev.suggestions),
            subagentId: this.subagentOf(ev.toolCallId),
          },
        }, true);
        return;
      }
      case 'permission_cancelled':
        if (this.pendingQuestions.delete(ev.requestId)) {
          this.push({ type: 'question_resolved', data: { requestId: ev.requestId, answers: {}, cancelled: true } }, true);
          return;
        }
        if (!this.pendingPermissions.delete(ev.requestId)) return;
        this.push({ type: 'permission_resolved', data: { requestId: ev.requestId, decision: 'cancelled', by: 'agent' } }, true);
        return;
      case 'permission_denied':
        this.push({ type: 'notice', data: { level: 'info', code: 'permission_denied', message: `${ev.toolName ?? 'A tool'} was denied by the permission mode` } }, true);
        return;
      case 'turn_ended': {
        const stopReason = this.stopReason(ev);
        if (stopReason === 'error') {
          const code = claudeTurnErrorCode(this.turnApiError, ev.terminalReason, ev.stopReason);
          const message = ev.errors?.join('; ') || ev.result || this.turnApiError || `Turn failed (${ev.subtype})`;
          this.push({ type: 'error', data: { code, message, fatal: false } }, true);
        }
        // `usage` is this turn's main loop; total_cost_usd and modelUsage are session running totals.
        const t = tokens(ev.usage);
        const turnCost = this.turnCost(ev.totalCostUsd);
        const costIsEstimate = ev.totalCostUsd !== undefined ? this.costIsEstimate : undefined;
        this.push({ type: 'usage', data: { scope: 'turn', tokens: t, costUsd: turnCost, costIsEstimate: turnCost !== undefined ? costIsEstimate : undefined } }, true);
        if (ev.totalCostUsd !== undefined || ev.modelUsage) {
          this.push({ type: 'usage', data: { scope: 'session', tokens: sessionTokens(ev.modelUsage), costUsd: ev.totalCostUsd, costIsEstimate } }, true);
        }
        this.push({ type: 'turn_ended', data: { stopReason, durationMs: ev.durationMs, usage: t, costUsd: turnCost } }, true);
        this.turnRunning = false;
        this.interrupting = false;
        this.turnApiError = undefined;
        return;
      }
      case 'rate_limit': {
        const window = (ev.rateLimitType && LIMIT_WINDOWS[ev.rateLimitType]) ?? ev.rateLimitType ?? 'limit';
        // The CLI reports resetsAt in epoch seconds; the contract uses epoch ms like ts.
        const resetsAt = ev.resetsAt !== undefined && ev.resetsAt < 1e12 ? ev.resetsAt * 1000 : ev.resetsAt;
        this.push({
          type: 'usage',
          data: { scope: 'session', limits: [{ window, utilization: ev.utilization, status: LIMIT_STATUS[ev.status], resetsAt }] },
        });
        if (ev.status === 'rejected') {
          this.push({ type: 'notice', data: { level: 'warn', code: 'rate_limited', message: 'Plan usage limit reached' } });
        }
        return;
      }
      case 'compacted':
        this.push({ type: 'notice', data: { level: 'info', code: 'compacted', message: 'Context compacted' } }, true);
        return;
      case 'subagent':
        this.mapSubagent(ev);
        return;
      case 'mode_changed':
        this.changeLevel(levelFromClaudeMode(ev.permissionMode), ev.permissionMode);
        return;
      case 'error':
        if (!ev.fatal && this.turnRunning) {
          // Reported once, with the turn's result, so a failed turn yields exactly one error.
          this.turnApiError = ev.apiError ?? ev.message;
          return;
        }
        this.push({
          type: 'error',
          data: { code: ev.fatal ? 'driver_stream_failed' : claudeTurnErrorCode(ev.apiError), message: ev.message, fatal: ev.fatal },
        });
        return;
      case 'unmapped':
        this.push({ type: 'protocol_unknown', data: { driver: this.driverId, kind: 'field', name: ev.subtype ? `${ev.type}/${ev.subtype}` : ev.type } });
        return;
      case 'session_ended':
        if (this.turnRunning) {
          this.push({ type: 'turn_ended', data: { stopReason: this.closing || this.interrupting ? 'cancelled' : 'error' } }, true);
          this.turnRunning = false;
        }
        for (const requestId of this.pendingPermissions.keys()) {
          this.push({ type: 'permission_resolved', data: { requestId, decision: 'cancelled', by: 'agent' } }, true);
        }
        for (const requestId of this.pendingQuestions.keys()) {
          this.push({ type: 'question_resolved', data: { requestId, answers: {}, cancelled: true } }, true);
        }
        this.pendingPermissions.clear();
        this.pendingQuestions.clear();
        this.push({
          type: 'session_ended',
          data: {
            reason: this.closing ? 'stopped' : ev.exitCode === 0 ? 'process_exit' : 'error',
            exitCode: ev.exitCode ?? undefined,
            message: ev.reason ?? (ev.signal ? `Killed by ${ev.signal}` : undefined),
          },
        });
        return;
    }
  }

  /** The subagent (its Task tool call id) a tool call ran in, if any. */
  private subagentOf(toolCallId: string | undefined): string | undefined {
    return toolCallId ? this.tools.get(toolCallId)?.parentToolCallId : undefined;
  }

  private stopReason(ev: Extract<ClaudeChatEvent, { kind: 'turn_ended' }>): TurnStopReason {
    if (ev.subtype === 'error_max_turns') return 'max_turns';
    if (this.interrupting && (ev.subtype === 'error_during_execution' || ev.isError)) return 'cancelled';
    if (ev.subtype === 'success' && !ev.isError) {
      if (ev.stopReason === 'max_tokens') return 'max_tokens';
      if (ev.stopReason === 'refusal') return 'refusal';
      return 'end_turn';
    }
    return 'error';
  }

  private turnCost(total: number | undefined): number | undefined {
    if (total === undefined) return undefined;
    const previous = this.lastTotalCostUsd;
    this.lastTotalCostUsd = total;
    if (previous === undefined) {
      // The first result of a resumed session already carries the earlier turns.
      return this.opts.resumeNativeSessionId ? undefined : total;
    }
    // A mid-session /clear resets the running total.
    return total >= previous ? total - previous : total;
  }

  private mapSubagent(ev: Extract<ClaudeChatEvent, { kind: 'subagent' }>): void {
    const raw = ev.raw;
    const subagentId = str(raw.tool_use_id) ?? ev.taskId;
    if (ev.phase === 'started') {
      this.subagentNames.set(subagentId, str(raw.subagent_type) ?? 'subagent');
      this.push({
        type: 'subagent',
        data: {
          subagentId,
          name: this.subagentNames.get(subagentId) ?? 'subagent',
          description: str(raw.description),
          status: 'running',
          parentToolCallId: str(raw.tool_use_id),
        },
      }, true);
    } else if (ev.phase === 'notification') {
      const s = str(raw.status);
      this.push({
        type: 'subagent',
        data: {
          subagentId,
          name: str(raw.subagent_type) ?? this.subagentNames.get(subagentId) ?? 'subagent',
          status: s === 'failed' ? 'failed' : s === 'stopped' || s === 'killed' ? 'cancelled' : 'completed',
          parentToolCallId: str(raw.tool_use_id),
        },
      }, true);
    }
  }
}

// ── Driver ──────────────────────────────────────────────────────────────────

export function claudeTransportOptions(opts: ChatDriverStartOptions, log?: ClaudeTransportLog): ClaudeTransportOptions {
  if (opts.extraArgs?.length) log?.('warn', '[claude-chat] extraArgs are not supported by the Claude transports', { extraArgs: opts.extraArgs });
  return {
    binary: opts.binaryPath,
    cwd: opts.cwd,
    env: opts.env,
    commandPrefix: opts.commandPrefix,
    permissionMode: claudeModeFromLevel(opts.level),
    model: opts.model,
    effort: opts.effort as ClaudeTransportOptions['effort'],
    appendSystemPrompt: opts.systemPrompt,
    resume: opts.resumeNativeSessionId,
    mcpServers: opts.mcpServers as ClaudeTransportOptions['mcpServers'],
    log,
  };
}

/** `ChatDriver` for Claude Code: `claude_agent_sdk` (default) or `claude_stream_json`. */
export class ClaudeChatDriver implements ChatDriver {
  readonly provider = PROVIDER;

  constructor(
    readonly id: ClaudeChatDriverId,
    private readonly deps: { createTransport?: ClaudeTransportFactory; log?: ClaudeTransportLog } = {},
  ) {}

  /** Zero-token check: spawn, complete `initialize`, close. Sends no prompt. */
  async probe(binaryPath: string, env?: Record<string, string>): Promise<ChatDriverProbe> {
    const capabilities = claudeCapabilities('ask');
    const transport = this.createTransport({
      binary: binaryPath,
      cwd: os.homedir(),
      env,
      permissionMode: 'default',
      includePartialMessages: false,
      log: this.deps.log,
    });
    let cliVersion: string | undefined;
    const collect = (async () => {
      for await (const ev of transport.events) {
        if (ev.kind === 'initialized') cliVersion = str(ev.raw.claude_code_version);
      }
    })();
    try {
      await transport.start();
      return { handshakeOk: true, cliVersion, capabilities };
    } catch (err) {
      return { handshakeOk: false, cliVersion, capabilities, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await transport.close().catch((): undefined => undefined);
      await collect.catch((): undefined => undefined);
    }
  }

  async start(opts: ChatDriverStartOptions): Promise<ClaudeChatDriverSession> {
    const transport = this.createTransport(claudeTransportOptions(opts, this.deps.log));
    const session = new ClaudeChatDriverSession(this.id, transport, opts, this.deps.log);
    try {
      await session.start();
    } catch (err) {
      await transport.close().catch((): undefined => undefined);
      throw err;
    }
    return session;
  }

  private createTransport(opts: ClaudeTransportOptions): ClaudeTransport {
    return (this.deps.createTransport ?? defaultTransportFactory)(this.id, opts);
  }
}

/**
 * Register both Claude drivers with the chat runtime's registry
 * (`registerChatDriver` in services/agent-runtime/chat-drivers.ts). The SDK
 * driver goes first: the registry falls back to the first one registered for
 * a provider, and the SDK is Claude's default mode. Returns one unregister.
 */
export function registerClaudeChatDrivers(
  register: (driver: ChatDriver) => () => void,
  deps: { createTransport?: ClaudeTransportFactory; log?: ClaudeTransportLog } = {},
): () => void {
  const unregister = [
    register(new ClaudeChatDriver('claude_agent_sdk', deps)),
    register(new ClaudeChatDriver('claude_stream_json', deps)),
  ];
  return () => unregister.forEach((u) => u());
}
