/**
 * Pending permission approval queue for Annex.
 *
 * When a Claude Code / Copilot CLI / Codex CLI agent fires a PermissionRequest
 * hook, the hook server creates a pending permission entry. The Annex server
 * broadcasts it to connected iOS clients. When a client responds (allow/deny),
 * the decision is relayed back to the waiting hook script via the resolved
 * promise.
 *
 * ## Timeout race
 *
 * The orchestrator's hook config has its own timeout (PERMISSION_HOOK_TIMEOUT_SEC,
 * 120s today).  If both the orchestrator and our queue expire at the same instant
 * the orchestrator kills the curl child *before* we write the response, the agent
 * stalls.  We resolve PERMISSION_QUEUE_SAFETY_MARGIN_MS *earlier* so the queue
 * always wins the race and the orchestrator actually receives our `'ask'`
 * fallback decision.
 */

import { randomUUID } from 'crypto';
import { appLog } from './log-service';
import { PERMISSION_HOOK_TIMEOUT_SEC } from '../orchestrators/types';

export type PermissionDecision = 'allow' | 'deny';

/**
 * Safety margin ensuring the queue always resolves before the orchestrator's
 * hook timeout fires.  10s gives the network round-trip + response write
 * comfortable headroom even on slow systems.
 */
export const PERMISSION_QUEUE_SAFETY_MARGIN_MS = 10_000;

/**
 * Default queue timeout, derived from the orchestrator hook timeout minus the
 * safety margin.  Callers may override via the timeoutMs argument to
 * createPermission().
 */
export const PERMISSION_QUEUE_TIMEOUT_MS =
  PERMISSION_HOOK_TIMEOUT_SEC * 1000 - PERMISSION_QUEUE_SAFETY_MARGIN_MS;

const NS = 'core:permission-queue';

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
  timeoutMs: number = PERMISSION_QUEUE_TIMEOUT_MS,
): { requestId: string; decision: Promise<PermissionDecision | 'timeout'> } {
  const requestId = randomUUID();
  const createdAt = Date.now();

  const decision = new Promise<PermissionDecision | 'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      appLog(NS, 'warn', 'Permission timed out', {
        meta: { requestId, agentId, toolName, timeoutMs },
      });
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

  appLog(NS, 'info', 'Permission requested', {
    meta: {
      requestId,
      agentId,
      toolName,
      timeoutMs,
      deadline: createdAt + timeoutMs,
      hasInput: toolInput !== undefined,
      hasMessage: message !== undefined,
    },
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
  if (!entry) {
    appLog(NS, 'warn', 'Permission resolve no-op (unknown or already resolved)', {
      meta: { requestId, decision },
    });
    return false;
  }
  clearTimeout(entry.timer);
  pending.delete(requestId);
  const elapsedMs = Date.now() - entry.createdAt;
  appLog(NS, 'info', 'Permission resolved', {
    meta: {
      requestId,
      agentId: entry.agentId,
      toolName: entry.toolName,
      decision,
      elapsedMs,
    },
  });
  entry.resolve(decision);
  return true;
}

/** Get all pending permissions. */
export function listPending(): PendingPermission[] {
  return Array.from(pending.values()).map(({ resolve: _resolve, timer: _timer, ...info }) => info);
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
  let count = 0;
  for (const [id, entry] of pending) {
    if (entry.agentId === agentId) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.resolve('timeout');
      count += 1;
    }
  }
  if (count > 0) {
    appLog(NS, 'info', 'Permissions cleared on agent stop', {
      meta: { agentId, count },
    });
  }
}

/** Reset all state. Used during shutdown. */
export function reset(): void {
  const count = pending.size;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve('timeout');
  }
  pending.clear();
  listeners.clear();
  if (count > 0) {
    appLog(NS, 'debug', 'Permission queue reset', { meta: { count } });
  }
}
