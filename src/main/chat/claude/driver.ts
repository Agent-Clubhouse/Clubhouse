import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { MINIMAL_CHAT_CAPABILITIES, PERMISSION_LEVEL_LABELS, type ChatCapabilities, type ChatDriverId, type PermissionLevel } from '../../../shared/chat/capabilities';
import { levelFromClaudeMode } from './permission-mode';
import type {
  ChatErrorCode,
  ChatEventDraft,
  ChatMcpServerStatus,
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
  UsageLimit,
} from '../../../shared/chat/events';
import { COMPACTION_STARTED } from '../../../shared/chat/events';
import type {
  ChatDriver,
  ChatDriverProbe,
  ChatDriverSession,
  ChatDriverStartOptions,
  PermissionResponseExtras,
} from '../../../shared/chat/runtime';
import { AsyncQueue } from '../../orchestrators/adapters/async-queue';
import type { ClaudeChatEvent, ClaudeCommand, ClaudePermissionMode, ClaudePermissionUpdate, ClaudeUsage } from './events';
import { ClaudeSdkTransport } from './sdk-transport';
import { ClaudeStreamTransport } from './stream-transport';
import { CLAUDE_EFFORTS, ClaudeStartupTimeoutError, type ClaudeEffort, type ClaudeImageInput, type ClaudeTransport, type ClaudeTransportLog, type ClaudeTransportOptions } from './transport';

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

export { levelFromClaudeMode };

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
    // apply_flag_settings changes it mid-session, as /effort does.
    effortSwitch: 'live',
    // apply_flag_settings { effortLevel: null } drops back to the model's default.
    effortDefault: true,
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

/** Claude's MCP status words (`needs-auth`, ...) in the shared vocabulary. */
export function claudeMcpStatus(status: string): ChatMcpServerStatus {
  switch (status) {
    case 'connected': return 'connected';
    case 'pending': return 'pending';
    case 'needs-auth': case 'needs_auth': return 'needs_auth';
    case 'failed': return 'failed';
    case 'disabled': return 'disabled';
    default: return 'unknown';
  }
}

export function claudeToolKind(name: string): ToolKind {
  return TOOL_KINDS[name] ?? 'other';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
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

/**
 * The change an Edit, MultiEdit or Write call proposes, from its input, so a
 * pending call (and its approval card) shows a diff before it runs. The
 * CLI's result replaces it once the call finishes (claudeToolContent).
 */
export function claudeInputDiff(name: string, input: Obj): ToolCallContent[] | undefined {
  const filePath = str(input.file_path);
  if (!filePath) return undefined;
  if (name === 'Edit' && typeof input.new_string === 'string') {
    return [{ type: 'diff', path: filePath, oldText: str(input.old_string) ?? '', newText: input.new_string }];
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const diffs = input.edits.filter(isObj).filter((e) => typeof e.new_string === 'string')
      .map((e): ToolCallContent => ({ type: 'diff', path: filePath, oldText: str(e.old_string) ?? '', newText: e.new_string as string }));
    return diffs.length > 0 ? diffs : undefined;
  }
  if (name === 'Write' && typeof input.content === 'string') {
    // Write may create or overwrite; the old content isn't in the input. A
    // unified diff of additions avoids labelling an overwrite "Created".
    const lines = input.content.replace(/\n$/, '').split('\n');
    const unifiedDiff = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
    return [{ type: 'diff', path: filePath, newText: input.content, unifiedDiff }];
  }
  return undefined;
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
  // A mode switch is named by its Clubhouse level ("Auto-accept edits"), not the CLI's mode id.
  if (s.type === 'setMode' && typeof s.mode === 'string') return PERMISSION_LEVEL_LABELS[levelFromClaudeMode(s.mode)];
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
  account_on_hold: 'account_issue',
  verification_required: 'auth_required',
  billing_error: 'account_issue',
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
  // Anthropic's input_tokens excludes cache reads and writes; the contract's
  // `input` is the total input (TokenUsage), so add them in.
  const input = u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
  return {
    input,
    cachedInput: u.cacheReadInputTokens,
    cacheWrite: u.cacheCreationInputTokens,
    output: u.outputTokens,
    total: input + u.outputTokens,
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
  // Total input, as in tokens(): uncached input plus cache reads and writes.
  const totalInput = input + cachedInput + cacheWrite;
  return { input: totalInput, output, cachedInput, cacheWrite, total: totalInput + output };
}

/** Every plan window the CLI reports (rate_limit_event's rateLimitType, get_usage's rate_limits keys). */
export const LIMIT_WINDOWS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'week',
  seven_day_opus: 'week_opus',
  seven_day_sonnet: 'week_sonnet',
  seven_day_oauth_apps: 'week_oauth_apps',
  seven_day_overage_included: 'week_overage_included',
  overage: 'overage',
};

/** A fraction 0..1 from a fraction (rate_limit_event's utilization). */
function fraction(v: number | undefined | null): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(1, Math.max(0, v));
}

/** A fraction 0..1 from a 0-100 percentage (get_usage always reports percent, so 1 means 1%). */
function fromPercent(v: number | undefined | null): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(1, Math.max(0, v / 100));
}

/** Epoch ms from epoch seconds, epoch ms or an ISO string. */
function epochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/**
 * The plan windows in a `get_usage` reply (the data behind /usage): 5-hour,
 * weekly, per-model weekly and extra usage. Null when plan limits don't apply
 * (API key, Bedrock, Vertex) or the reply has none.
 */
export function planLimitsFromWire(response: unknown): UsageLimit[] | null {
  if (!isObj(response) || response.rate_limits_available === false || !isObj(response.rate_limits)) return null;
  const rl = response.rate_limits;
  const out: UsageLimit[] = [];
  for (const [key, window] of Object.entries(LIMIT_WINDOWS)) {
    const w = rl[key];
    if (!isObj(w)) continue;
    const utilization = fromPercent(w.utilization as number | null);
    if (utilization === undefined && w.resets_at == null) continue;
    out.push({ window, ...(utilization !== undefined && { utilization }), ...(epochMs(w.resets_at) !== undefined && { resetsAt: epochMs(w.resets_at) }) });
  }
  for (const m of arr(rl.model_scoped)) {
    if (!isObj(m) || typeof m.display_name !== 'string') continue;
    const utilization = fromPercent(m.utilization as number | null);
    if (utilization === undefined) continue;
    out.push({ window: `week:${m.display_name}`, utilization, ...(epochMs(m.resets_at) !== undefined && { resetsAt: epochMs(m.resets_at) }) });
  }
  const extra = rl.extra_usage;
  if (isObj(extra) && extra.is_enabled === true) {
    const utilization = fromPercent(extra.utilization as number | null);
    if (utilization !== undefined) out.push({ window: 'overage', utilization });
  }
  return out.length ? out : null;
}

/**
 * The context window of the model that served the last call. The result's
 * modelUsage reports it (keyed by the selected id, e.g. `claude-opus-5-5[1m]`);
 * otherwise a `[1m]` id means 1M tokens and anything else the standard 200K.
 */
export function claudeContextWindow(model: string | undefined, modelUsage: Record<string, unknown> | undefined, selected?: string): number | undefined {
  const windows = Object.entries(modelUsage ?? {}).flatMap(([id, u]) =>
    (isObj(u) && typeof u.contextWindow === 'number' && u.contextWindow > 0 ? [[id, u.contextWindow] as const] : []));
  const byId = (id: string | undefined) => (id ? windows.find(([k]) => k === id)?.[1] : undefined);
  // The model that served the call wins; its id may lack the selected id's suffix (`[1m]`).
  const known = byId(model) ?? (model ? windows.find(([k]) => k.startsWith(model))?.[1] : undefined) ?? byId(selected);
  if (known) return known;
  if (/\[1m\]/i.test(selected ?? '') || /\[1m\]/i.test(model ?? '')) return 1_000_000;
  if (windows.length === 1) return windows[0][1];
  return model || selected ? 200_000 : undefined;
}

/** How long a get_usage read may take; it's best-effort and never holds a turn up. */
const PLAN_USAGE_TIMEOUT_MS = 5_000;
/** At most one get_usage read per this long (it calls the claude.ai usage endpoint). */
const PLAN_USAGE_MIN_INTERVAL_MS = 30_000;

// ── Models ──────────────────────────────────────────────────────────────────

/**
 * How long a get_settings read may take. start() waits on the first one, and
 * the SDK's control requests have no timeout of their own.
 */
export const APPLIED_SETTINGS_TIMEOUT_MS = 5_000;

const isClaudeEffort = (e: string): e is ClaudeEffort => (CLAUDE_EFFORTS as readonly string[]).includes(e);

type ClaudeModelRow = Extract<ClaudeChatEvent, { kind: 'initialized' }>['models'][number];

/**
 * The model menu row for a model id the CLI reports (`claude-opus-5-5[1m]`):
 * an exact match, else the alias row that resolves to it. `default` is only
 * matched by name, so the chip names the model rather than "Default".
 */
export function claudeModelRow(rows: ClaudeModelRow[], model: string | undefined): ClaudeModelRow | undefined {
  if (!model) return undefined;
  const exact = rows.find((r) => r.value === model);
  if (exact) return exact;
  const bare = model.replace(/\[[^\]]*\]$/, '');
  return rows.find((r) => r.value !== 'default' && (r.value === bare || r.resolvedModel === bare));
}

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
  /** The tool call each pending permission is for: requestId → toolCallId. */
  private readonly permissionTools = new Map<string, string>();
  /** AskUserQuestion requests, surfaced as `question`: requestId → tool input. */
  private readonly pendingQuestions = new Map<string, Obj>();
  /** Subagent names from task_started; later task_* messages don't repeat them. */
  private readonly subagentNames = new Map<string, string>();
  /** Tools already reported running (from tool_progress), and tools that finished, so progress never reopens one. */
  private readonly runningTools = new Set<string>();
  private readonly finishedTools = new Set<string>();
  private turn = 0;
  private turnRunning = false;
  private interrupting = false;
  private closing = false;
  private level: PermissionLevel;
  private model: string | undefined;
  private effort: string | undefined;
  /**
   * The effort was chosen (at launch, from the chip or with /effort) rather
   * than left to Claude's default. get_settings reports the level either way,
   * so this is what tells the composer which one it is (#2136).
   */
  private effortPinned: boolean;
  /** effortPinned as last reported, so a change in it alone is reported too. */
  private reportedDefault = false;
  /**
   * What an `/effort <arg>` that opened this turn's message did, applied when
   * the turn ends: a level pins it, `auto` goes back to Claude's default.
   */
  private effortCommandThisTurn: 'pin' | 'default' | undefined;
  /** The model menu from `initialize`. */
  private modelRows: ClaudeModelRow[] = [];
  /** Effort levels last reported for the current model. */
  private efforts: string[] | undefined;
  /** A slash command (/model, /effort, …) ran this turn: re-read the applied settings when it ends. */
  private slashThisTurn = false;
  /** Set once session_started is out; model changes wait for it. */
  private started = false;
  /** The last applied model and effort, held until session_started when they arrive first. */
  private applied: { model?: string; effort?: string } | undefined;
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
  /** The last main-loop call's context fill this turn: input + cache read + cache write. */
  private lastContext: { used: number; model?: string } | undefined;
  /** A compaction-started notice went out and nothing has settled it yet. */
  private compacting = false;
  /** Status per window from rate_limit_event, kept on get_usage's windows (which have none). */
  private limitStatus = new Map<string, UsageLimit['status']>();
  private planUsageAt = 0;
  private planUsageInFlight = false;
  /** False once get_usage said plan limits don't apply, or the CLI doesn't answer it. */
  private planUsageAvailable = true;
  private planUsageFailures = 0;

  constructor(
    readonly driverId: ClaudeChatDriverId,
    private readonly transport: ClaudeTransport,
    private readonly opts: ChatDriverStartOptions,
    private readonly log?: ClaudeTransportLog,
  ) {
    this.level = opts.level;
    this.model = opts.model;
    this.effort = opts.effort;
    this.effortPinned = !!opts.effort;
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
    // Before the first prompt, so the request order on the wire is fixed.
    await this.refreshApplied();
    void this.refreshPlanUsage();
  }

  /** Read every plan window (5-hour, weekly, per-model) from get_usage; best-effort. */
  private async refreshPlanUsage(): Promise<void> {
    if (!this.planUsageAvailable || this.planUsageInFlight || !this.transport.planUsage || this.closing) return;
    if (Date.now() - this.planUsageAt < PLAN_USAGE_MIN_INTERVAL_MS) return;
    this.planUsageInFlight = true;
    this.planUsageAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.transport.planUsage(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`get_usage timed out after ${PLAN_USAGE_TIMEOUT_MS}ms`)), PLAN_USAGE_TIMEOUT_MS);
        }),
      ]);
      this.planUsageFailures = 0;
      const limits = planLimitsFromWire(response);
      if (!limits) {
        if (isObj(response) && response.rate_limits_available === false) this.planUsageAvailable = false;
        return;
      }
      this.push({
        type: 'usage',
        data: { scope: 'session', limits: limits.map((l) => (this.limitStatus.has(l.window) ? { ...l, status: this.limitStatus.get(l.window) } : l)) },
      });
    } catch (err) {
      // telemetry-exempt: optional data; the rate_limit_event windows still arrive.
      // A CLI that doesn't answer get_usage isn't asked again after a few tries.
      if (++this.planUsageFailures >= 3) this.planUsageAvailable = false;
      this.log?.('warn', '[claude-chat] Could not read plan usage', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(timer);
      this.planUsageInFlight = false;
    }
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
    if (/(^|\s)\/(model|effort)\b/.test(text)) this.slashThisTurn = true;
    // Built-ins only run at the start of a message (#2135), and only a known argument changes anything.
    const effortArg = /^\s*\/effort\s+(\S+)/.exec(text)?.[1]?.toLowerCase();
    if (effortArg && isClaudeEffort(effortArg)) this.effortCommandThisTurn = 'pin';
    else if (effortArg === 'auto') this.effortCommandThisTurn = 'default';
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
    const toolCallId = this.permissionTools.get(requestId);
    this.permissionTools.delete(requestId);
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
      if (toolCallId) this.permissionTools.set(requestId, toolCallId);
      throw new Error(`Unknown Claude permission option ${optionId}`);
    }
    // An approved, edited plan replaces the one shown for review, so the
    // transcript matches what Claude was told to implement.
    const tool = toolCallId ? this.tools.get(toolCallId) : undefined;
    if (optionId !== CLAUDE_OPTION_DENY && toolCallId && tool?.name === 'ExitPlanMode' && typeof updatedInput?.plan === 'string') {
      this.push({ type: 'plan_document', data: { planId: toolCallId, markdown: updatedInput.plan, status: 'ready', toolCallId } }, true);
    }
    this.push({
      type: 'permission_resolved',
      data: { requestId, optionId, decision: optionId === CLAUDE_OPTION_DENY ? 'deny' : 'allow', by: 'user' },
    }, true);
    // An approved call runs now; Claude reports nothing more until its result.
    if (optionId !== CLAUDE_OPTION_DENY && toolCallId) this.markRunning(toolCallId);
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

  async setModel(modelId: string, effort?: string | null): Promise<void> {
    if (effort && !isClaudeEffort(effort)) throw new Error(`Claude has no effort level "${effort}"`);
    let modelSet = modelId === this.model;
    let failure: unknown;
    try {
      if (!modelSet) {
        await this.transport.setModel(modelId === 'default' ? undefined : modelId);
        modelSet = true;
      }
      if (effort === null) {
        await this.transport.setEffort(null);
        this.effortPinned = false;
      } else if (effort && (effort !== this.effort || !this.effortPinned)) {
        // The same level as the default still gets sent: it pins it, so a later model switch keeps it.
        await this.transport.setEffort(effort as ClaudeEffort);
        this.effortPinned = true;
      }
    } catch (err) {
      failure = err;
    }
    // The CLI may resolve or cap what was asked for, or have applied only part of it: report what it uses.
    if (!(await this.refreshApplied()) && modelSet) {
      // No get_settings: keep the effort only if the model offers it.
      const levels = claudeModelRow(this.modelRows, modelId)?.efforts ?? [];
      const kept = failure ? this.effort : effort === null ? undefined : effort ?? this.effort;
      this.noteModel(modelId, kept && levels.includes(kept) ? kept : undefined);
    }
    if (failure) throw failure;
  }

  /**
   * Re-read the model and effort the CLI will use and report any change.
   * False when the CLI can't say (an older CLI without get_settings).
   */
  private async refreshApplied(): Promise<boolean> {
    let applied;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      applied = await Promise.race([
        this.transport.appliedSettings(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`get_settings timed out after ${APPLIED_SETTINGS_TIMEOUT_MS}ms`)), APPLIED_SETTINGS_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this.log?.('warn', '[claude-chat] Could not read the applied model and effort', { error: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      clearTimeout(timer);
    }
    if (!applied.model && applied.effort === undefined) return false;
    this.applied = {
      model: applied.model ?? this.applied?.model,
      effort: applied.effort === undefined ? this.applied?.effort ?? this.effort : applied.effort ?? undefined,
    };
    this.noteApplied();
    return true;
  }

  private noteApplied(): void {
    if (!this.started || !this.applied) return;
    const { model, effort } = this.applied;
    const id = model ? this.menuId(model) : this.model;
    if (id) this.noteModel(id, effort);
  }

  /**
   * The menu id for a model id the CLI reports. A variant the menu doesn't
   * list (`claude-opus-5-5[1m]`) gets its own row, `opus[1m]` labelled
   * "Opus 5.5 · 1M", which the CLI also accepts as a model (#2112).
   */
  private menuId(model: string): string {
    const row = claudeModelRow(this.modelRows, model);
    if (!row) return model;
    const variant = /\[([^\]]+)\]$/.exec(model)?.[1];
    if (!variant || row.value.endsWith(`[${variant}]`)) return row.value;
    const id = `${row.value}[${variant}]`;
    if (!this.modelRows.some((r) => r.value === id)) {
      this.modelRows = [...this.modelRows, { ...row, value: id, displayName: `${row.displayName || row.value} · ${variant.toUpperCase()}` }];
      this.pushModels();
    }
    return id;
  }

  private pushModels(): void {
    this.push({
      type: 'session_info',
      data: { models: this.modelRows.map((m) => ({ id: m.value, label: m.displayName || m.value, description: m.description || undefined })) },
    });
  }

  /** Report a model or effort change, and the effort levels the model offers when they differ. */
  private noteModel(model: string, effort: string | undefined): void {
    if (this.closing) return;
    const isDefault = !!effort && !this.effortPinned;
    if (model !== this.model || effort !== this.effort || isDefault !== this.reportedDefault) {
      this.model = model;
      this.effort = effort;
      this.reportedDefault = isDefault;
      this.push({ type: 'model_changed', data: { modelId: model, ...(effort && { effort }), ...(isDefault && { effortIsDefault: true }) } });
    }
    // A model the menu doesn't list has no known levels: don't leave the previous model's on offer.
    const levels = claudeModelRow(this.modelRows, model)?.efforts ?? [];
    if (this.efforts && levels.join() === this.efforts.join()) return;
    this.efforts = levels;
    this.push({ type: 'session_info', data: { efforts: levels } });
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
        if (ev.commands.length) this.pushCommands(ev.commands);
        this.modelRows = ev.models.filter((m) => m.value);
        if (this.modelRows.length) this.pushModels();
        this.started = true;
        this.noteApplied();
        return;
      }
      case 'session_started':
        // system/init only arrives with the first prompt: the native session id and resolved model are known now.
        this.costIsEstimate = ev.apiKeySource === undefined || ev.apiKeySource === 'none';
        this.push({
          type: 'session_info',
          data: {
            nativeSessionId: ev.sessionId || undefined,
            cliVersion: ev.cliVersion || undefined,
            model: ev.model || undefined,
            ...(ev.mcpServers && { mcpServers: ev.mcpServers.map((s) => ({ name: s.name, status: claudeMcpStatus(s.status) })) }),
          },
        });
        // A per-turn init reports the model the turn started with, before any /model in it ran.
        if (ev.model) this.noteModel(this.menuId(ev.model), this.effort);
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
            content: claudeInputDiff(ev.name, ev.input),
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
        this.finishedTools.add(ev.toolCallId);
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
        if (ev.toolCallId) this.permissionTools.set(ev.requestId, ev.toolCallId);
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
        this.permissionTools.delete(ev.requestId);
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
        // Context fill is the last main-loop call's prompt, against that model's window.
        const size = this.lastContext ? claudeContextWindow(this.lastContext.model, ev.modelUsage, this.applied?.model ?? this.model) : undefined;
        const context = this.lastContext && size ? { used: this.lastContext.used, size } : undefined;
        this.push({
          type: 'usage',
          data: { scope: 'turn', tokens: t, costUsd: turnCost, costIsEstimate: turnCost !== undefined ? costIsEstimate : undefined, ...(context && { context }) },
        }, true);
        if (ev.totalCostUsd !== undefined || ev.modelUsage) {
          this.push({ type: 'usage', data: { scope: 'session', tokens: sessionTokens(ev.modelUsage), costUsd: ev.totalCostUsd, costIsEstimate } }, true);
        }
        this.push({ type: 'turn_ended', data: { stopReason, durationMs: ev.durationMs, usage: t, costUsd: turnCost } }, true);
        this.turnRunning = false;
        // turn_ended settles a compaction row; a later status frame starts a new one.
        this.compacting = false;
        this.interrupting = false;
        this.turnApiError = undefined;
        void this.refreshPlanUsage();
        if (this.effortCommandThisTurn) {
          this.effortPinned = this.effortCommandThisTurn === 'pin';
          this.effortCommandThisTurn = undefined;
        }
        if (this.slashThisTurn) {
          this.slashThisTurn = false;
          void this.refreshApplied();
        }
        return;
      }
      case 'assistant_usage': {
        const u = ev.usage;
        this.lastContext = { used: u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, model: ev.model };
        return;
      }
      case 'rate_limit': {
        const window = (ev.rateLimitType && LIMIT_WINDOWS[ev.rateLimitType]) ?? ev.rateLimitType ?? 'limit';
        const status = LIMIT_STATUS[ev.status];
        const limits: UsageLimit[] = [{
          window,
          ...(fraction(ev.utilization) !== undefined && { utilization: fraction(ev.utilization) }),
          ...(status && { status }),
          // The CLI reports resetsAt in epoch seconds; the contract uses epoch ms like ts.
          ...(epochMs(ev.resetsAt) !== undefined && { resetsAt: epochMs(ev.resetsAt) }),
        }];
        // Extra usage rides on the same event as its own window, but only when the
        // account has it: with extra usage off, overageStatus is "rejected" and a
        // disabled reason is given, which isn't a reached limit.
        const overage = ev.overageStatus && !ev.overageDisabledReason ? LIMIT_STATUS[ev.overageStatus] : undefined;
        if (overage && window !== 'overage') {
          limits.push({ window: 'overage', status: overage, ...(epochMs(ev.overageResetsAt) !== undefined && { resetsAt: epochMs(ev.overageResetsAt) }) });
        }
        for (const l of limits) if (l.status) this.limitStatus.set(l.window, l.status);
        this.push({ type: 'usage', data: { scope: 'session', limits } });
        if (ev.status === 'rejected') {
          this.push({ type: 'notice', data: { level: 'warn', code: 'rate_limited', message: 'Plan usage limit reached' } });
        }
        return;
      }
      case 'compaction':
        // Auto compaction or /compact can take a minute or more: say so when it starts.
        if (ev.phase === 'started' && !this.compacting) {
          this.compacting = true;
          this.push({ type: 'notice', data: { level: 'info', code: COMPACTION_STARTED, message: 'Compacting context…' } }, true);
        } else if (ev.phase === 'failed' && this.compacting) {
          this.compacting = false;
          this.push({ type: 'notice', data: { level: 'warn', code: 'compaction_failed', message: ev.error ? `Context compaction failed: ${ev.error}` : 'Context compaction failed' } }, true);
        }
        return;
      case 'compacted':
        // The context the meter showed is gone; the next call reports the new fill.
        this.lastContext = undefined;
        this.compacting = false;
        this.push({ type: 'notice', data: { level: 'info', code: 'compacted', message: 'Context compacted' } }, true);
        return;
      case 'conversation_reset':
        // /clear typed in chat (or a plan-mode exit that clears): the CLI starts over.
        this.lastContext = undefined;
        this.compacting = false;
        this.push({ type: 'notice', data: { level: 'info', code: 'conversation_reset', message: 'Context cleared' } }, true);
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
      case 'tool_progress':
        this.mapToolProgress(ev);
        return;
      case 'background_tasks':
        // Known and expected, so it doesn't count as drift. Subagent status
        // still comes from task_started / task_notification: whether this set
        // lists foreground subagents isn't settled, and reading a missing one
        // as finished would end it early.
        return;
      case 'vcs_changed':
        this.push({ type: 'workspace_changed', data: { reason: 'vcs', vcsKind: ev.vcsKind, ...(ev.branch ? { branch: ev.branch } : {}) } });
        return;
      case 'commands_changed':
        // Skills, plugins or MCP servers changed: the list replaces the one from initialize.
        this.pushCommands(ev.commands);
        return;
      case 'api_retry': {
        // A retry isn't a failure yet: a notice, like a subagent's retry. If retries run out, the turn's error reports it.
        const cause = ev.noResponse ? 'the API did not respond' : ev.errorStatus ? `a ${ev.errorStatus} error` : 'an API error';
        this.push({
          type: 'notice',
          data: { level: 'info', code: 'api_retry', message: `Retrying after ${cause} (attempt ${ev.attempt} of ${ev.maxRetries}).` },
        }, true);
        return;
      }
      case 'notice':
        this.push({ type: 'notice', data: { level: ev.level, code: ev.code, message: ev.message } }, true);
        return;
      case 'unmapped':
        this.push({ type: 'protocol_unknown', data: { driver: this.driverId, kind: 'field', name: ev.subtype ? `${ev.type}/${ev.subtype}` : ev.type } });
        return;
      case 'session_ended':
        this.compacting = false;
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

  private pushCommands(commands: ClaudeCommand[]): void {
    this.push({
      type: 'commands_available',
      data: {
        commands: commands.map((c) => ({
          name: c.name,
          description: c.description,
          inputHint: c.argumentHint || undefined,
          // Claude Code's own commands run only at the start of a message; skills and custom commands the model can use anywhere.
          ...(c.builtin && { startOnly: true }),
        })),
      },
    });
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

  /**
   * A tool that reports progress is running, not waiting for approval: mark
   * it in progress once. A subagent API retry becomes a notice; heartbeats and
   * later ticks add nothing.
   */
  private mapToolProgress(ev: Extract<ClaudeChatEvent, { kind: 'tool_progress' }>): void {
    if (ev.retry) {
      const who = ev.subagentType ?? 'A subagent';
      const cause = ev.retry.errorStatus ? ` after a ${ev.retry.errorStatus} error` : ev.retry.errorCategory ? ` after a ${ev.retry.errorCategory} error` : '';
      this.push({
        type: 'notice',
        data: { level: 'info', code: 'subagent_retry', message: `${who} is retrying its request${cause} (attempt ${ev.retry.attempt} of ${ev.retry.maxRetries}).` },
      }, true);
      return;
    }
    if (ev.toolCallId) this.markRunning(ev.toolCallId);
  }

  /** Mark a known tool call in progress, once, unless it already finished. */
  private markRunning(id: string): void {
    if (!this.tools.has(id) || this.runningTools.has(id) || this.finishedTools.has(id)) return;
    this.runningTools.add(id);
    this.push({ type: 'tool_call_update', data: { toolCallId: id, status: 'in_progress' } }, true);
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
  async probe(binaryPath: string, env?: Record<string, string>, opts?: { commandPrefix?: string }): Promise<ChatDriverProbe> {
    const capabilities = claudeCapabilities('ask');
    const transport = this.createTransport({
      binary: binaryPath,
      cwd: os.homedir(),
      env,
      commandPrefix: opts?.commandPrefix,
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
      return {
        handshakeOk: false, cliVersion, capabilities,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof ClaudeStartupTimeoutError ? { errorCode: err.code } : {}),
      };
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
