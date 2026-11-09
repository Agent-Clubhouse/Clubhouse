/**
 * Clubhouse permission requests waiting on the user (#2970, part of #2921):
 * the store. See shared/grant-requests for the two kinds. Answering is in
 * grant-request-answers.
 *
 * Kept in memory, like helper start requests: gone when the app quits, each
 * expires after GRANT_REQUEST_TTL_MS. An agent has at most
 * MAX_PENDING_GRANT_REQUESTS_PER_AGENT waiting; asking again for the same
 * thing reuses its request.
 *
 * An allowed call request becomes a one-time approval, held until the agent
 * makes that call (same tool, same arguments) or the request would have
 * expired.
 */

import { createHash, randomUUID } from 'crypto';
import { recordGrantRequest as recordRequestEvent } from './grant-telemetry';
import {
  GRANT_REQUEST_TTL_MS, MAX_PENDING_GRANT_REQUESTS_PER_AGENT, type GrantRequest,
} from '../../shared/grant-requests';

export type GrantRequestChange =
  | { kind: 'added'; request: GrantRequest }
  /** `answered`: someone took it to answer (it comes back as `added` if a lasting allow fails to save). `withdrawn`: its agent was deleted. */
  | { kind: 'closed'; requestIds: string[]; reason: 'answered' | 'expired' | 'withdrawn' };

type Listener = (change: GrantRequestChange) => void;

/** A waiting request and what makes two requests the same. */
interface Entry { request: GrantRequest; key: string }

const pending = new Map<string, Entry>();
/** Requests taken for an answer that hasn't finished, by id, with their agent: only these can be put back. */
const answering = new Map<string, string>();
/** One-time approvals of call requests, by call key, with when they lapse. */
const approvals = new Map<string, number>();
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | null = null;

function emit(change: GrantRequestChange): void {
  if (change.kind === 'closed' && change.requestIds.length === 0) return;
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      // telemetry-exempt: one listener failing must not stop the others
    }
  }
}

/** Sorted keys, so the same arguments in another order are the same call. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** What identifies one call: the agent, the tool and its arguments. */
export function callKey(agentId: string, toolName: string, args: Record<string, unknown>): string {
  const hash = createHash('sha256').update(JSON.stringify(stable(args))).digest('hex');
  return `call\0${agentId}\0${toolName}\0${hash}`;
}

function sweep(now: number): void {
  const gone = [...pending.values()].filter((e) => Date.parse(e.request.expiresAt) <= now);
  const expired = gone.map((e) => e.request.requestId);
  for (const id of expired) pending.delete(id);
  for (const e of gone) recordRequestEvent({ agentId: e.request.agentId, kind: e.request.kind, outcome: 'expired', actions: e.request.actions });
  for (const [key, until] of approvals) if (until <= now) approvals.delete(key);
  emit({ kind: 'closed', requestIds: expired, reason: 'expired' });
}

/** One timer for the soonest expiry, so a request leaves Needs you on time. */
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const soonest = Math.min(...[...pending.values()].map((e) => Date.parse(e.request.expiresAt)));
  if (!Number.isFinite(soonest)) return;
  timer = setTimeout(() => { sweep(Date.now()); schedule(); }, Math.max(0, soonest - Date.now()) + 1);
  timer.unref?.();
}

export type RecordGrantRequestResult =
  | { ok: true; request: GrantRequest; reused: boolean }
  | { ok: false; reason: 'too_many'; waiting: number };

/**
 * Record a request. `key` says what makes two the same (callKey for a call);
 * the same request from the same agent reuses the waiting one.
 */
export function recordGrantRequest(
  key: string,
  request: Omit<GrantRequest, 'requestId' | 'createdAt' | 'expiresAt'>,
  now = Date.now(),
): RecordGrantRequestResult {
  sweep(now);
  const mine = [...pending.values()].filter((e) => e.request.agentId === request.agentId);
  const existing = mine.find((e) => e.key === key);
  if (existing) return { ok: true, request: existing.request, reused: true };
  if (mine.length >= MAX_PENDING_GRANT_REQUESTS_PER_AGENT) return { ok: false, reason: 'too_many', waiting: mine.length };
  const full: GrantRequest = {
    ...request,
    requestId: `grant_${randomUUID()}`,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + GRANT_REQUEST_TTL_MS).toISOString(),
  };
  pending.set(full.requestId, { request: full, key });
  schedule();
  emit({ kind: 'added', request: full });
  return { ok: true, request: full, reused: false };
}

/** A waiting request, without using it up; null for an unknown or expired id. */
export function peekGrantRequest(requestId: string, now = Date.now()): GrantRequest | null {
  sweep(now);
  return pending.get(requestId)?.request ?? null;
}

/**
 * Put back a request taken for an answer that then failed, so the user can
 * try again or decline it. Not if it would already have expired, its agent
 * was deleted meanwhile, or the agent asked the same again (that request
 * waits instead). True when it was put back.
 */
export function restoreGrantRequest(request: GrantRequest, key: string, now = Date.now()): boolean {
  const taken = answering.delete(request.requestId);
  if (!taken || Date.parse(request.expiresAt) <= now || pending.has(request.requestId)) return false;
  if ([...pending.values()].some((e) => e.key === key && e.request.agentId === request.agentId)) return false;
  pending.set(request.requestId, { request, key });
  schedule();
  emit({ kind: 'added', request });
  return true;
}

/** An answer to a taken request went through: it can't be put back. */
export function finishGrantAnswer(requestId: string): void {
  answering.delete(requestId);
}

/** The key a waiting request was recorded under; null when it isn't waiting. */
export function grantRequestKey(requestId: string): string | null {
  return pending.get(requestId)?.key ?? null;
}

/**
 * Use up a waiting request. A call request the user allowed becomes a
 * one-time approval for that call, until the request would have expired.
 */
export function takeGrantRequest(requestId: string, allowed: boolean, now = Date.now()): GrantRequest | null {
  sweep(now);
  const entry = pending.get(requestId);
  if (!entry) return null;
  pending.delete(requestId);
  answering.set(requestId, entry.request.agentId);
  if (allowed && entry.request.kind === 'call') approvals.set(entry.key, Date.parse(entry.request.expiresAt));
  schedule();
  emit({ kind: 'closed', requestIds: [requestId], reason: 'answered' });
  return entry.request;
}

/** Use a one-time approval for this call, if the user gave one. */
export function consumeCallApproval(key: string, now = Date.now()): boolean {
  const until = approvals.get(key);
  if (until === undefined) return false;
  approvals.delete(key);
  return until > now;
}

/** Every waiting request, oldest first. */
export function listGrantRequests(now = Date.now()): GrantRequest[] {
  sweep(now);
  return [...pending.values()].map((e) => e.request).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Drop an agent's one-time approvals: its permissions changed since the user gave them. */
export function dropCallApprovalsFor(agentId: string): void {
  for (const key of approvals.keys()) if (key.startsWith(`call\0${agentId}\0`)) approvals.delete(key);
}

/** Drop an agent's waiting requests and approvals (it was deleted). Returns their ids. */
export function dropGrantRequestsFor(agentId: string): string[] {
  const ids = [...pending.values()].filter((e) => e.request.agentId === agentId).map((e) => e.request.requestId);
  for (const id of ids) pending.delete(id);
  // An answer still saving for this agent can't put its request back.
  for (const [id, owner] of answering) if (owner === agentId) answering.delete(id);
  dropCallApprovalsFor(agentId);
  schedule();
  emit({ kind: 'closed', requestIds: ids, reason: 'withdrawn' });
  return ids;
}

/** Subscribe to added and closed requests. Returns the unsubscribe function. */
export function onGrantRequestsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function _resetGrantRequestsForTesting(opts: { keepListeners?: boolean } = {}): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending.clear();
  answering.clear();
  approvals.clear();
  if (!opts.keepListeners) listeners.clear();
}
