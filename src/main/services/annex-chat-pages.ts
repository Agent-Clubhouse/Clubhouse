/**
 * One `GET …/chat` response, within what a phone can take (#2673). The whole page is
 * bounded on encoded bytes, not on an event count: over 16 MiB, real TLS rejects it and
 * a retry of the same page fails the same way.
 *
 * What's pending comes first and is all or nothing. Clubhouse Go measured build 147: a
 * partial list removes live cards as if they'd been answered, and missing question text
 * makes it drop the prompt and enable an empty answer. So permissions shrink, but all of
 * them stay, and a question is never shortened. When those can't fit, the answer is a
 * 503: a phone keeps what it has and goes read-only until a refresh works.
 *
 * Queued rows come next, wherever they are in the history: `queuedMessageIds` names them,
 * and a queue state with no row reads as nothing waiting.
 *
 * Every event a page passes is accounted for, and never a gap nothing marks. It's itself,
 * or a preview, or at the last, for what changes state, a compact form of the same type.
 * A phone folds those to work out what's still open: a notice in place of a
 * `question_resolved` brings an answered card back. Only what carries no state can be a
 * stub saying it's left out. Anything else that can't fit makes the page a 503. Each page is worked out from the transcript
 * and what's pending, so the same event looks the same however often it's read while
 * those stay the same. It doesn't get the note a live update can append: that note is
 * once per call, and history has nothing to count them against.
 */

import type { ChatEvent } from '../../shared/chat';
import {
  boundChatEvent, boundPendingPermissions, incompleteInputWarning, MOBILE_PERSISTENT_APPROVALS,
  PERMISSIONS_TOTAL_MAX_BYTES, previewText, rememberIncomplete, toolPreviewNote,
} from './annex-chat-bounds';
import { remoteChatEvent } from './annex-chat-echo';

/** The most one response can be, as encoded. */
export const CHAT_PAGE_MAX_BYTES = 8 * 1024 * 1024;
/** An event over this in a page gets a preview. */
const PAGE_EVENT_MAX_BYTES = 1024 * 1024;
const PAGE_STRING_MAX_BYTES = 256 * 1024;
/** What minimal pending rows can take before the answer has to be a 503. The rest is for questions, events and metadata. */
export const PENDING_MINIMAL_MAX_BYTES = 4 * 1024 * 1024;
const MINIMAL_TEXT_MAX_BYTES = 256;
/** Kept free on every page, so what's first on it can always at least be marked. */
const STUB_ROOM_BYTES = 4 * 1024;
/** The least a queued row is shown in. Less than this, or with what identifies it not fitting, and the answer is a 503. */
const QUEUED_ROW_MIN_BYTES = 16 * 1024;
const QUEUED_TEXT_MIN_BYTES = 256;

type PermissionRequest = Extract<ChatEvent, { type: 'permission_request' }>;
type Question = Extract<ChatEvent, { type: 'question' }>;

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Every string in a value, within a limit. Only for what has no identity in its text. */
function previewStrings(value: unknown, maxBytes = PAGE_STRING_MAX_BYTES): unknown {
  if (typeof value === 'string') return previewText(value, maxBytes);
  if (Array.isArray(value)) return value.map((item) => previewStrings(item, maxBytes));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, previewStrings(v, maxBytes)]));
  return value;
}

function countLongStrings(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value) > QUEUED_TEXT_MIN_BYTES ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + countLongStrings(item), 0);
  if (value && typeof value === 'object') return countLongStrings(Object.values(value));
  return 0;
}

type UserMessage = Extract<ChatEvent, { type: 'user_message' }>;

/**
 * A user message within `maxBytes`, or null if it can't be. Only its text is shortened.
 * Its ids, source and delivery stay, and so does every block and part, so they stay in
 * step. A queued row only ever has this form: `queuedMessageIds` names it.
 */
function userMessageWithin(event: UserMessage, maxBytes: number): UserMessage | null {
  const remote = remoteChatEvent(event) as UserMessage;
  const originalBytes = bytesOf(remote);
  if (originalBytes <= maxBytes) return remote;
  const { content, routed } = remote.data;
  let cap = Math.floor(maxBytes / Math.max(1, countLongStrings({ content, routed })));
  for (; cap >= QUEUED_TEXT_MIN_BYTES; cap = Math.floor(cap / 2)) {
    const shortened = {
      ...remote,
      data: {
        ...remote.data,
        content: previewStrings(content, cap),
        ...(routed && { routed: previewStrings(routed, cap) }),
        truncated: { originalBytes },
      },
    } as UserMessage;
    if (bytesOf(shortened) <= maxBytes) return shortened;
  }
  return null;
}

/** A question's text can be its id, and 147 answers empty without it: never shortened, here or in history. */
const isExact = (event: ChatEvent): boolean => event.type === 'question' || event.type === 'question_resolved';

/**
 * What can be a generic stub. An allowlist, so a new event type isn't one until someone
 * decides it carries no state. A question or request in history is here because a card
 * that's gone can't reopen: one still pending is in the lists, and never gets this far.
 */
const STUBBABLE_TYPES: ReadonlySet<ChatEvent['type']> = new Set<ChatEvent['type']>([
  'agent_message', 'agent_message_chunk', 'agent_thought', 'agent_thought_chunk', 'notice', 'usage', 'question', 'permission_request',
]);

const shortText = (text: string) => previewText(text, MINIMAL_TEXT_MAX_BYTES);

/**
 * An event at its smallest: the same type with what a phone folds on, where it changes
 * state, or a stub saying it's left out, where it doesn't. Null if it has neither form.
 * Types made only of ids, such as `queue_state`, have nothing to give up, so they're null.
 */
function smallestForm(event: ChatEvent, originalBytes: number): ChatEvent | null {
  const truncated = { originalBytes };
  if (event.type === 'question_resolved') {
    const { requestId, cancelled } = event.data;
    return { ...event, data: { requestId, answers: {}, ...(cancelled !== undefined && { cancelled }), truncated } as typeof event.data };
  }
  if (event.type === 'permission_resolved') {
    const { requestId, decision, by, optionId } = event.data;
    return { ...event, data: { requestId, decision, by, ...(optionId && Buffer.byteLength(optionId) <= MINIMAL_TEXT_MAX_BYTES && { optionId }), truncated } as typeof event.data };
  }
  if (event.type === 'user_message') {
    const { messageId, clientCommandId, source, delivery, queuedWith, routed, content } = event.data;
    const firstText = content.find((block) => block.type === 'text');
    return { ...event, data: {
      messageId, source, delivery,
      ...(clientCommandId && { clientCommandId }),
      ...(queuedWith && { queuedWith }),
      content: [{ type: 'text', text: firstText?.type === 'text' ? shortText(firstText.text) : '' }],
      ...(routed?.length && { routed: previewStrings(routed.slice(0, 1), MINIMAL_TEXT_MAX_BYTES) }),
      truncated,
    } as typeof event.data };
  }
  // A tool call keeps its ids, status and exit code, so it doesn't look unfinished.
  if (event.type === 'tool_call') {
    const { toolCallId, kind, title, status, toolName, subagentId } = event.data;
    return { ...event, data: { toolCallId, kind, title: shortText(title), status, ...(toolName && { toolName: shortText(toolName) }), ...(subagentId && { subagentId }), content: [toolPreviewNote()], truncated } as typeof event.data };
  }
  if (event.type === 'tool_call_update') {
    const { toolCallId, status, title, durationMs, error, content } = event.data;
    const exitCode = content?.map((block) => (block.type === 'terminal' ? block.exitCode : undefined)).find((code) => code !== undefined);
    return { ...event, data: {
      toolCallId,
      ...(status && { status }),
      ...(title && { title: shortText(title) }),
      ...(durationMs !== undefined && { durationMs }),
      ...(error && { error: shortText(error) }),
      content: [toolPreviewNote(), ...(exitCode !== undefined ? [{ type: 'terminal' as const, output: '', exitCode }] : [])],
      contentMode: 'replace',
      truncated,
    } as typeof event.data };
  }
  if (!STUBBABLE_TYPES.has(event.type)) return null;
  const message = event.type === 'question' ? 'A question here is too large to show. It\'s on the desktop.' : 'Something here is too large to show. It\'s on the desktop.';
  const { requestId, messageId, toolCallId } = event.data as { requestId?: string; messageId?: string; toolCallId?: string };
  const ids = Object.fromEntries(Object.entries({ requestId, messageId, toolCallId }).filter(([, id]) => id && Buffer.byteLength(id) <= MINIMAL_TEXT_MAX_BYTES));
  return { ...event, type: 'notice', data: { level: 'info', code: 'event_omitted', message, omitted: { type: event.type, originalBytes, ...ids } } } as ChatEvent;
}

/** An event as a page shows it. */
function projectEvent(event: ChatEvent): ChatEvent {
  const remote = remoteChatEvent(event);
  if (isExact(remote)) return remote;
  const bytes = bytesOf(remote);
  if (bytes <= PAGE_EVENT_MAX_BYTES && event.type !== 'permission_request') return remote;
  if (remote.type === 'user_message') return userMessageWithin(remote, PAGE_EVENT_MAX_BYTES) ?? smallestForm(remote, bytes)!;
  const bounded = boundChatEvent(remote, bytes, { appendNote: false });
  if (bytesOf(bounded) <= PAGE_EVENT_MAX_BYTES) return bounded;
  // A cap on each string isn't one on the total, and some fields have no preview of their own.
  const previewed = { ...bounded, data: previewStrings(bounded.data) } as ChatEvent;
  // With no smaller form it stays as it is: too large for what's left, it makes the page a 503.
  return bytesOf(previewed) <= PAGE_EVENT_MAX_BYTES ? previewed : smallestForm(remote, bytes) ?? previewed;
}

/** Just enough to know a request is waiting, and to deny it if a phone can. Approve is refused, and not offered. */
function minimalPermission(event: PermissionRequest): PermissionRequest {
  const options = event.data.options
    .filter((o) => o.kind === 'reject_once' || o.kind === 'cancel_turn' || (o.kind === 'reject_always' && MOBILE_PERSISTENT_APPROVALS))
    .map((o) => ({ ...o, label: previewText(o.label, MINIMAL_TEXT_MAX_BYTES) }));
  const title = previewText(event.data.title, MINIMAL_TEXT_MAX_BYTES);
  return {
    ...event,
    data: {
      requestId: event.data.requestId,
      title,
      description: `${incompleteInputWarning(options)} ${title}`,
      ...(event.data.toolCallId && { toolCallId: event.data.toolCallId }),
      ...(event.data.toolName && { toolName: event.data.toolName }),
      options,
      truncated: { originalBytes: bytesOf(event.data) },
    } as PermissionRequest['data'],
  };
}

export type ChatPageFailure = { error: 'pending_overflow'; pendingCount: number; message: string };
export type PendingStage = 'whole' | 'minimal' | 'error';

export interface ChatPageParts {
  /** Everything but `events`, `pendingPermissions`, `pendingQuestions`, `truncated` and `nextBeforeSeq`. */
  metadata: Record<string, unknown>;
  /** Oldest first, up to this page's start. */
  eligible: ChatEvent[];
  limit: number;
  pendingPermissions: PermissionRequest[];
  pendingQuestions: Question[];
}

export type ChatPage =
  | { ok: true; body: string; stage: PendingStage }
  | { ok: false; failure: ChatPageFailure; stage: 'error' };

function overflow(pendingCount: number): ChatPage {
  return {
    ok: false,
    stage: 'error',
    failure: {
      error: 'pending_overflow',
      pendingCount,
      message: pendingCount === 0 ? 'This chat has something too large to show here. Review it on the desktop.'
        : pendingCount === 1 ? 'A pending request is too large to show here. Review it on the desktop.'
          : `${pendingCount} requests are pending, too many to show here. Review them on the desktop.`,
    },
  };
}

const isQueuedRow = (event: ChatEvent, queue: ReadonlySet<string>): event is UserMessage => (
  event.type === 'user_message' && event.data.delivery === 'queued' && queue.has(event.data.queuedWith ?? event.data.messageId)
);
const costOf = (encoded: readonly string[]): number => encoded.reduce((sum, json) => sum + Buffer.byteLength(json) + 1, 0);

/** The response for one read, or why there can't be one. */
export function buildChatPage({ metadata, eligible, limit, pendingPermissions, pendingQuestions }: ChatPageParts): ChatPage {
  const queue = new Set(metadata.queuedMessageIds as string[] | undefined);
  const queuedRows = eligible.filter((event): event is UserMessage => isQueuedRow(event, queue));
  const pendingCount = pendingPermissions.length + pendingQuestions.length + queuedRows.length;
  const envelopeBytes = (permissions: PermissionRequest[]) => bytesOf({ ...metadata, truncated: true, nextBeforeSeq: Number.MAX_SAFE_INTEGER, pendingPermissions: permissions, pendingQuestions, events: [] });
  const encodeRows = (maxBytes: number) => queuedRows.map((event) => userMessageWithin(event, maxBytes)).map((row) => (row ? JSON.stringify(row) : null));
  // At their smallest here. They get whatever room is left afterwards.
  const queuedSmallest = encodeRows(QUEUED_ROW_MIN_BYTES);
  if (queuedSmallest.includes(null)) return overflow(pendingCount);
  const fits = (permissions: PermissionRequest[]) => envelopeBytes(permissions) + costOf(queuedSmallest as string[]) + STUB_ROOM_BYTES <= CHAT_PAGE_MAX_BYTES;

  let permissions = boundPendingPermissions(pendingPermissions, { record: false });
  let stage: PendingStage = 'whole';
  // Past the total, or crowding out what else has to fit: try small rows before giving up.
  if (bytesOf(permissions) > PERMISSIONS_TOTAL_MAX_BYTES || (permissions.length > 0 && !fits(permissions))) {
    permissions = pendingPermissions.map(minimalPermission);
    stage = 'minimal';
    if (bytesOf(permissions) > PENDING_MINIMAL_MAX_BYTES) return overflow(pendingCount);
  }
  if (!fits(permissions)) return overflow(pendingCount);

  let used = envelopeBytes(permissions);
  const queuedWhole = queuedRows.map((event) => JSON.stringify(remoteChatEvent(event)));
  const room = CHAT_PAGE_MAX_BYTES - used - STUB_ROOM_BYTES;
  const share = Math.min(PAGE_EVENT_MAX_BYTES, Math.floor((room - queuedRows.length) / Math.max(1, queuedRows.length)));
  const queuedEncoded = costOf(queuedWhole) <= room ? queuedWhole
    : (share > QUEUED_ROW_MIN_BYTES ? encodeRows(share) : queuedSmallest).map((row, i) => row ?? (queuedSmallest[i] as string));
  used += costOf(queuedEncoded);
  const queuedBySeq = new Map(queuedRows.map((event, i) => [event.seq, queuedEncoded[i]]));

  // A tail's copy of a pending request says the same as the list, so neither reads as more than the other.
  // Only that request's own copy: providers can reuse a request id.
  const sameAsPending = new Map(permissions.map((e) => [e.data.requestId, e]));
  const activeQuestions = new Set(pendingQuestions.map((e) => e.seq));
  const events: string[] = [];
  let oldestShown: number | null = null;
  let walked = 0;
  // What this walk has taken of the room. With none taken, the next page would have no more.
  let added = 0;
  let stopped = false;
  for (let i = eligible.length - 1; i >= 0 && walked < limit; i--) {
    const original = eligible[i];
    const queuedRow = queuedBySeq.get(original.seq);
    if (queuedRow !== undefined) {
      queuedBySeq.delete(original.seq);
      events.unshift(queuedRow);
      oldestShown = original.seq;
      walked++;
      continue;
    }
    const candidate = original.type === 'permission_request' ? sameAsPending.get(original.data.requestId) : undefined;
    const pending = candidate?.seq === original.seq ? candidate : undefined;
    const projected = pending ?? projectEvent(original);
    let json = JSON.stringify(projected);
    if (used + Buffer.byteLength(json) + 1 > CHAT_PAGE_MAX_BYTES) {
      // The next page has more room, unless nothing has taken any yet. Then what's pending is taking
      // it on every page, so paging would never get past this. A request or question still pending
      // is in the list, so leaving out its copy loses nothing. Anything else goes at its smallest.
      if (added > 0) {
        stopped = true;
        break;
      }
      if (pending || (original.type === 'question' && activeQuestions.has(original.seq))) {
        oldestShown = original.seq;
        walked++;
        continue;
      }
      const remote = remoteChatEvent(original);
      const smallest = smallestForm(remote, bytesOf(remote));
      if (!smallest) return overflow(pendingCount);
      json = JSON.stringify(smallest);
      if (used + Buffer.byteLength(json) + 1 > CHAT_PAGE_MAX_BYTES) return overflow(pendingCount);
    }
    events.unshift(json);
    used += Buffer.byteLength(json) + 1;
    oldestShown = original.seq;
    walked++;
    added++;
  }
  const more = stopped || walked < eligible.length;
  // Rows older than this page, in front. The next page's cursor doesn't count them.
  const olderQueued = [...queuedBySeq.entries()].sort(([a], [b]) => a - b).map(([, json]) => json);
  // Events are already encoded, so this only joins them.
  const head = JSON.stringify({ ...metadata, truncated: more, nextBeforeSeq: more ? oldestShown : null, pendingPermissions: permissions, pendingQuestions });
  const body = `${head.slice(0, -1)},"events":[${[...olderQueued, ...events].join(',')}]}`;
  // Only now that it's being sent: a request never shown isn't one whose approve is refused.
  for (const event of permissions) {
    if ('truncated' in event.data) rememberIncomplete(event);
  }
  return { ok: true, body, stage };
}
