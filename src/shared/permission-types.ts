/**
 * Types shared between main, preload and renderer for the durable (PTY) agent
 * permission queue — the hook-driven approve/deny path used by Claude Code /
 * Copilot CLI / Codex CLI agents.
 *
 * Structured-mode sessions use a separate path (see structured-events.ts).
 */

/** A permission request awaiting an allow/deny decision. */
export interface PendingPermissionInfo {
  requestId: string;
  agentId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  message?: string;
  /** Epoch ms when the request entered the queue. */
  createdAt: number;
  /** How long the queue will wait before falling back to 'ask'. */
  timeoutMs: number;
}

/** Payload broadcast when a pending request is settled (any outcome). */
export interface PermissionSettledInfo {
  requestId: string;
  agentId: string;
  /** 'ask' is the timeout fallback sent to the orchestrator. */
  decision: 'allow' | 'deny' | 'ask';
}

/** Why the permission queue itself refused to apply a decision. */
export type PermissionQueueRejection = 'not_found' | 'agent_mismatch' | 'expired';

/** Why the main process refused a renderer-initiated decision. */
export type PermissionResolveRejection =
  | PermissionQueueRejection
  | 'invalid_decision'
  | 'unknown_agent';

/**
 * Result of an approve/deny attempt.
 *
 * The discriminant is a string, not a boolean: this project compiles with
 * `strictNullChecks` off, where boolean-literal discriminants don't narrow.
 */
export type PermissionResolveOutcome<R = PermissionResolveRejection> =
  | { status: 'resolved' }
  | { status: 'rejected'; reason: R };
