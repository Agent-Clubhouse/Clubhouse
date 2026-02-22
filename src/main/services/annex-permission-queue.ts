/**
 * Pending permission approval queue for Annex.
 *
 * When a Claude Code agent fires a PermissionRequest hook, the hook server
 * creates a pending permission entry. The Annex server broadcasts it to
 * connected iOS clients. When a client responds (allow/deny), the decision
 * is relayed back to the waiting hook script via the resolved promise.
 */

import { randomUUID } from 'crypto';

export type PermissionDecision = 'allow' | 'deny';

export interface PendingPermission {
  requestId: string;
  agentId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  message?: string;
  createdAt: number;
  timeoutMs: number;
}

interface PendingEntry extends PendingPermission {
  resolve: (decision: PermissionDecision | 'timeout') => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

/** Listener called when a new permission request is created. */
type PermissionRequestListener = (permission: PendingPermission) => void;
const listeners = new Set<PermissionRequestListener>();

/**
 * Create a pending permission request. Returns a promise that resolves
 * with the decision ('allow', 'deny', or 'timeout').
 */
export function createPermission(
  agentId: string,
  toolName: string,
  toolInput?: Record<string, unknown>,
  message?: string,
  timeoutMs: number = 120_000,
): { requestId: string; decision: Promise<PermissionDecision | 'timeout'> } {
  const requestId = randomUUID();
  const createdAt = Date.now();

  const decision = new Promise<PermissionDecision | 'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve('timeout');
    }, timeoutMs);

    const entry: PendingEntry = {
      requestId,
      agentId,
      toolName,
      toolInput,
      message,
      createdAt,
      timeoutMs,
      resolve,
      timer,
    };
    pending.set(requestId, entry);
  });

  // Notify listeners
  const info: PendingPermission = { requestId, agentId, toolName, toolInput, message, createdAt, timeoutMs };
  for (const fn of listeners) fn(info);

  return { requestId, decision };
}

/**
 * Resolve a pending permission with a decision. Returns true if the
 * request was found and resolved, false if it was already expired/resolved.
 */
export function resolvePermission(requestId: string, decision: PermissionDecision): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(decision);
  return true;
}

/** Get all pending permissions. */
export function listPending(): PendingPermission[] {
  return Array.from(pending.values()).map(({ resolve, timer, ...info }) => info);
}

/** Get pending permissions for a specific agent. */
export function listPendingForAgent(agentId: string): PendingPermission[] {
  return listPending().filter((p) => p.agentId === agentId);
}

/** Subscribe to new permission requests. Returns unsubscribe function. */
export function onPermissionRequest(fn: PermissionRequestListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Clear all pending permissions for an agent (e.g., when agent stops). */
export function clearForAgent(agentId: string): void {
  for (const [id, entry] of pending) {
    if (entry.agentId === agentId) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.resolve('timeout');
    }
  }
}

/** Reset all state. Used during shutdown. */
export function reset(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve('timeout');
  }
  pending.clear();
  listeners.clear();
}
