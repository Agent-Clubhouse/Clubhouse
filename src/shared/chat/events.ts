/**
 * Chat event contract: the normalized event model every chat driver emits.
 *
 * Drivers (Claude Agent SDK / stream-json, Codex app-server, Copilot ACP / SDK)
 * translate their native protocol into these events in the main process. The
 * main process stamps the envelope, appends it to the agent's transcript and
 * publishes it on the chat event bus; the renderer, Annex and telemetry are
 * consumers. Event names follow the Agent Client Protocol's `session/update`
 * vocabulary where one exists, so ACP agents map almost one-to-one.
 *
 * Contract rules:
 * - Additive changes only within a major `v`. Consumers must ignore unknown
 *   event types and unknown fields.
 * - `seq` is strictly increasing per chat session, starting at 1, and is the
 *   only ordering consumers should rely on.
 * - Turn-scoped events carry `turnId`; session-scoped events don't. `turnId`
 *   and `sessionId` are Clubhouse's ids. A driver that needs the provider's own
 *   turn id (e.g. Codex `turn/steer` takes `expectedTurnId`) keeps it itself and
 *   may report it as `turn_started.data.nativeTurnId`.
 *
 * See docs/structured-chat-research.md §7 for the design.
 */

import type { ChatCapabilities, ChatDriverId, PermissionLevel } from './capabilities';

/** Contract major version, carried on every envelope. Structured mode's model was v1. */
export const CHAT_CONTRACT_VERSION = 2 as const;

/** Every event type in the contract. Keep in sync with {@link ChatEventDataMap}. */
export const CHAT_EVENT_TYPES = [
  // Session lifecycle
  'session_started',
  'session_info',
  'session_state',
  'session_ended',
  // Turn lifecycle
  'turn_started',
  'turn_ended',
  // Messages
  'user_message',
  'agent_message_chunk',
  'agent_message',
  'agent_thought_chunk',
  'agent_thought',
  // Tools
  'tool_call',
  'tool_call_update',
  // Human in the loop
  'permission_request',
  'permission_resolved',
  'question',
  'question_resolved',
  // Planning and delegation
  'plan',
  'plan_document',
  'subagent',
  // Accounting and configuration
  'usage',
  'mode_changed',
  'model_changed',
  'commands_available',
  // Diagnostics
  'notice',
  'error',
  'protocol_unknown',
] as const;

export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

// ── Shared value types ──────────────────────────────────────────────────────

/** Where a user message came from. Chat renders all of them; telemetry tags them. */
export type MessageSource =
  | 'user'           // typed in the composer
  | 'mission'        // the agent's initial mission
  | 'mcp'            // Clubhouse MCP send_message / send_file from another agent
  | 'shoulder_tap'   // group-project shoulder tap
  | 'group_project'  // group-project inject / polling nudge
  | 'annex'          // a remote Annex client
  | 'system';        // Clubhouse itself (e.g. "continued from terminal" context)

/** How a message reached the agent. */
export type MessageDelivery =
  | 'prompt'  // started a new turn
  | 'steer'   // joined the running turn
  | 'queued'; // held until the running turn ends

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data?: string; path?: string; uri?: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string }
  | { type: 'file'; path: string };

/** ACP tool kinds. Drivers map native tool names onto these for icons and grouping. */
export type ToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute'
  | 'think' | 'fetch' | 'switch_mode' | 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export type ToolCallContent =
  | { type: 'text'; text: string }
  | {
      type: 'diff';
      path: string;
      /** Absent for a new file. */
      oldText?: string;
      /** Absent for a deleted file. */
      newText?: string;
      /** Unified diff when the provider sends one (Codex, Copilot); renderers may prefer it. */
      unifiedDiff?: string;
    }
  | {
      type: 'terminal';
      command?: string;
      cwd?: string;
      output: string;
      exitCode?: number;
    };

/** Normalized permission option kinds. `label` keeps the provider's own wording. */
export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_session'   // Codex acceptForSession
  | 'allow_always'    // persists a rule (Claude localSettings, Codex exec-policy, ACP allow_always)
  | 'reject_once'
  | 'reject_always'
  | 'cancel_turn'     // Codex cancel
  | 'other';

export interface PermissionOption {
  /** Opaque, provider-native id passed back in `AgentRuntime.respondPermission`. */
  optionId: string;
  kind: PermissionOptionKind;
  label: string;
  /** What an "always" option covers when the provider says (e.g. "npm install:*"). */
  scope?: string;
}

export interface TokenUsage {
  input?: number;
  cachedInput?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
  total?: number;
}

export interface UsageLimit {
  /** e.g. '5h', 'week', or a provider-specific window name. */
  window: string;
  /** 0..1, when the provider reports a fraction. */
  utilization?: number;
  /** When the provider reports a status instead of (or as well as) a fraction (Claude rate_limit_event). */
  status?: 'ok' | 'warning' | 'exceeded';
  /** Epoch milliseconds. Drivers convert from the provider's unit (Codex sends seconds). */
  resetsAt?: number;
}

export interface PlanEntry {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'low' | 'medium' | 'high';
}

/** One question in a `question` event. Claude AskUserQuestion sends 1–4; Codex requestUserInput sends an array. */
export interface ChatQuestion {
  id: string;
  prompt: string;
  /** Short label for the question, when the provider sends one. */
  header?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  multiSelect?: boolean;
  allowFreeText: boolean;
}

/** Answers keyed by question id: a single choice or text, or several choices for multiSelect. */
export type ChatQuestionAnswers = Record<string, string | string[]>;

/**
 * Closed set of error codes (also the telemetry `error.type` values for chat).
 * Add a code here rather than inventing free-form strings in drivers.
 */
export type ChatErrorCode =
  | 'max_tokens'
  | 'refusal'
  | 'rpc_timeout'
  | 'process_exited'
  | 'spawn_failed'
  | 'unhandled_server_request'
  | 'protocol_error'
  | 'driver_stream_failed'
  | 'auth_required'
  /** A billing or account problem (account on hold, payment): logging in again won't fix it. */
  | 'account_issue'
  | 'rate_limited'
  | 'context_overflow'
  | 'tool_failed'
  | 'unknown';

/** A model the user can pick, from the provider's live list. */
export interface ChatModelOption {
  id: string;
  label: string;
  description?: string;
  /** The provider's own cost hint, shown as-is (e.g. Copilot's "0.33x" / "1x" multipliers). */
  costHint?: string;
}

/**
 * An MCP server as the CLI reports it at session start (Claude's init
 * `mcp_servers`). `needs_auth` is waiting for a sign-in; `pending` was still
 * connecting when the session started.
 */
export type ChatMcpServerStatus = 'connected' | 'pending' | 'needs_auth' | 'failed' | 'disabled' | 'unknown';

export interface ChatMcpServer {
  name: string;
  status: ChatMcpServerStatus;
}

export interface AvailableCommand {
  name: string;
  description?: string;
  inputHint?: string;
}

// ── Event payloads ──────────────────────────────────────────────────────────

export type ChatSessionState =
  | 'starting'
  | 'idle'                 // alive between turns
  | 'running'              // a turn is in progress
  | 'waiting_permission'
  | 'waiting_input'        // a question is pending
  | 'sleeping'             // process stopped (idle timeout or stop); resumable
  | 'error';

export type TurnStopReason =
  | 'end_turn' | 'cancelled' | 'max_tokens' | 'max_turns' | 'refusal' | 'timeout' | 'error';

export type SessionEndReason =
  | 'stopped'        // user or app stopped the agent
  | 'idle_timeout'   // slept after inactivity; resumable
  | 'process_exit'   // the CLI exited on its own
  | 'fallback'       // runtime dropped to a lower mode (see notice)
  | 'error';

export interface ChatEventDataMap {
  session_started: {
    driver: ChatDriverId;
    /** Orchestrator id, e.g. 'claude-code'. */
    provider: string;
    cwd: string;
    /** True when this session continues an earlier native session. */
    resumed: boolean;
    nativeSessionId?: string;
    cliVersion?: string;
    model?: string;
    level?: PermissionLevel;
    capabilities: ChatCapabilities;
  };
  /**
   * Facts learned after start: e.g. Claude stream-json reports its session id
   * and capabilities in system/init only after the first prompt. Fields present
   * replace the earlier values; `capabilities` is merged into the record from
   * `session_started`.
   */
  session_info: {
    nativeSessionId?: string;
    /** Conversation title from the provider (ACP session_info_update, Codex thread name, Claude summary). */
    title?: string;
    capabilities?: Partial<ChatCapabilities>;
    cliVersion?: string;
    model?: string;
    /**
     * Models the session can switch to (deduped). Replaces any earlier list;
     * an empty array clears it (no model choice), absent leaves it unchanged.
     */
    models?: ChatModelOption[];
    /**
     * Reasoning-effort values the session accepts, in the provider's order
     * (they can change with the model). Replaces any earlier list; an empty
     * array clears it, absent leaves it unchanged.
     */
    efforts?: string[];
    /** The provider's own name for each live level, shown under Clubhouse's level name. */
    levelNames?: Partial<Record<PermissionLevel, string>>;
    /** MCP servers the CLI loaded, with their status. Replaces any earlier list; absent leaves it unchanged. */
    mcpServers?: ChatMcpServer[];
  };
  session_state: { state: ChatSessionState };
  session_ended: { reason: SessionEndReason; exitCode?: number; message?: string };

  turn_started: {
    trigger: MessageDelivery | 'system';
    /** The provider's own turn id, when it has one. */
    nativeTurnId?: string;
  };
  turn_ended: { stopReason: TurnStopReason; durationMs?: number; usage?: TokenUsage; costUsd?: number };

  user_message: {
    messageId: string;
    content: ContentBlock[];
    source: MessageSource;
    delivery: MessageDelivery;
  };
  /** `subagentId` is set when the text comes from a subagent (Claude parent_tool_use_id, Codex child thread). */
  agent_message_chunk: { messageId: string; text: string; subagentId?: string };
  /** Final text of a message; replaces the accumulated chunks. */
  agent_message: { messageId: string; text: string; subagentId?: string };
  agent_thought_chunk: { messageId: string; text: string; subagentId?: string };
  agent_thought: { messageId: string; text: string; durationMs?: number; subagentId?: string };

  tool_call: {
    toolCallId: string;
    kind: ToolKind;
    title: string;
    status: ToolCallStatus;
    /** Native tool name, e.g. 'Bash', 'commandExecution', 'mcp__server__tool'. */
    toolName?: string;
    rawInput?: unknown;
    locations?: ToolCallLocation[];
    content?: ToolCallContent[];
    /** Set when the call belongs to a subagent. */
    subagentId?: string;
  };
  tool_call_update: {
    toolCallId: string;
    status?: ToolCallStatus;
    title?: string;
    content?: ToolCallContent[];
    /** 'append' adds to existing content (streamed output); 'replace' swaps it. Default 'replace'. */
    contentMode?: 'append' | 'replace';
    rawOutput?: unknown;
    durationMs?: number;
    error?: string;
  };

  permission_request: {
    requestId: string;
    title: string;
    description?: string;
    toolCallId?: string;
    toolName?: string;
    rawInput?: unknown;
    options: PermissionOption[];
    subagentId?: string;
  };
  permission_resolved: {
    requestId: string;
    optionId?: string;
    decision: 'allow' | 'deny' | 'cancelled';
    by: 'user' | 'mode' | 'annex' | 'timeout' | 'agent';
  };
  question: {
    requestId: string;
    questions: ChatQuestion[];
    toolCallId?: string;
    subagentId?: string;
  };
  question_resolved: { requestId: string; answers: ChatQuestionAnswers; cancelled?: boolean };

  /** The current task list; each event replaces the previous one. */
  plan: { entries: PlanEntry[] };
  /** A plan written as a document (Claude ExitPlanMode, Codex plan item). Approval rides on permission_request. */
  plan_document: { planId: string; markdown: string; status: 'streaming' | 'ready'; toolCallId?: string };
  subagent: {
    subagentId: string;
    name: string;
    description?: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    parentToolCallId?: string;
    nativeSessionId?: string;
    toolCount?: number;
    usage?: TokenUsage;
  };

  usage: {
    scope: 'turn' | 'session';
    tokens?: TokenUsage;
    costUsd?: number;
    /** True when the cost is an API-price estimate (e.g. Claude on a subscription). */
    costIsEstimate?: boolean;
    context?: { used: number; size: number };
    limits?: UsageLimit[];
  };
  mode_changed: { level: PermissionLevel; nativeMode?: string };
  model_changed: { modelId: string; effort?: string };
  commands_available: { commands: AvailableCommand[] };

  notice: {
    level: 'info' | 'warn';
    /** Stable code for UI and telemetry, e.g. 'continued_from_terminal', 'untested_cli_version', 'fallback'. */
    code: string;
    message: string;
  };
  error: { code: ChatErrorCode; message: string; fatal: boolean; willRetry?: boolean; toolCallId?: string };
  /**
   * Something native the driver didn't recognize: an unknown request or
   * notification method, or an unknown field / item / event type (`field`).
   * Feeds the c.chat.protocol.unknown signal; `name` is the method or type.
   */
  protocol_unknown: { driver: ChatDriverId; kind: 'request' | 'notification' | 'field'; name: string };
}

type AssertTrue<T extends true> = T;
/** Compile-time check that CHAT_EVENT_TYPES and ChatEventDataMap list the same event types. */
export type ChatEventTypesInSync = AssertTrue<
  [Exclude<keyof ChatEventDataMap, ChatEventType>, Exclude<ChatEventType, keyof ChatEventDataMap>] extends [never, never] ? true : false
>;

// ── Envelope ────────────────────────────────────────────────────────────────

interface ChatEnvelopeBase<T extends ChatEventType> {
  v: typeof CHAT_CONTRACT_VERSION;
  agentId: string;
  /** Clubhouse's chat session id. Stable across process restarts that resume the same conversation. */
  sessionId: string;
  /** Set on turn-scoped events. */
  turnId?: string;
  /** Strictly increasing per session, from 1. */
  seq: number;
  /** Epoch milliseconds, stamped by the main process. */
  ts: number;
  type: T;
  data: ChatEventDataMap[T];
}

export type ChatEventOf<T extends ChatEventType> = ChatEnvelopeBase<T>;

/** Discriminated union of every chat event. Narrow on `type`. */
export type ChatEvent = { [T in ChatEventType]: ChatEnvelopeBase<T> }[ChatEventType];

/** What a driver produces before the main process stamps the envelope. */
export type ChatEventDraft = {
  [T in ChatEventType]: { type: T; data: ChatEventDataMap[T]; turnId?: string };
}[ChatEventType];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(CHAT_EVENT_TYPES);

/** Runtime check for envelopes crossing a process or file boundary. Unknown types return false. */
export function isChatEvent(value: unknown): value is ChatEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return e.v === CHAT_CONTRACT_VERSION
    && typeof e.agentId === 'string'
    && typeof e.sessionId === 'string'
    && typeof e.seq === 'number'
    && typeof e.ts === 'number'
    && typeof e.type === 'string'
    && EVENT_TYPE_SET.has(e.type)
    && typeof e.data === 'object' && e.data !== null;
}
