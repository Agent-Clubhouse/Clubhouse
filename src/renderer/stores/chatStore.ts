/**
 * Chat store: per-agent view state for the native chat runtime.
 *
 * The main process publishes normalized `ChatEvent`s (src/shared/chat) on the
 * chat event bus and appends them to the agent's transcript. This store folds
 * them into a render-ready `ChatViewState` per agent. The fold is a pure
 * reducer (`reduceChatEvent`) so it can be tested without zustand.
 *
 * Ordering and dedupe follow the contract: events are ordered by `seq`, which
 * is per chat session, and an event whose `seq` is at or below the last one
 * seen for its session is ignored. That makes it safe to fold the transcript
 * and live events that overlap it.
 */

import { create } from 'zustand';
import { MINIMAL_CHAT_CAPABILITIES } from '../../shared/chat';
import type {
  AvailableCommand,
  ChatCapabilities,
  ChatModelOption,
  ChatMcpServer,
  ChatDriverId,
  ChatEvent,
  ChatEventDataMap,
  ChatQuestionAnswers,
  ChatSessionState,
  ContentBlock,
  MessageDelivery,
  MessageSource,
  PermissionLevel,
  PermissionResponseExtras,
  PlanEntry,
  RuntimeSendResult,
  TokenUsage,
  TurnStopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  UsageLimit,
} from '../../shared/chat';

// ── View model ──────────────────────────────────────────────────────────────

interface ChatItemBase {
  /** Stable key for rendering; unique within an agent's item list. */
  id: string;
  sessionId: string;
  turnId?: string;
  /** seq of the event that created the item. */
  seq: number;
  ts: number;
}

export interface UserMessageItem extends ChatItemBase {
  kind: 'user_message';
  messageId: string;
  content: ContentBlock[];
  /** Concatenated text blocks, for display and queue matching. */
  text: string;
  source: MessageSource;
  delivery: MessageDelivery;
}

export interface AgentMessageItem extends ChatItemBase {
  kind: 'agent_message';
  messageId: string;
  text: string;
  /** True while chunks are still arriving (no final agent_message yet). */
  streaming: boolean;
  /** Set when the text comes from a subagent. */
  subagentId?: string;
}

export interface ThoughtItem extends ChatItemBase {
  kind: 'thought';
  messageId: string;
  text: string;
  streaming: boolean;
  durationMs?: number;
  subagentId?: string;
}

export interface ToolCallItem extends ChatItemBase {
  kind: 'tool_call';
  toolCallId: string;
  toolKind: ToolKind;
  title: string;
  status: ToolCallStatus;
  toolName?: string;
  rawInput?: unknown;
  locations?: ToolCallLocation[];
  content: ToolCallContent[];
  subagentId?: string;
  rawOutput?: unknown;
  durationMs?: number;
  error?: string;
}

export interface NoticeItem extends ChatItemBase {
  kind: 'notice';
  level: 'info' | 'warn';
  code: string;
  message: string;
}

export interface ErrorItem extends ChatItemBase {
  kind: 'error';
  code: string;
  message: string;
  fatal: boolean;
  willRetry?: boolean;
  toolCallId?: string;
}

export interface PlanDocumentItem extends ChatItemBase {
  kind: 'plan_document';
  planId: string;
  markdown: string;
  status: 'streaming' | 'ready';
  toolCallId?: string;
}

/** Closes a turn: drives the turn footer (duration, usage) and turn-failure states. */
export interface TurnEndItem extends ChatItemBase {
  kind: 'turn_end';
  stopReason: TurnStopReason;
  durationMs?: number;
  usage?: TokenUsage;
  costUsd?: number;
  costIsEstimate?: boolean;
}

/** Marks the start of a new chat session (e.g. after clearing context). */
export interface SessionDividerItem extends ChatItemBase {
  kind: 'session_divider';
  previousSessionId: string;
  resumed: boolean;
}

export type ChatItem =
  | UserMessageItem
  | AgentMessageItem
  | ThoughtItem
  | ToolCallItem
  | NoticeItem
  | ErrorItem
  | PlanDocumentItem
  | TurnEndItem
  | SessionDividerItem;

export type PendingPermission = ChatEventDataMap['permission_request'] & { turnId?: string; ts: number };
export type PendingQuestion = ChatEventDataMap['question'] & { turnId?: string; ts: number };
export type SubagentInfo = ChatEventDataMap['subagent'];

export interface QueuedMessage {
  messageId: string;
  content: ContentBlock[];
  text: string;
  source: MessageSource;
  sessionId: string;
  seq: number;
  ts: number;
}

export interface UsageSnapshot {
  tokens?: TokenUsage;
  costUsd?: number;
  costIsEstimate?: boolean;
}

export interface ChatUsage {
  /** Latest completed (or reporting) turn. */
  turn: UsageSnapshot | null;
  /** Running session total. */
  session: UsageSnapshot | null;
  /** Plan / rate-limit windows; account-wide, so kept across sessions. */
  limits: UsageLimit[];
  context: { used: number; size: number } | null;
}

export interface ChatViewState {
  agentId: string;
  /** Current Clubhouse chat session id (null before any event). */
  sessionId: string | null;
  state: ChatSessionState | null;
  capabilities: ChatCapabilities | null;
  driver: ChatDriverId | null;
  provider: string | null;
  cliVersion: string | null;
  level: PermissionLevel | null;
  model: string | null;
  effort: string | null;
  /** The effort is the provider's default rather than one chosen in the session (model_changed). */
  effortIsDefault: boolean;
  nativeSessionId: string | null;
  /** Last applied seq, per session id. Used to drop duplicates. */
  lastSeq: Record<string, number>;
  /** Turn in progress, if any. */
  turnId: string | null;
  /** ts of the running turn's turn_started, for the elapsed timer. */
  turnStartedAt: number | null;
  items: ChatItem[];
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
  plan: PlanEntry[];
  subagents: Record<string, SubagentInfo>;
  usage: ChatUsage;
  commands: AvailableCommand[];
  /** Model choices from session_info (empty: no model menu). */
  models: ChatModelOption[];
  /** Effort choices from session_info, in the provider's order. */
  efforts: string[];
  /** The provider's own name for each live level. */
  levelNames: Partial<Record<PermissionLevel, string>>;
  /** MCP servers the CLI reported at session start; null when it doesn't report them. */
  mcpServers: ChatMcpServer[] | null;
  queued: QueuedMessage[];
  /** Native messages the driver didn't recognize (protocol drift), by name. */
  protocolUnknown: Record<string, number>;
  /** Bumped when the agent changes the workspace's git state (commit, push, …): views of its changes re-read. */
  workspaceRevision: number;
  /**
   * "Newer than tested" CLI note. CLIs release faster than chat is retested,
   * so this isn't a transcript item; the view shows it only next to a real
   * problem (unrecognized messages or a fatal error).
   */
  untestedCliNote: string | null;
}

export function createChatViewState(agentId: string): ChatViewState {
  return {
    agentId,
    sessionId: null,
    state: null,
    capabilities: null,
    driver: null,
    provider: null,
    cliVersion: null,
    level: null,
    model: null,
    effort: null,
    effortIsDefault: false,
    nativeSessionId: null,
    lastSeq: {},
    turnId: null,
    turnStartedAt: null,
    items: [],
    pendingPermissions: [],
    pendingQuestions: [],
    plan: [],
    subagents: {},
    usage: { turn: null, session: null, limits: [], context: null },
    commands: [],
    models: [],
    efforts: [],
    levelNames: {},
    mcpServers: null,
    queued: [],
    protocolUnknown: {},
    workspaceRevision: 0,
    untestedCliNote: null,
  };
}

// ── Reducer helpers ─────────────────────────────────────────────────────────

function blocksToText(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function itemBase(event: ChatEvent, id: string): ChatItemBase {
  const base: ChatItemBase = { id, sessionId: event.sessionId, seq: event.seq, ts: event.ts };
  if (event.turnId) base.turnId = event.turnId;
  return base;
}

function findItemIndex(items: ChatItem[], id: string): number {
  // Updates almost always target recent items, so search from the end.
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].id === id) return i;
  }
  return -1;
}

/** Insert `item` or update the existing item with the same id via `update`. */
function upsertItem<T extends ChatItem>(
  items: ChatItem[],
  id: string,
  create: () => T,
  update: (existing: T) => T,
): ChatItem[] {
  const idx = findItemIndex(items, id);
  if (idx === -1) return [...items, create()];
  const next = items.slice();
  next[idx] = update(items[idx] as T);
  return next;
}

/** Fields reset when a new chat session begins. History (`items`) is kept. */
function startSession(state: ChatViewState, event: ChatEvent): ChatViewState {
  const previous = state.sessionId;
  const next: ChatViewState = {
    ...state,
    sessionId: event.sessionId,
    turnId: null,
    turnStartedAt: null,
    pendingPermissions: [],
    pendingQuestions: [],
    plan: [],
    subagents: {},
    queued: [],
    nativeSessionId: null,
    usage: { ...state.usage, turn: null, session: null, context: null },
  };
  if (previous !== null) {
    const divider: SessionDividerItem = {
      ...itemBase(event, `session:${event.sessionId}`),
      kind: 'session_divider',
      previousSessionId: previous,
      resumed: event.type === 'session_started' ? event.data.resumed : false,
    };
    delete divider.turnId;
    next.items = [...state.items, divider];
  }
  return next;
}

function usageSnapshot(data: { tokens?: TokenUsage; usage?: TokenUsage; costUsd?: number; costIsEstimate?: boolean }): UsageSnapshot {
  const snap: UsageSnapshot = {};
  const tokens = data.tokens ?? data.usage;
  if (tokens) snap.tokens = tokens;
  if (data.costUsd !== undefined) snap.costUsd = data.costUsd;
  if (data.costIsEstimate !== undefined) snap.costIsEstimate = data.costIsEstimate;
  return snap;
}

function stopStreaming(items: ChatItem[], turnId: string | undefined): ChatItem[] {
  let changed = false;
  const next = items.map((item) => {
    if ((item.kind === 'agent_message' || item.kind === 'thought') && item.streaming
      && (turnId === undefined || item.turnId === undefined || item.turnId === turnId)) {
      changed = true;
      return { ...item, streaming: false };
    }
    return item;
  });
  return changed ? next : items;
}

function queuedToItem(q: QueuedMessage, event: ChatEvent): UserMessageItem {
  const item: UserMessageItem = {
    id: `user:${q.sessionId}:${q.messageId}`,
    sessionId: q.sessionId,
    seq: q.seq,
    ts: event.ts,
    kind: 'user_message',
    messageId: q.messageId,
    content: q.content,
    text: q.text,
    source: q.source,
    delivery: 'queued',
  };
  if (event.turnId) item.turnId = event.turnId;
  return item;
}

// ── Reducer ─────────────────────────────────────────────────────────────────

/**
 * Fold one chat event into an agent's view state. Pure: returns the same
 * object when the event is ignored (duplicate seq or unknown type).
 */
export function reduceChatEvent(prev: ChatViewState | undefined, event: ChatEvent): ChatViewState {
  const base = prev ?? createChatViewState(event.agentId);
  const last = base.lastSeq[event.sessionId];
  if (last !== undefined && event.seq <= last) return base;

  let state: ChatViewState = { ...base, lastSeq: { ...base.lastSeq, [event.sessionId]: event.seq } };

  // A different session id means a new conversation (clearContext, or a
  // transcript spanning several sessions). Keep history; add a divider.
  if (state.sessionId !== event.sessionId) {
    state = startSession(state, event);
  }

  const sid = event.sessionId;

  switch (event.type) {
    case 'session_started': {
      const d = event.data;
      return {
        ...state,
        driver: d.driver,
        provider: d.provider,
        capabilities: d.capabilities,
        cliVersion: d.cliVersion ?? state.cliVersion,
        nativeSessionId: d.nativeSessionId ?? state.nativeSessionId,
        model: d.model ?? state.model,
        level: d.level ?? state.level,
        // A new session (or another driver) sends its own picker lists in session_info.
        models: [],
        efforts: [],
        levelNames: {},
        mcpServers: null,
        state: 'idle',
      };
    }
    case 'session_info': {
      // Late session metadata (e.g. the native session id once the CLI reports it).
      const d = event.data;
      return {
        ...state,
        nativeSessionId: d.nativeSessionId ?? state.nativeSessionId,
        model: d.model ?? state.model,
        cliVersion: d.cliVersion ?? state.cliVersion,
        // Picker lists: present replaces (empty clears), absent leaves unchanged.
        models: d.models ?? state.models,
        efforts: d.efforts ?? state.efforts,
        levelNames: d.levelNames ?? state.levelNames,
        mcpServers: d.mcpServers ?? state.mcpServers,
        capabilities: d.capabilities
          ? { ...(state.capabilities ?? MINIMAL_CHAT_CAPABILITIES), ...d.capabilities }
          : state.capabilities,
      };
    }
    case 'session_state':
      return { ...state, state: event.data.state };
    case 'session_ended':
      return {
        ...state,
        state: event.data.reason === 'error' ? 'error' : 'sleeping',
        turnId: null,
        turnStartedAt: null,
        items: stopStreaming(state.items, undefined),
      };

    case 'turn_started': {
      // The runtime drains its queue one message per turn, so a new turn
      // delivers the oldest queued message.
      const [delivered, ...rest] = state.queued;
      return {
        ...state,
        turnId: event.turnId ?? null,
        turnStartedAt: event.ts,
        state: 'running',
        // usage.turn describes the running turn from here on.
        usage: { ...state.usage, turn: null },
        queued: delivered ? rest : state.queued,
        items: delivered ? [...state.items, queuedToItem(delivered, event)] : state.items,
      };
    }
    case 'turn_ended': {
      const d = event.data;
      const hasUsage = d.usage !== undefined || d.costUsd !== undefined;
      const durationMs = d.durationMs ?? (state.turnStartedAt !== null ? event.ts - state.turnStartedAt : undefined);
      const end: TurnEndItem = { ...itemBase(event, `turn_end:${sid}:${event.turnId ?? event.seq}`), kind: 'turn_end', stopReason: d.stopReason };
      if (durationMs !== undefined) end.durationMs = durationMs;
      // Drivers may report a turn's usage in a scope 'turn' usage event instead of on turn_ended.
      const turnUsage = state.usage.turn;
      const tokens = d.usage ?? turnUsage?.tokens;
      const costUsd = d.costUsd ?? turnUsage?.costUsd;
      if (tokens !== undefined) end.usage = tokens;
      if (costUsd !== undefined) end.costUsd = costUsd;
      if (turnUsage?.costIsEstimate !== undefined) end.costIsEstimate = turnUsage.costIsEstimate;
      return {
        ...state,
        turnId: null,
        turnStartedAt: null,
        state: d.stopReason === 'error' ? 'error' : 'idle',
        items: [...stopStreaming(state.items, event.turnId), end],
        usage: hasUsage ? { ...state.usage, turn: usageSnapshot(d) } : state.usage,
      };
    }

    case 'user_message': {
      const d = event.data;
      const text = blocksToText(d.content);
      if (d.delivery === 'queued') {
        const q: QueuedMessage = {
          messageId: d.messageId, content: d.content, text, source: d.source,
          sessionId: sid, seq: event.seq, ts: event.ts,
        };
        return { ...state, queued: [...state.queued, q] };
      }
      // A delivered message with the same text (or id) supersedes a queued one.
      const qIdx = state.queued.findIndex((q) => q.messageId === d.messageId || q.text === text);
      const queued = qIdx === -1 ? state.queued : state.queued.filter((_, i) => i !== qIdx);
      const item: UserMessageItem = {
        ...itemBase(event, `user:${sid}:${d.messageId}`),
        kind: 'user_message',
        messageId: d.messageId,
        content: d.content,
        text,
        source: d.source,
        delivery: d.delivery,
      };
      return { ...state, queued, items: [...state.items, item] };
    }

    case 'agent_message_chunk':
    case 'agent_message': {
      const d = event.data;
      const final = event.type === 'agent_message';
      const id = `msg:${sid}:${d.messageId}`;
      const items = upsertItem<AgentMessageItem>(
        state.items,
        id,
        () => ({
          ...itemBase(event, id), kind: 'agent_message', messageId: d.messageId, text: d.text, streaming: !final,
          ...(d.subagentId !== undefined && { subagentId: d.subagentId }),
        }),
        (existing) => ({
          ...existing, text: final ? d.text : existing.text + d.text, streaming: !final,
          ...(d.subagentId !== undefined && { subagentId: d.subagentId }),
        }),
      );
      return { ...state, items };
    }

    case 'agent_thought_chunk':
    case 'agent_thought': {
      const d = event.data;
      const final = event.type === 'agent_thought';
      const durationMs = event.type === 'agent_thought' ? event.data.durationMs : undefined;
      const id = `thought:${sid}:${d.messageId}`;
      const items = upsertItem<ThoughtItem>(
        state.items,
        id,
        () => {
          const item: ThoughtItem = { ...itemBase(event, id), kind: 'thought', messageId: d.messageId, text: d.text, streaming: !final };
          if (durationMs !== undefined) item.durationMs = durationMs;
          if (d.subagentId !== undefined) item.subagentId = d.subagentId;
          return item;
        },
        (existing) => {
          const item: ThoughtItem = { ...existing, text: final ? d.text : existing.text + d.text, streaming: !final };
          if (durationMs !== undefined) item.durationMs = durationMs;
          if (d.subagentId !== undefined) item.subagentId = d.subagentId;
          return item;
        },
      );
      return { ...state, items };
    }

    case 'tool_call': {
      const d = event.data;
      const id = `tool:${sid}:${d.toolCallId}`;
      const fields = {
        toolKind: d.kind,
        title: d.title,
        status: d.status,
        ...(d.toolName !== undefined && { toolName: d.toolName }),
        ...(d.rawInput !== undefined && { rawInput: d.rawInput }),
        ...(d.locations !== undefined && { locations: d.locations }),
        ...(d.subagentId !== undefined && { subagentId: d.subagentId }),
      };
      const items = upsertItem<ToolCallItem>(
        state.items,
        id,
        () => ({ ...itemBase(event, id), kind: 'tool_call', toolCallId: d.toolCallId, content: d.content ?? [], ...fields }),
        (existing) => ({ ...existing, ...fields, content: d.content ?? existing.content }),
      );
      return { ...state, items };
    }
    case 'tool_call_update': {
      const d = event.data;
      const id = `tool:${sid}:${d.toolCallId}`;
      const apply = (existing: ToolCallItem): ToolCallItem => {
        const next: ToolCallItem = { ...existing };
        if (d.status !== undefined) next.status = d.status;
        if (d.title !== undefined) next.title = d.title;
        if (d.content !== undefined) {
          next.content = d.contentMode === 'append' ? [...existing.content, ...d.content] : d.content;
        }
        if (d.rawOutput !== undefined) next.rawOutput = d.rawOutput;
        if (d.durationMs !== undefined) next.durationMs = d.durationMs;
        if (d.error !== undefined) next.error = d.error;
        return next;
      };
      const items = upsertItem<ToolCallItem>(
        state.items,
        id,
        // An update for a call we never saw (e.g. a tail-limited transcript):
        // render a placeholder rather than dropping it.
        () => apply({
          ...itemBase(event, id), kind: 'tool_call', toolCallId: d.toolCallId,
          toolKind: 'other', title: d.title ?? d.toolCallId, status: d.status ?? 'in_progress', content: [],
        }),
        apply,
      );
      return { ...state, items };
    }

    case 'permission_request': {
      const req: PendingPermission = { ...event.data, ts: event.ts };
      if (event.turnId) req.turnId = event.turnId;
      const pendingPermissions = state.pendingPermissions.filter((p) => p.requestId !== req.requestId);
      return { ...state, pendingPermissions: [...pendingPermissions, req] };
    }
    case 'permission_resolved':
      return {
        ...state,
        pendingPermissions: state.pendingPermissions.filter((p) => p.requestId !== event.data.requestId),
      };
    case 'question': {
      const q: PendingQuestion = { ...event.data, ts: event.ts };
      if (event.turnId) q.turnId = event.turnId;
      const pendingQuestions = state.pendingQuestions.filter((p) => p.requestId !== q.requestId);
      return { ...state, pendingQuestions: [...pendingQuestions, q] };
    }
    case 'question_resolved':
      return {
        ...state,
        pendingQuestions: state.pendingQuestions.filter((p) => p.requestId !== event.data.requestId),
      };

    case 'plan':
      return { ...state, plan: event.data.entries };
    case 'plan_document': {
      const d = event.data;
      const id = `plan:${sid}:${d.planId}`;
      const items = upsertItem<PlanDocumentItem>(
        state.items,
        id,
        () => {
          const item: PlanDocumentItem = { ...itemBase(event, id), kind: 'plan_document', planId: d.planId, markdown: d.markdown, status: d.status };
          if (d.toolCallId !== undefined) item.toolCallId = d.toolCallId;
          return item;
        },
        (existing) => ({ ...existing, markdown: d.markdown, status: d.status, ...(d.toolCallId !== undefined && { toolCallId: d.toolCallId }) }),
      );
      return { ...state, items };
    }
    case 'subagent': {
      const d = event.data;
      return { ...state, subagents: { ...state.subagents, [d.subagentId]: { ...state.subagents[d.subagentId], ...d } } };
    }

    case 'usage': {
      const d = event.data;
      const usage: ChatUsage = { ...state.usage };
      if (d.tokens !== undefined || d.costUsd !== undefined) {
        usage[d.scope] = usageSnapshot(d);
      }
      if (d.limits) usage.limits = d.limits;
      if (d.context) usage.context = d.context;
      return { ...state, usage };
    }
    case 'mode_changed':
      return { ...state, level: event.data.level };
    case 'model_changed':
      return { ...state, model: event.data.modelId, effort: event.data.effort ?? null, effortIsDefault: event.data.effortIsDefault === true };
    case 'commands_available':
      return { ...state, commands: event.data.commands };

    case 'notice': {
      const d = event.data;
      if (d.code === 'untested_cli_version') return { ...state, untestedCliNote: d.message };
      const item: NoticeItem = { ...itemBase(event, `notice:${sid}:${event.seq}`), kind: 'notice', level: d.level, code: d.code, message: d.message };
      return { ...state, items: [...state.items, item] };
    }
    case 'error': {
      const d = event.data;
      const item: ErrorItem = { ...itemBase(event, `error:${sid}:${event.seq}`), kind: 'error', code: d.code, message: d.message, fatal: d.fatal };
      if (d.willRetry !== undefined) item.willRetry = d.willRetry;
      if (d.toolCallId !== undefined) item.toolCallId = d.toolCallId;
      return { ...state, items: [...state.items, item] };
    }

    case 'workspace_changed':
      return { ...state, workspaceRevision: state.workspaceRevision + 1 };

    case 'protocol_unknown': {
      // Diagnostics: counted so the view can say the CLI sent something this build doesn't understand.
      const name = `${event.data.kind}:${event.data.name}`;
      return { ...state, protocolUnknown: { ...state.protocolUnknown, [name]: (state.protocolUnknown[name] ?? 0) + 1 } };
    }
    default:
      // An event type newer than this build: track seq, render nothing.
      return state;
  }
}

/** Fold a list of events (e.g. a transcript) into a view state. */
export function foldChatEvents(state: ChatViewState | undefined, agentId: string, events: readonly ChatEvent[]): ChatViewState {
  let next = state ?? createChatViewState(agentId);
  for (const event of events) {
    if (event.agentId !== agentId) continue;
    next = reduceChatEvent(next, event);
  }
  return next;
}

// ── Store ───────────────────────────────────────────────────────────────────

interface ChatStoreState {
  /** View state keyed by agent id. */
  agents: Record<string, ChatViewState>;
  /** Agents whose transcript is being read. */
  loading: Record<string, boolean>;
  /** Agents whose state came from a tail of the transcript; earlier events weren't read. */
  partial: Record<string, boolean>;
  /** Permission or question answers in flight, keyed `${agentId}:${requestId}`, so every view disables the card. */
  answering: Record<string, true>;

  loadTranscript: (agentId: string, tail?: number) => Promise<void>;
  applyEvent: (event: ChatEvent) => void;
  reset: (agentId: string) => void;

  /** `attachmentIds` are staged ids from window.clubhouse.chat.stageAttachment. */
  send: (agentId: string, text: string, delivery?: 'auto' | MessageDelivery, attachmentIds?: string[]) => Promise<RuntimeSendResult>;
  interrupt: (agentId: string) => Promise<void>;
  respondPermission: (agentId: string, requestId: string, optionId: string, extras?: PermissionResponseExtras) => Promise<void>;
  answerQuestion: (agentId: string, requestId: string, answers: ChatQuestionAnswers) => Promise<void>;
  setLevel: (agentId: string, level: PermissionLevel) => Promise<void>;
  setModel: (agentId: string, modelId: string, effort?: string | null) => Promise<void>;
}

/**
 * Live events that arrive while an agent's transcript is loading. They are
 * folded on top of the transcript once it resolves; seq dedupe drops overlap.
 */
const pendingLive = new Map<string, ChatEvent[]>();

function answerKey(agentId: string, requestId: string): string {
  return `${agentId}:${requestId}`;
}

export const useChatStore = create<ChatStoreState>((set, get) => {
  /**
   * Send an answer once: a second click, in this view or another one showing
   * the same agent, while the first is in flight is ignored.
   */
  const answerOnce = async (agentId: string, requestId: string, send: () => Promise<void>): Promise<void> => {
    const key = answerKey(agentId, requestId);
    if (get().answering[key]) return;
    set((s) => ({ answering: { ...s.answering, [key]: true } }));
    try {
      await send();
    } finally {
      set((s) => {
        const answering = { ...s.answering };
        delete answering[key];
        return { answering };
      });
    }
  };

  return {
    agents: {},
    loading: {},
    partial: {},
    answering: {},

    loadTranscript: async (agentId, tail) => {
      pendingLive.set(agentId, []);
      set((s) => ({ loading: { ...s.loading, [agentId]: true } }));
      let events: ChatEvent[] = [];
      try {
        events = (await window.clubhouse.chat.readTranscript(agentId, tail)) ?? [];
      } catch {
        // Treat an unreadable transcript as empty; live events still apply.
      }
      const buffered = pendingLive.get(agentId) ?? [];
      pendingLive.delete(agentId);
      // The transcript is authoritative, so rebuild from it rather than merging
      // into whatever live state existed before the load started.
      const fromTranscript = foldChatEvents(undefined, agentId, events);
      const next = foldChatEvents(fromTranscript, agentId, buffered);
      // A tail that came back full may have cut earlier events off.
      const cut = tail !== undefined && events.length >= tail;
      set((s) => {
        const loading = { ...s.loading };
        delete loading[agentId];
        return { agents: { ...s.agents, [agentId]: next }, loading, partial: { ...s.partial, [agentId]: cut } };
      });
    },

    applyEvent: (event) => {
      const buffer = pendingLive.get(event.agentId);
      if (buffer) {
        buffer.push(event);
        return;
      }
      const prev = get().agents[event.agentId];
      const next = reduceChatEvent(prev, event);
      if (next === prev) return;
      set((s) => ({ agents: { ...s.agents, [event.agentId]: next } }));
    },

    reset: (agentId) => {
      pendingLive.delete(agentId);
      set((s) => {
        const agents = { ...s.agents };
        const loading = { ...s.loading };
        const partial = { ...s.partial };
        delete agents[agentId];
        delete loading[agentId];
        delete partial[agentId];
        return { agents, loading, partial };
      });
    },

    send: (agentId, text, delivery, attachmentIds) => (attachmentIds?.length
      ? window.clubhouse.chat.sendMessage(agentId, text, delivery, attachmentIds)
      : window.clubhouse.chat.sendMessage(agentId, text, delivery)),
    interrupt: (agentId) => window.clubhouse.chat.interrupt(agentId),
    respondPermission: (agentId, requestId, optionId, extras) =>
      answerOnce(agentId, requestId, () => window.clubhouse.chat.respondPermission(agentId, requestId, optionId, extras)),
    answerQuestion: (agentId, requestId, answers) =>
      answerOnce(agentId, requestId, () => window.clubhouse.chat.answerQuestion(agentId, requestId, answers)),
    setLevel: (agentId, level) => window.clubhouse.chat.setLevel(agentId, level),
    setModel: (agentId, modelId, effort) => window.clubhouse.chat.setModel(agentId, modelId, effort),
  };
});

/** True while an answer to this request is in flight from any view. */
export function useAnswering(agentId: string, requestId: string): boolean {
  return useChatStore((s) => !!s.answering[answerKey(agentId, requestId)]);
}

/** Subscribe the store to live chat events from the main process. Returns the unsubscribe. */
export function initChatEventListener(): () => void {
  return window.clubhouse.chat.onEvent((event) => {
    useChatStore.getState().applyEvent(event);
  });
}
