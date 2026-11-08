/**
 * The whole of a chat event a phone was sent only a preview of (#2731). Over
 * Annex, a large tool call, tool output or permission request is cut to fit a
 * frame (`annex-chat-bounds.ts`). A paired phone can fetch the original from
 * the transcript, on its own pinned mTLS request.
 *
 * Fetching a permission request is what lets that phone approve it. A phone
 * that saw only a preview is refused an approval (`isIncompletePermission`).
 * One that fetched the whole request sends back the digest it got, and the
 * approval is taken when that device fetched exactly the request still pending.
 */

import { createHash } from 'crypto';
import type { ChatEvent } from '../../shared/chat';

/** The largest event a phone can fetch. It's an HTTP response, not a frame, so it isn't held to the socket's 16 MiB. Tunable. */
export const FULL_EVENT_MAX_BYTES = 32 * 1024 * 1024;

/** Stable JSON: key order can't change a digest. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What a phone quotes back to say which version of an event it reviewed. */
export function fullEventDigest(event: ChatEvent): string {
  return `sha256:${createHash('sha256').update(canonical(event)).digest('hex')}`;
}

/** The event with this seq in this session, from a transcript's events. */
export function findFullEvent(events: readonly ChatEvent[], sessionId: string, seq: number): ChatEvent | undefined {
  return events.find((e) => e.sessionId === sessionId && e.seq === seq);
}

type PermissionRequest = Extract<ChatEvent, { type: 'permission_request' }>;

/**
 * Permission requests each paired device fetched whole, by device. Kept in
 * memory only: after a restart a phone fetches again, which fails closed.
 */
const reviewed = new Map<string, { digest: string; epoch: string }>();
const REVIEWED_MAX = 1000;

const reviewKey = (principal: string, event: { agentId: string; sessionId: string; data: { requestId: string } }) =>
  JSON.stringify([principal, event.agentId, event.sessionId, event.data.requestId]);

/** This device was sent the whole of this request, in this pairing epoch. */
export function rememberReviewed(principal: string, epoch: string, event: PermissionRequest): void {
  const key = reviewKey(principal, event);
  reviewed.delete(key);
  reviewed.set(key, { digest: fullEventDigest(event), epoch });
  if (reviewed.size > REVIEWED_MAX) reviewed.delete(reviewed.keys().next().value!);
}

/**
 * Did this device fetch exactly this request, in this epoch, and quote it back?
 * `event` must be the pending request from the transcript, so a request whose
 * content changed since the fetch, or another device's fetch, doesn't count.
 */
export function wasReviewed(principal: string | undefined, epoch: string, event: PermissionRequest, quoted: string | undefined): boolean {
  if (!principal || !quoted) return false;
  const record = reviewed.get(reviewKey(principal, event));
  if (!record || record.epoch !== epoch) return false;
  const digest = fullEventDigest(event);
  return record.digest === digest && quoted === digest;
}

/** For tests: as if this process had just started. */
export function _forgetReviewedForTest(): void {
  reviewed.clear();
}
