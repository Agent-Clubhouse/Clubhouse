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
 * Each page is worked out from the transcript alone, so the same event looks the same
 * however often it's read. It doesn't get the note a live update can append: that note
 * is once per call, and history has nothing to count them against.
 */

import type { ChatEvent } from '../../shared/chat';
import {
  boundChatEvent, boundPendingPermissions, incompleteInputWarning, MOBILE_PERSISTENT_APPROVALS,
  PERMISSIONS_TOTAL_MAX_BYTES, previewText, rememberIncomplete,
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

type PermissionRequest = Extract<ChatEvent, { type: 'permission_request' }>;
type Question = Extract<ChatEvent, { type: 'question' }>;

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Every string in a value, within a limit. Only for what has no identity in its text. */
function previewStrings(value: unknown): unknown {
  if (typeof value === 'string') return previewText(value, PAGE_STRING_MAX_BYTES);
  if (Array.isArray(value)) return value.map(previewStrings);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, previewStrings(v)]));
  return value;
}

/** A question's text can be its id, and 147 answers empty without it: never shortened, here or in history. */
const isExact = (event: ChatEvent): boolean => event.type === 'question' || event.type === 'question_resolved';

/** An event as a page shows it. */
function projectEvent(event: ChatEvent): ChatEvent {
  const remote = remoteChatEvent(event);
  if (isExact(remote)) return remote;
  const bytes = bytesOf(remote);
  const bounded = boundChatEvent(remote, bytes, { appendNote: false });
  if (bounded !== remote || bytes <= PAGE_EVENT_MAX_BYTES) return bounded;
  return { ...remote, data: previewStrings(remote.data) } as ChatEvent;
}

/** Just enough to know a request is waiting, and to deny it if a phone can. Approve is refused, and not offered. */
function minimalPermission(event: PermissionRequest): PermissionRequest {
  rememberIncomplete(event.data.requestId);
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
    failure: { error: 'pending_overflow', pendingCount, message: pendingCount === 1 ? 'A pending request is too large to show here. Review it on the desktop.' : `${pendingCount} requests are pending, too many to show here. Review them on the desktop.` },
  };
}

/** The response for one read, or why there can't be one. */
export function buildChatPage({ metadata, eligible, limit, pendingPermissions, pendingQuestions }: ChatPageParts): ChatPage {
  const pendingCount = pendingPermissions.length + pendingQuestions.length;
  let permissions = boundPendingPermissions(pendingPermissions);
  let stage: PendingStage = 'whole';
  if (bytesOf(permissions) > PERMISSIONS_TOTAL_MAX_BYTES) {
    permissions = pendingPermissions.map(minimalPermission);
    stage = 'minimal';
    if (bytesOf(permissions) > PENDING_MINIMAL_MAX_BYTES) return overflow(pendingCount);
  }

  const envelope = { ...metadata, truncated: true, nextBeforeSeq: Number.MAX_SAFE_INTEGER, pendingPermissions: permissions, pendingQuestions, events: [] as string[] };
  let used = bytesOf(envelope);
  if (used > CHAT_PAGE_MAX_BYTES) return overflow(pendingCount);

  // A tail's copy of a pending request says the same as the list, so neither reads as more than the other.
  const sameAsPending = new Map(permissions.map((e) => [e.data.requestId, e]));
  const events: string[] = [];
  let oldestShown: number | null = null;
  let stopped = false;
  for (let i = eligible.length - 1; i >= 0 && events.length < limit; i--) {
    const original = eligible[i];
    const pending = original.type === 'permission_request' ? sameAsPending.get(original.data.requestId) : undefined;
    const json = JSON.stringify(pending ?? projectEvent(original));
    const cost = Buffer.byteLength(json) + 1;
    if (used + cost > CHAT_PAGE_MAX_BYTES) {
      // Too large for any page, and only ever so if it can't be shortened: step past it, so paging moves on.
      if (events.length === 0) oldestShown = original.seq;
      stopped = true;
      break;
    }
    events.unshift(json);
    used += cost;
    oldestShown = original.seq;
  }
  const more = stopped || eligible.length > events.length;
  // Events are already encoded, so this only joins them.
  const head = JSON.stringify({ ...metadata, truncated: more, nextBeforeSeq: more ? oldestShown : null, pendingPermissions: permissions, pendingQuestions });
  const body = `${head.slice(0, -1)},"events":[${events.join(',')}]}`;
  return { ok: true, body, stage };
}
