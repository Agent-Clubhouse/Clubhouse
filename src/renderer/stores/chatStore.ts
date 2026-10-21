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

import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { COMPACTION_SETTLED, COMPACTION_STARTED, MINIMAL_CHAT_CAPABILITIES, coalesceUpdateContent } from '../../shared/chat';
import type {
  AvailableCommand,
  ChatCapabilities,
  ChatModelOption,
  ChatMcpServer,
  ChatDriverId,
  ChatEvent,
  ChatEventDataMap,
  ChatImage,
  ChatQuestion,
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
  /** Images the call returned (rich chat content), by media reference or remote link. */
  media?: ChatImage[];
  /** The call only carries its images (a generated image). */
  mediaOnly?: boolean;
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
  /** Still in progress (a context compaction that hasn't finished). */
  running?: boolean;
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
  /** Set when the permission request for this plan's tool call was answered. */
  decision?: 'approved' | 'rejected';
}

/** A question the agent asked, kept in the transcript with its answer once given. */
export interface QuestionItem extends ChatItemBase {
  kind: 'question';
  requestId: string;
  questions: ChatQuestion[];
  /** The tool call the question rides on (e.g. Claude's AskUserQuestion), shown as this row instead. */
  toolCallId?: string;
  answers?: ChatQuestionAnswers;
  cancelled?: boolean;
  /** Never answered: its turn or session ended first (e.g. the app quit while it waited). */
  expired?: boolean;
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

export type ChatItem =
  | UserMessageItem
  | AgentMessageItem
  | ThoughtItem
  | ToolCallItem
  | NoticeItem
  | ErrorItem
  | PlanDocumentItem
  | QuestionItem
  | TurnEndItem;

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
  /** Each message's content when several MCP messages share this item (#2414); `content` is them combined. */
  parts?: ContentBlock[][];
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
  context: { used: number; size: number; window?: 'input' | 'total' } | null;
  /** Every completed turn's tokens summed, for drivers that send no session total (ACP). */
  turnTotal: TokenUsage | null;
}

export interface ChatViewState {
  agentId: string;
  /** Current Clubhouse chat session id (null before any event). */
  sessionId: string | null;
  sessionStartedAt: number | null;
  state: ChatSessionState | null;
  capabilities: ChatCapabilities | null;
  driver: ChatDriverId | null;
  provider: string | null;
  cliVersion: string | null;
  level: PermissionLevel | null;
  model: string | null;
  /**
   * The session said it runs the provider's default but doesn't know which
   * model that is yet (session_info `model: null`, #2293). Shown as "Default
   * model" until model_changed names it.
   */
  modelUnknown: boolean;
  effort: string | null;
  /** The effort is the provider's default rather than one chosen in the session (model_changed). */
  effortIsDefault: boolean;
  /**
   * The session has reported its model and effort (model_changed). Until then
   * `effort` is unknown, not the default, so the effort chip waits.
   */
  effortReported: boolean;
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
  /** Item id of the running "Compacting context…" notice, while a compaction runs. */
  compactionItemId: string | null;
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
    sessionStartedAt: null,
    state: null,
    capabilities: null,
    driver: null,
    provider: null,
    cliVersion: null,
    level: null,
    model: null,
    modelUnknown: false,
    effort: null,
    effortIsDefault: false,
    effortReported: false,
    nativeSessionId: null,
    lastSeq: {},
    turnId: null,
    turnStartedAt: null,
    items: [],
    pendingPermissions: [],
    pendingQuestions: [],
    plan: [],
    subagents: {},
    usage: { turn: null, session: null, limits: [], context: null, turnTotal: null },
    commands: [],
    models: [],
    efforts: [],
    levelNames: {},
    mcpServers: null,
    queued: [],
    protocolUnknown: {},
    workspaceRevision: 0,
    compactionItemId: null,
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

/** A call's images plus new ones; a stored image or link already there isn't added twice. */
function mergeMedia(existing: ChatImage[] | undefined, added: ChatImage[]): ChatImage[] {
  const key = (m: ChatImage) => m.mediaRef ?? m.uri ?? '';
  const seen = new Set((existing ?? []).map(key));
  const fresh = added.filter((m) => { const k = key(m); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  return fresh.length ? [...(existing ?? []), ...fresh] : existing ?? [];
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

/**
 * Settle a running compaction: swap its row for the notice that finished it,
 * or drop the row when the turn or session ended without one.
 */
function settleCompaction(state: ChatViewState, replacement?: NoticeItem): ChatViewState {
  if (state.compactionItemId === null) return state;
  const idx = findItemIndex(state.items, state.compactionItemId);
  const items = state.items.slice();
  if (idx !== -1) {
    // In place, so the result reads where compaction began.
    if (replacement) items[idx] = { ...replacement, id: state.items[idx].id };
    else items.splice(idx, 1);
  } else if (replacement) {
    items.push(replacement);
  }
  return { ...state, items, compactionItemId: null };
}

/** A different session is a different conversation, never an extension of its predecessor. */
function startSession(state: ChatViewState, event: ChatEvent): ChatViewState {
  return {
    ...createChatViewState(event.agentId),
    sessionId: event.sessionId,
    sessionStartedAt: event.ts,
    lastSeq: state.lastSeq,
    usage: { ...createChatViewState(event.agentId).usage, limits: state.usage.limits },
  };
}

/** A usage's total: `input` already includes cache reads and writes (TokenUsage), so they aren't added again. */
export const totalOf = (t: TokenUsage): number => t.total ?? (t.input ?? 0) + (t.output ?? 0);

function addTokens(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  const out: TokenUsage = { ...(a ?? {}) };
  for (const key of ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const) {
    if (b[key] !== undefined) out[key] = (out[key] ?? 0) + b[key];
  }
  // A turn without a total still counts toward it.
  out.total = (a ? totalOf(a) : 0) + totalOf(b);
  return out;
}

function mergeLimits(current: UsageLimit[], next: UsageLimit[]): UsageLimit[] {
  const byWindow = new Map(current.map((l) => [l.window, l]));
  // Field by field: a status-only event keeps the utilization get_usage supplied.
  for (const l of next) byWindow.set(l.window, { ...byWindow.get(l.window), ...l });
  return [...byWindow.values()];
}

function usageSnapshot(data: { tokens?: TokenUsage; usage?: TokenUsage; costUsd?: number; costIsEstimate?: boolean }): UsageSnapshot {
  const snap: UsageSnapshot = {};
  const tokens = data.tokens ?? data.usage;
  if (tokens) snap.tokens = tokens;
  if (data.costUsd !== undefined) snap.costUsd = data.costUsd;
  if (data.costIsEstimate !== undefined) snap.costIsEstimate = data.costIsEstimate;
  return snap;
}

/** An item of turn `itemTurn` ends with turn `ended` (either unknown counts as the same turn). */
function endsWithTurn(itemTurn: string | undefined, ended: string | undefined): boolean {
  return itemTurn === undefined || ended === undefined || itemTurn === ended;
}

/**
 * Mark unanswered questions matching `which` expired: their turn or session
 * is over, so nobody is waiting for the answer any more.
 */
function expireQuestions(items: ChatItem[], which: (q: QuestionItem) => boolean): ChatItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.kind !== 'question' || item.answers || item.cancelled || item.expired || !which(item)) return item;
    changed = true;
    return { ...item, expired: true };
  });
  return changed ? next : items;
}

/**
 * Settle a restored transcript whose session no longer runs (the app quit or
 * crashed mid-turn): open questions expire, nothing is left awaiting an
 * answer, and the session reads as sleeping. A transcript cut off without
 * session_ended otherwise keeps its last state, idle or running, which status
 * surfaces would show over a terminal the agent now runs in (#2208).
 */
export function settleDeadSession(state: ChatViewState): ChatViewState {
  const open = state.pendingQuestions.length > 0 || state.pendingPermissions.length > 0
    || state.items.some((i) => i.kind === 'question' && !i.answers && !i.cancelled && !i.expired);
  const asleep = state.state === 'sleeping' && state.turnId === null && state.turnStartedAt === null;
  if (!open && asleep) return state;
  const settled: ChatViewState = { ...state, state: 'sleeping', turnId: null, turnStartedAt: null };
  return open ? { ...settled, items: expireQuestions(state.items, () => true), pendingQuestions: [], pendingPermissions: [] } : settled;
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

  if (base.sessionId !== null && base.sessionId !== event.sessionId) {
    // A late end/message from a retired session must not replace the live view.
    // A fresh start can reactivate a previously seen session when resuming it.
    const startsSession = event.type === 'session_started' || (last === undefined && event.seq === 1 && event.type !== 'session_ended');
    if (!startsSession || event.ts < (base.sessionStartedAt ?? 0)) return base;
  }

  let state: ChatViewState = { ...base, lastSeq: { ...base.lastSeq, [event.sessionId]: event.seq } };

  // A different session id means a new conversation (clearContext, or a
  // transcript spanning several sessions). Start with an empty view.
  if (state.sessionId !== event.sessionId) {
    state = startSession(state, event);
  }

  const sid = event.sessionId;

  switch (event.type) {
    case 'session_started': {
      const d = event.data;
      return {
        ...state,
        sessionStartedAt: Math.max(state.sessionStartedAt ?? 0, event.ts),
        driver: d.driver,
        provider: d.provider,
        capabilities: d.capabilities,
        cliVersion: d.cliVersion ?? state.cliVersion,
        nativeSessionId: d.nativeSessionId ?? state.nativeSessionId,
        model: d.model ?? state.model,
        // A new run says again whether its model is known.
        modelUnknown: false,
        level: d.level ?? state.level,
        // A new session (or another driver) sends its own picker lists in session_info.
        models: [],
        efforts: [],
        levelNames: {},
        mcpServers: null,
        state: 'idle',
        // A new run: whatever the last one left open (the app quit mid-turn,
        // with no session_ended) is over. Nothing still streams or waits.
        turnId: null,
        turnStartedAt: null,
        items: expireQuestions(stopStreaming(state.items, undefined), () => true),
        pendingPermissions: [],
        pendingQuestions: [],
        // Unrecognized messages are counted per CLI run, not over the whole history.
        protocolUnknown: {},
      };
    }
    case 'session_info': {
      // Late session metadata (e.g. the native session id once the CLI reports it).
      const d = event.data;
      return {
        ...state,
        nativeSessionId: d.nativeSessionId ?? state.nativeSessionId,
        // null: not known yet, so the last run's model doesn't stand in for it.
        model: d.model !== undefined ? d.model : state.model,
        modelUnknown: d.model !== undefined ? d.model === null : state.modelUnknown,
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
      state = settleCompaction(state);
      return {
        ...state,
        state: event.data.reason === 'error' ? 'error' : 'sleeping',
        turnId: null,
        turnStartedAt: null,
        items: expireQuestions(stopStreaming(state.items, undefined), (q) => q.sessionId === sid),
        pendingQuestions: [],
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
      // A compaction the turn didn't see finish (cancelled, failed) is over too.
      state = settleCompaction(state);
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
        // A question still open when its turn ends will never be answered.
        items: [...expireQuestions(stopStreaming(state.items, event.turnId), (q) => q.sessionId === sid && endsWithTurn(q.turnId, event.turnId)), end],
        pendingQuestions: state.pendingQuestions.filter((q) => !endsWithTurn(q.turnId, event.turnId)),
        usage: {
          ...state.usage,
          ...(hasUsage && { turn: usageSnapshot(d) }),
          ...(tokens !== undefined && { turnTotal: addTokens(state.usage.turnTotal, tokens) }),
        },
      };
    }

    case 'user_message': {
      const d = event.data;
      const text = blocksToText(d.content);
      if (d.delivery === 'queued') {
        // An MCP message that joined a queued item updates that row (#2414).
        const joined = d.queuedWith ? state.queued.findIndex((q) => q.messageId === d.queuedWith) : -1;
        if (joined !== -1) {
          const target = state.queued[joined];
          const parts = [...(target.parts ?? [target.content]), d.content];
          const content = coalesceUpdateContent(parts);
          const merged: QueuedMessage = { ...target, parts, content, text: blocksToText(content) };
          return { ...state, queued: state.queued.map((q, i) => (i === joined ? merged : q)) };
        }
        // A join whose item was cut off (a transcript read from its tail)
        // takes the item's id, so later joins and the delivery still find one row.
        const q: QueuedMessage = {
          messageId: d.queuedWith ?? d.messageId, content: d.content, text, source: d.source,
          sessionId: sid, seq: event.seq, ts: event.ts,
        };
        return { ...state, queued: [...state.queued, q] };
      }
      // A delivered message with the same text (or id) supersedes a queued one.
      // By id first, so of two queued messages with the same text the right one goes.
      const byId = state.queued.findIndex((q) => q.messageId === d.messageId);
      const qIdx = byId !== -1 ? byId : state.queued.findIndex((q) => q.text === text);
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

    case 'queue_removed': {
      const removed = new Set(event.data.messageIds);
      const queued = state.queued.filter((q) => !removed.has(q.messageId));
      return queued.length === state.queued.length ? state : { ...state, queued };
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
        ...(d.mediaOnly && { mediaOnly: true }),
      };
      const items = upsertItem<ToolCallItem>(
        state.items,
        id,
        () => ({ ...itemBase(event, id), kind: 'tool_call', toolCallId: d.toolCallId, content: d.content ?? [], ...fields, ...(d.media?.length && { media: d.media }) }),
        (existing) => ({ ...existing, ...fields, content: d.content ?? existing.content, ...(d.media?.length && { media: mergeMedia(existing.media, d.media) }) }),
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
        if (d.media?.length) next.media = mergeMedia(existing.media, d.media);
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
    case 'permission_resolved': {
      const resolved = state.pendingPermissions.find((p) => p.requestId === event.data.requestId);
      const pendingPermissions = state.pendingPermissions.filter((p) => p.requestId !== event.data.requestId);
      // A plan approval (or denial) settles the plan card for that tool call.
      const decision = event.data.decision === 'allow' ? 'approved' : event.data.decision === 'deny' ? 'rejected' : undefined;
      const toolCallId = resolved?.toolCallId;
      if (!decision || !toolCallId) return { ...state, pendingPermissions };
      if (!state.items.some((item) => item.kind === 'plan_document' && item.toolCallId === toolCallId)) {
        return { ...state, pendingPermissions };
      }
      const items = state.items.map((item): ChatItem =>
        item.kind === 'plan_document' && item.toolCallId === toolCallId ? { ...item, decision } : item);
      return { ...state, pendingPermissions, items };
    }
    case 'question': {
      const q: PendingQuestion = { ...event.data, ts: event.ts };
      if (event.turnId) q.turnId = event.turnId;
      const pendingQuestions = state.pendingQuestions.filter((p) => p.requestId !== q.requestId);
      const id = `question:${sid}:${event.data.requestId}`;
      const items = upsertItem<QuestionItem>(
        state.items,
        id,
        () => {
          const item: QuestionItem = { ...itemBase(event, id), kind: 'question', requestId: event.data.requestId, questions: event.data.questions };
          if (event.data.toolCallId !== undefined) item.toolCallId = event.data.toolCallId;
          return item;
        },
        (existing) => ({ ...existing, questions: event.data.questions }),
      );
      return { ...state, items, pendingQuestions: [...pendingQuestions, q] };
    }
    case 'question_resolved': {
      const id = `question:${sid}:${event.data.requestId}`;
      const idx = findItemIndex(state.items, id);
      const pendingQuestions = state.pendingQuestions.filter((p) => p.requestId !== event.data.requestId);
      if (idx === -1) return { ...state, pendingQuestions };
      const items = state.items.slice();
      const answered: QuestionItem = { ...(items[idx] as QuestionItem), answers: event.data.answers };
      if (event.data.cancelled) answered.cancelled = true;
      delete answered.expired;
      items[idx] = answered;
      return { ...state, items, pendingQuestions };
    }

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
      // A driver may report one window at a time (Claude's rate_limit_event): replace by window, keep the rest.
      if (d.limits) usage.limits = mergeLimits(state.usage.limits, d.limits);
      if (d.context) usage.context = d.context;
      return { ...state, usage };
    }
    case 'mode_changed':
      return { ...state, level: event.data.level };
    case 'model_changed':
      return { ...state, model: event.data.modelId, modelUnknown: false, effort: event.data.effort ?? null, effortIsDefault: event.data.effortIsDefault === true, effortReported: true };
    case 'commands_available':
      return { ...state, commands: event.data.commands };

    case 'notice': {
      const d = event.data;
      if (d.code === 'untested_cli_version') return { ...state, untestedCliNote: d.message };
      const item: NoticeItem = { ...itemBase(event, `notice:${sid}:${event.seq}`), kind: 'notice', level: d.level, code: d.code, message: d.message };
      if (d.code === COMPACTION_STARTED) {
        // One running row per compaction, however often the provider repeats it.
        if (state.compactionItemId !== null) return state;
        return { ...state, items: [...state.items, { ...item, running: true }], compactionItemId: item.id };
      }
      if (COMPACTION_SETTLED.includes(d.code) && state.compactionItemId !== null) return settleCompaction(state, item);
      return { ...state, items: [...state.items, item] };
    }
    case 'error': {
      const d = event.data;
      const item: ErrorItem = { ...itemBase(event, `error:${sid}:${event.seq}`), kind: 'error', code: d.code, message: d.message, fatal: d.fatal };
      if (d.willRetry !== undefined) item.willRetry = d.willRetry;
      if (d.toolCallId !== undefined) item.toolCallId = d.toolCallId;
      // A fatal error ends whatever was running, compaction included.
      if (d.fatal) state = settleCompaction(state);
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
  /**
   * Agents whose transcript has been read in this window. Live events alone
   * create an agent's state too (a running agent in a freshly opened window),
   * so having state doesn't mean the history is there (#2150).
   */
  loaded: Record<string, boolean>;
  /** Permission or question answers in flight, keyed `${agentId}:${requestId}`, so every view disables the card. */
  answering: Record<string, true>;
  /**
   * Whether a chat runtime runs the agent now, as far as this window knows:
   * from main (getAgentRuntime) and from live events (any event but
   * session_ended means it runs). Status surfaces overlay chat state only
   * when this is true, so state left from an earlier chat session never
   * overrides an agent now running in the terminal (#2208).
   */
  live: Record<string, boolean>;

  /** Record what main said about whether a chat runtime runs the agent. */
  setRuntimeLive: (agentId: string, live: boolean) => void;

  loadTranscript: (agentId: string, tail?: number) => Promise<void>;
  applyEvent: (event: ChatEvent) => void;
  reset: (agentId: string) => void;

  /** `attachmentIds` are staged ids from window.clubhouse.chat.stageAttachment. */
  send: (agentId: string, text: string, delivery?: 'auto' | MessageDelivery, attachmentIds?: string[]) => Promise<RuntimeSendResult>;
  interrupt: (agentId: string) => Promise<void>;
  /** All queued messages when `messageIds` is omitted. Resolves with the ids main removed. */
  removeQueued: (agentId: string, messageIds?: string[]) => Promise<string[]>;
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

/**
 * Live chat events seen per agent. Not state: nothing renders from it. A
 * caller that asks main which runtime runs the agent compares it before and
 * after, to tell whether chat events arrived while the answer was in flight
 * (an answer from before them is stale, #2218).
 */
const liveEventCounts = new Map<string, number>();

export function chatEventCount(agentId: string): number {
  return liveEventCounts.get(agentId) ?? 0;
}

/** True or false when main says whether a chat runtime runs the agent; undefined when it can't say. */
async function runtimeIsLive(agentId: string): Promise<boolean | undefined> {
  try {
    const info = await window.clubhouse.chat.getAgentRuntime?.(agentId);
    // `chat` alone also covers an agent still starting into chat; `live` is "running now".
    const live = info?.live ?? info?.chat;
    return typeof live === 'boolean' ? live : undefined;
  } catch {
    return undefined;
  }
}

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
    loaded: {},
    answering: {},
    live: {},

    setRuntimeLive: (agentId, live) => {
      if (get().live[agentId] === live) return;
      set((s) => ({ live: { ...s.live, [agentId]: live } }));
    },

    loadTranscript: async (agentId, tail) => {
      if (get().loading[agentId]) return;
      const pending: ChatEvent[] = [];
      pendingLive.set(agentId, pending);
      set((s) => ({ loading: { ...s.loading, [agentId]: true } }));
      let events: ChatEvent[] | null = null;
      // Whether a chat runtime runs this agent now; asked alongside the read.
      const live = runtimeIsLive(agentId);
      try {
        events = (await window.clubhouse.chat.readTranscript(agentId, tail)) ?? [];
      } catch {
        // Unreadable right now: handled below by keeping what this window has.
      }
      const runtimeLive = await live;
      if (pendingLive.get(agentId) !== pending) return; // Reset/replaced while the read was in flight.
      const buffered = pending;
      pendingLive.delete(agentId);
      // Live events that arrived during the read are newer than main's answer.
      if (runtimeLive !== undefined && buffered.length === 0) get().setRuntimeLive(agentId, runtimeLive);
      if (events === null) {
        // Keep the state this window already had, with the live events that
        // arrived meanwhile, and leave it marked not loaded so the next view
        // that mounts tries again (#2150 review).
        set((s) => {
          const loading = { ...s.loading };
          delete loading[agentId];
          return { agents: { ...s.agents, [agentId]: foldChatEvents(s.agents[agentId], agentId, buffered) }, loading };
        });
        return;
      }
      // The transcript is authoritative, so rebuild from it rather than merging
      // into whatever live state existed before the load started. That state
      // came from events main had already written to the transcript (it
      // appends before it broadcasts), so nothing seen live is lost, and seq
      // dedupe drops the buffered events the transcript already holds.
      let fromTranscript = foldChatEvents(undefined, agentId, events);
      // Nothing runs the transcript's session any more (the app quit or
      // crashed mid-turn): what it was waiting on can't be answered.
      if (runtimeLive === false) fromTranscript = settleDeadSession(fromTranscript);
      // A tail that came back full may have cut earlier events off.
      const transcriptCut = tail !== undefined && events.length >= tail;
      // ...including the model_changed that reported the effort: show what's known.
      if (transcriptCut) fromTranscript = { ...fromTranscript, effortReported: true };
      const next = foldChatEvents(fromTranscript, agentId, buffered);
      const changedSession = next.sessionId !== fromTranscript.sessionId;
      const cut = !changedSession && transcriptCut;
      set((s) => {
        const loading = { ...s.loading };
        delete loading[agentId];
        return {
          agents: { ...s.agents, [agentId]: next },
          loading,
          partial: { ...s.partial, [agentId]: cut },
          loaded: { ...s.loaded, [agentId]: true },
        };
      });
      // A resume that arrived during the read needs that session's earlier
      // events too, not just the live session_started buffered above.
      if (changedSession && buffered.some((e) => e.sessionId === next.sessionId && e.type === 'session_started' && e.data.resumed)) {
        await get().loadTranscript(agentId, tail);
      }
    },

    applyEvent: (event) => {
      liveEventCounts.set(event.agentId, chatEventCount(event.agentId) + 1);
      get().setRuntimeLive(event.agentId, event.type !== 'session_ended');
      const buffer = pendingLive.get(event.agentId);
      if (buffer) {
        buffer.push(event);
        return;
      }
      const prev = get().agents[event.agentId];
      const next = reduceChatEvent(prev, event);
      if (next === prev) return;
      const changedSession = prev?.sessionId !== next.sessionId;
      set((s) => ({
        agents: { ...s.agents, [event.agentId]: next },
        ...(changedSession && prev ? {
          partial: { ...s.partial, [event.agentId]: false },
          loaded: { ...s.loaded, [event.agentId]: event.seq === 1 },
        } : {}),
      }));
      if (changedSession && event.type === 'session_started' && event.data.resumed) void get().loadTranscript(event.agentId);
    },

    reset: (agentId) => {
      pendingLive.delete(agentId);
      set((s) => {
        const agents = { ...s.agents };
        const loading = { ...s.loading };
        const partial = { ...s.partial };
        const loaded = { ...s.loaded };
        delete agents[agentId];
        delete loading[agentId];
        delete partial[agentId];
        delete loaded[agentId];
        const live = { ...s.live };
        delete live[agentId];
        return { agents, loading, partial, loaded, live };
      });
    },

    send: (agentId, text, delivery, attachmentIds) => (attachmentIds?.length
      ? window.clubhouse.chat.sendMessage(agentId, text, delivery, attachmentIds)
      : window.clubhouse.chat.sendMessage(agentId, text, delivery)),
    interrupt: (agentId) => window.clubhouse.chat.interrupt(agentId),
    removeQueued: (agentId, messageIds) => (messageIds
      ? window.clubhouse.chat.removeQueued(agentId, messageIds)
      : window.clubhouse.chat.removeQueued(agentId)),
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

/**
 * Each live chat agent's session state and running turn's start, for status
 * surfaces such as the sidebar. Agents no chat runtime runs now are left out
 * (#2208). Re-renders only when one of them changes, not on every streamed chunk.
 */
export function useChatStatuses(): Record<string, { state: ChatSessionState | null; turnStartedAt: number | null }> {
  const states = useChatStore(useShallow((s) => mapAgents(liveAgents(s), (a) => a.state)));
  const turns = useChatStore(useShallow((s) => mapAgents(liveAgents(s), (a) => a.turnStartedAt)));
  return useMemo(() => mapAgents(states, (state, id) => ({ state, turnStartedAt: turns[id] ?? null })), [states, turns]);
}

/** The chat view state of agents a chat runtime runs now (ChatStoreState.live). */
export function liveChatAgent(s: Pick<ChatStoreState, 'agents' | 'live'>, agentId: string): ChatViewState | undefined {
  return s.live[agentId] === true ? s.agents[agentId] : undefined;
}

function liveAgents(s: Pick<ChatStoreState, 'agents' | 'live'>): Record<string, ChatViewState> {
  const out: Record<string, ChatViewState> = {};
  for (const [id, a] of Object.entries(s.agents)) if (s.live[id] === true) out[id] = a;
  return out;
}

function mapAgents<T, U>(record: Record<string, T>, fn: (value: T, id: string) => U): Record<string, U> {
  const out: Record<string, U> = {};
  for (const [id, value] of Object.entries(record)) out[id] = fn(value, id);
  return out;
}

/** Subscribe the store to live chat events from the main process. Returns the unsubscribe. */
export function initChatEventListener(): () => void {
  return window.clubhouse.chat.onEvent((event) => {
    useChatStore.getState().applyEvent(event);
  });
}
