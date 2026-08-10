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
import type { PendingPermissionInfo, PermissionQueueRejection, PermissionResolveOutcome } from '../../shared/permission-types';

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

export type PendingPermission = PendingPermissionInfo;

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

/** Where a resolution came from — recorded for audit logging. */
export type PermissionResolveSource = 'annex' | 'desktop';

/** Why a resolve attempt was refused. */
export type PermissionResolveFailure = PermissionQueueRejection;

export type PermissionResolveResult = PermissionResolveOutcome<PermissionQueueRejection>;

export interface ResolvePermissionOptions {
  /**
   * Require the entry to belong to this agent. Callers that accept a requestId
   * from outside the main process (IPC, network) MUST pass this — a requestId
   * on its own is a bearer token for whichever agent happens to own it.
   */
  expectedAgentId?: string;
  /** Audit trail for who resolved it. */
  source?: PermissionResolveSource;
}

/**
 * Resolve a pending permission with a decision.
 *
 * Refuses when the entry is unknown/already resolved, when it belongs to a
 * different agent than the caller claims, or when its deadline has already
 * passed. The deadline check is deliberate belt-and-braces: the expiry timer
 * normally removes the entry first, but timers can be delayed (busy loop,
 * machine sleep), and a decision applied after the orchestrator has already
 * been told `'ask'` would approve a tool call nobody is waiting on any more.
 */
export function resolvePermissionDetailed(
  requestId: string,
  decision: PermissionDecision,
  options: ResolvePermissionOptions = {},
): PermissionResolveResult {
  const { expectedAgentId, source } = options;
  const entry = pending.get(requestId);
  if (!entry) {
    appLog(NS, 'warn', 'Permission resolve no-op (unknown or already resolved)', {
      meta: { requestId, decision, source },
    });
    return { status: 'rejected', reason: 'not_found' };
  }

  if (expectedAgentId !== undefined && entry.agentId !== expectedAgentId) {
    // Not a normal condition: someone asked to resolve another agent's request.
    appLog(NS, 'error', 'Permission resolve rejected (agent mismatch)', {
      meta: { requestId, decision, source, claimedAgentId: expectedAgentId, ownerAgentId: entry.agentId },
    });
    return { status: 'rejected', reason: 'agent_mismatch' };
  }

  if (Date.now() >= entry.createdAt + entry.timeoutMs) {
    appLog(NS, 'warn', 'Permission resolve rejected (deadline passed)', {
      meta: { requestId, decision, source, agentId: entry.agentId, createdAt: entry.createdAt, timeoutMs: entry.timeoutMs },
    });
    return { status: 'rejected', reason: 'expired' };
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
      source,
    },
  });
  entry.resolve(decision);
  return { status: 'resolved' };
}

/**
 * Resolve a pending permission. Returns true if the request was found and
 * resolved, false if it was refused. See resolvePermissionDetailed() for the
 * refusal reason.
 */
export function resolvePermission(
  requestId: string,
  decision: PermissionDecision,
  options: ResolvePermissionOptions = {},
): boolean {
  return resolvePermissionDetailed(requestId, decision, options).status === 'resolved';
}

/** Look up a pending permission without resolving it. */
export function getPermission(requestId: string): PendingPermission | undefined {
  const entry = pending.get(requestId);
  if (!entry) return undefined;
  const { resolve: _resolve, timer: _timer, ...info } = entry;
  return info;
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
