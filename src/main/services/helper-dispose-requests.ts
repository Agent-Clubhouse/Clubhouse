/**
 * Dispose requests waiting on the user (#2229, #2232). Under "ask-everything"
 * dispose_helper sends the request to the renderer instead of disposing; this
 * records it, so the user's answer can be reported to that orchestrator once,
 * and only for a request main actually sent. Kept in memory: a request from
 * before a restart has no orchestrator turn left to answer.
 *
 * When the full request is recorded it is also listed for a paired phone
 * (Annex `helperRequests`), which answers it by `requestId`.
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { HelperDisposeChecks, HelperDisposeRequest } from '../../shared/types';

/** A recorded dispose request, as listed for a phone. */
export interface PendingDisposeRequest {
  requestId: string;
  request: HelperDisposeRequest;
  /** ISO time it arrived. */
  createdAt: string;
}

/** What changed: a request was added (or its checks updated), or one closed. */
export type DisposeRequestChange =
  | { kind: 'added'; pending: PendingDisposeRequest }
  | { kind: 'closed'; requestId: string; projectPath: string; helperId: string; replaced?: boolean };

type Listener = (change: DisposeRequestChange) => void;

interface Entry { orchestratorId: string; pending?: PendingDisposeRequest }

const pending = new Map<string, Entry>();
const listeners = new Set<Listener>();

function key(projectPath: string, helperId: string): string {
  return `${path.resolve(projectPath)}\0${helperId}`;
}

function emit(change: DisposeRequestChange): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      // telemetry-exempt: one listener failing must not stop the others
    }
  }
}

/**
 * Note that `orchestratorId` asked the user to decide about disposing
 * `helperId`. A newer request replaces an older one. With `request` it is
 * also listed (listDisposeRequests) under a new request id.
 */
export function recordDisposeRequest(projectPath: string, helperId: string, orchestratorId: string, request?: HelperDisposeRequest, now = Date.now()): void {
  const k = key(projectPath, helperId);
  const previous = pending.get(k)?.pending;
  const entry: Entry = { orchestratorId };
  if (request) entry.pending = { requestId: `hdispose_${randomUUID()}`, request: { ...request, checks: { ...request.checks } }, createdAt: new Date(now).toISOString() };
  pending.set(k, entry);
  // The helper still has a request waiting: only the listed one changed.
  if (previous) emit({ kind: 'closed', requestId: previous.requestId, projectPath, helperId, replaced: true });
  if (entry.pending) emit({ kind: 'added', pending: entry.pending });
}

/**
 * Use up the pending request for this helper from this orchestrator. True
 * once per recorded request; false when there is none, or it was another
 * orchestrator's.
 */
export function takeDisposeRequest(projectPath: string, helperId: string, orchestratorId: string): boolean {
  const k = key(projectPath, helperId);
  const entry = pending.get(k);
  if (entry?.orchestratorId !== orchestratorId) return false;
  pending.delete(k);
  if (entry.pending) emit({ kind: 'closed', requestId: entry.pending.requestId, projectPath, helperId });
  return true;
}

/** Every listed request, oldest first. */
export function listDisposeRequests(): PendingDisposeRequest[] {
  return [...pending.values()]
    .flatMap((e) => (e.pending ? [e.pending] : []))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** A listed request by id, or null. */
export function findDisposeRequest(requestId: string): PendingDisposeRequest | null {
  return listDisposeRequests().find((p) => p.requestId === requestId) ?? null;
}

/**
 * Replace a listed request's checks with newer ones (a refused dispose found
 * more at risk). It gets a new request id, so an answer to the old facts is
 * refused. Returns the new id, or null when the request isn't listed.
 */
export function updateDisposeRequestChecks(requestId: string, checks: HelperDisposeChecks): string | null {
  for (const entry of pending.values()) {
    const old = entry.pending;
    if (old?.requestId !== requestId) continue;
    entry.pending = { requestId: `hdispose_${randomUUID()}`, request: { ...old.request, checks: { ...checks } }, createdAt: old.createdAt };
    emit({ kind: 'closed', requestId, projectPath: old.request.projectPath, helperId: old.request.helperId, replaced: true });
    emit({ kind: 'added', pending: entry.pending });
    return entry.pending.requestId;
  }
  return null;
}

/** Subscribe to added and closed requests. Returns the unsubscribe function. */
export function onDisposeRequestsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function _resetDisposeRequestsForTesting(): void {
  pending.clear();
  listeners.clear();
}
