/**
 * Helper starts waiting on the user (#2234). Under the control levels
 * "ask-before-start" and "ask-everything", start_helper records the start
 * here instead of creating anything. The user approves or declines it from
 * Needs you or the orchestrator's Helpers card; each request is used up
 * once, and only for the project main recorded it in.
 *
 * Kept in memory: requests are gone when the app quits, and each expires
 * after START_REQUEST_TTL_MS. An orchestrator has at most
 * MAX_PENDING_STARTS_PER_ORCHESTRATOR waiting at once, and asking again for
 * the same start reuses the waiting request.
 */

import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import type { HelperStartArgs, HelperStartRequest } from '../../shared/types';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import { redactChangeText } from './read-only-display-text';
import { display } from './remote-details-presentation';

export const START_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_STARTS_PER_ORCHESTRATOR = 3;

/** What changed: a request was added, or requests were closed (answered, expired or dropped). */
export type StartRequestChange =
  | { kind: 'added'; request: HelperStartRequest }
  | { kind: 'closed'; requestIds: string[] };

type Listener = (change: StartRequestChange) => void;

const pending = new Map<string, HelperStartRequest>();
// Maintained only by existing mutation paths. Display never materializes an
// index, scans unrelated requests, sweeps expiry, or touches timers/listeners.
const pendingByOwner = new Map<string, Set<string>>();
const ownerByRequest = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<Listener>();

function norm(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
const ownerKey = (projectPath: string, orchestratorId: string) => JSON.stringify([norm(projectPath), orchestratorId]);

function emit(change: StartRequestChange): void {
  if (change.kind === 'closed' && change.requestIds.length === 0) return;
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      // telemetry-exempt: one listener failing must not stop the others
    }
  }
}

/** The fields that make two starts the same request. */
const ARG_KEYS: ReadonlyArray<keyof HelperStartArgs> = ['name', 'task', 'persona', 'cli', 'model', 'effort', 'difficulty', 'access', 'branchFrom', 'folder', 'project'];

function sameArgs(a: HelperStartArgs, b: HelperStartArgs): boolean {
  return ARG_KEYS.every((k) => (a[k] ?? null) === (b[k] ?? null));
}

function isExpired(request: HelperStartRequest, now: number): boolean {
  return Date.parse(request.expiresAt) <= now;
}

function remove(requestId: string): boolean {
  const timer = timers.get(requestId);
  if (timer) clearTimeout(timer);
  timers.delete(requestId);
  const owner = ownerByRequest.get(requestId);
  if (owner !== undefined) {
    const ids = pendingByOwner.get(owner); ids?.delete(requestId);
    if (ids?.size === 0) pendingByOwner.delete(owner);
    ownerByRequest.delete(requestId);
  }
  return pending.delete(requestId);
}

/** Drop every expired request. */
function sweep(now: number): void {
  const expired = [...pending.values()].filter((r) => isExpired(r, now)).map((r) => r.requestId);
  for (const id of expired) remove(id);
  emit({ kind: 'closed', requestIds: expired });
}

export type RecordStartResult =
  | { ok: true; request: HelperStartRequest; reused: boolean }
  | { ok: false; reason: 'too_many'; waiting: number };

/**
 * Record a start the user has to approve. The same start from the same
 * orchestrator reuses its waiting request; a new one is refused while the
 * orchestrator already has MAX_PENDING_STARTS_PER_ORCHESTRATOR waiting.
 */
export function recordStartRequest(
  projectPath: string,
  orchestratorId: string,
  orchestratorName: string,
  args: HelperStartArgs,
  now = Date.now(),
  warning?: HelperStartRequest['warning'],
): RecordStartResult {
  sweep(now);
  const mine = [...pending.values()].filter((r) => r.orchestratorId === orchestratorId && norm(r.projectPath) === norm(projectPath));
  const existing = mine.find((r) => sameArgs(r.args, args));
  if (existing) return { ok: true, request: existing, reused: true };
  if (mine.length >= MAX_PENDING_STARTS_PER_ORCHESTRATOR) return { ok: false, reason: 'too_many', waiting: mine.length };

  const request: HelperStartRequest = {
    requestId: `hstart_${randomUUID()}`,
    projectPath,
    orchestratorId,
    orchestratorName,
    args: { ...args },
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + START_REQUEST_TTL_MS).toISOString(),
    ...(warning && { warning }),
  };
  pending.set(request.requestId, request);
  const owner = ownerKey(projectPath, orchestratorId), ids = pendingByOwner.get(owner) ?? new Set<string>();
  ids.add(request.requestId); pendingByOwner.set(owner, ids); ownerByRequest.set(request.requestId, owner);
  const timer = setTimeout(() => sweep(Date.now()), START_REQUEST_TTL_MS + 1);
  timer.unref?.();
  timers.set(request.requestId, timer);
  emit({ kind: 'added', request });
  return { ok: true, request, reused: false };
}

/**
 * Use up a waiting request. Returns it once; null for an unknown or expired
 * id, or one recorded for another project (which stays waiting).
 */
export function takeStartRequest(projectPath: string, requestId: string, now = Date.now()): HelperStartRequest | null {
  sweep(now);
  const request = pending.get(requestId);
  if (!request || norm(request.projectPath) !== norm(projectPath)) return null;
  remove(requestId);
  emit({ kind: 'closed', requestIds: [requestId] });
  return request;
}

/** A waiting request in this project, without using it up; null for an unknown, expired or other-project id. */
export function peekStartRequest(projectPath: string, requestId: string, now = Date.now()): HelperStartRequest | null {
  sweep(now);
  const request = pending.get(requestId);
  return request && norm(request.projectPath) === norm(projectPath) ? request : null;
}

/** Every waiting request, oldest first. */
export function listStartRequests(now = Date.now()): HelperStartRequest[] {
  sweep(now);
  return [...pending.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export type HelperRequestDisplayText = { state: 'ok'; text: string; truncated: boolean }
  | { state: 'withheld'; reason: 'safety' | 'read-limit' | 'unavailable' };
export interface HelperStartRequestDisplay {
  requestId: string;
  status: 'awaiting-approval';
  name: HelperRequestDisplayText;
  task: HelperRequestDisplayText;
  warning?: HelperRequestDisplayText;
  createdAt: string;
  expiresAt: string;
}
function safeRequestText(value: unknown, maximum: number): HelperRequestDisplayText {
  if (typeof value !== 'string') return { state: 'withheld', reason: 'unavailable' };
  if (value.length > 64 * 1024) return { state: 'withheld', reason: 'read-limit' };
  if (!value.trim()) return { state: 'withheld', reason: 'unavailable' };
  // Reuse the reviewed conservative policy before truncation. This is not a
  // general promise that arbitrary prompts can be classified as secret-free.
  const safe = redactChangeText(value);
  return safe === null ? { state: 'withheld', reason: 'safety' }
    : { state: 'ok', text: display(safe, maximum), truncated: safe.length > maximum };
}

/** At most three selected active requests. No sweeping getters or raw args. */
export function readStartRequestsForDisplay(projectPath: string, orchestratorId: string, options: { receipts?: DisplayReceipt[] } = {}): DisplayValue<HelperStartRequestDisplay[]> {
  if (typeof projectPath !== 'string' || projectPath.length > 4096 || typeof orchestratorId !== 'string' || !orchestratorId || orchestratorId.length > 240) return { state: 'unavailable', reason: 'invalid', inputs: [] };
  const owner = ownerKey(projectPath, orchestratorId);
  const read = (): { result: DisplayValue<HelperStartRequestDisplay[]>; stamp: string } => {
    const source = createHash('sha256');
    const stampText = (value: unknown) => typeof value === 'string' ? value.length <= 64 * 1024 ? value : { length: value.length, withheld: 'read-limit' } : { type: typeof value };
    const now = Date.now(), inputs = [{ field: 'Selected pending helper starts', source: 'host-cache' as const, observedAt: now }];
    const ids = pendingByOwner.get(owner);
    if ((ids?.size ?? 0) > MAX_PENDING_STARTS_PER_ORCHESTRATOR) return { result: { state: 'unavailable', reason: 'limit', inputs }, stamp: 'limit' };
    const value: HelperStartRequestDisplay[] = [];
    for (const id of ids ?? []) {
      const request = pending.get(id);
      if (!request || request.requestId !== id || ownerByRequest.get(id) !== owner || request.orchestratorId !== orchestratorId
        || typeof request.projectPath !== 'string' || request.projectPath.length > 4096 || norm(request.projectPath) !== norm(projectPath)
        || !request.args || typeof request.args !== 'object' || Array.isArray(request.args)
        || typeof request.createdAt !== 'string' || request.createdAt.length > 64 || !Number.isFinite(Date.parse(request.createdAt))
        || typeof request.expiresAt !== 'string' || request.expiresAt.length > 64 || !Number.isFinite(Date.parse(request.expiresAt))
        || Date.parse(request.expiresAt) <= Date.parse(request.createdAt)) return { result: { state: 'unavailable', reason: 'changed', inputs }, stamp: 'changed' };
      if (Date.parse(request.expiresAt) <= now) continue;
      source.update(JSON.stringify([id, stampText(request.args.name), stampText(request.args.task), stampText(request.warning?.message)]));
      value.push({ requestId: id, status: 'awaiting-approval', name: safeRequestText(request.args.name, 240), task: safeRequestText(request.args.task, 2048), ...(request.warning !== undefined && { warning: safeRequestText(request.warning?.message, 1024) }), createdAt: request.createdAt, expiresAt: request.expiresAt });
    }
    value.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return { result: { state: 'ok', value, inputs }, stamp: source.digest('hex') };
  };
  const observed = read(), result = observed.result;
  if (options.receipts) {
    const signature = JSON.stringify({ state: result.state, value: result.state === 'ok' ? result.value : undefined, stamp: observed.stamp });
    options.receipts.push({ current: () => { try { const next = read(), now = next.result; return JSON.stringify({ state: now.state, value: now.state === 'ok' ? now.value : undefined, stamp: next.stamp }) === signature; } catch { return false; } } });
  }
  return result;
}

/** The orchestrators with waiting requests, with their projects. */
export function orchestratorsWithRequests(): Array<{ projectPath: string; orchestratorId: string }> {
  const seen = new Map<string, { projectPath: string; orchestratorId: string }>();
  for (const r of pending.values()) seen.set(`${norm(r.projectPath)}\0${r.orchestratorId}`, { projectPath: r.projectPath, orchestratorId: r.orchestratorId });
  return [...seen.values()];
}

/** Drop an orchestrator's waiting requests (it stopped orchestrating, or was disposed or deleted). Returns their ids. */
export function dropStartRequestsFor(orchestratorId: string, projectPath?: string): string[] {
  const ids = [...pending.values()]
    .filter((r) => r.orchestratorId === orchestratorId && (projectPath === undefined || norm(r.projectPath) === norm(projectPath)))
    .map((r) => r.requestId);
  for (const id of ids) remove(id);
  emit({ kind: 'closed', requestIds: ids });
  return ids;
}

/** Subscribe to added and closed requests. Returns the unsubscribe function. */
export function onStartRequestsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function _resetStartRequestsForTesting(options: { keepListeners?: boolean } = {}): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
  pendingByOwner.clear(); ownerByRequest.clear();
  if (!options.keepListeners) listeners.clear();
}
