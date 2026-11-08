import type { GrantAction, GrantTarget } from './agent-grants';

/**
 * A request for the user's approval of a Clubhouse permission (#2970, part of
 * #2921). Two kinds:
 *
 * - `call`: an agent made a call one of its permissions is set to Ask first
 *   for. Allow lets that one call through: the agent is told, and calls again
 *   with the same arguments. It doesn't change the agent's permissions.
 * - `grant`: an agent asked for a permission for itself (`request_grant`).
 *   Allow adds it to the agent's permissions, where the user can see and
 *   remove it.
 *
 * Requests live in memory, expire after 24 hours, and are gone when the app quits.
 */
export interface GrantRequest {
  requestId: string;
  kind: 'call' | 'grant';
  agentId: string;
  agentName: string;
  projectPath: string;
  /** The permissions it needs. A call can need more than one. */
  actions: GrantAction[];
  /** Where, in the user's terms ("your helpers", "the app"). */
  where: string;
  /** `grant`: the target the permission would be on. */
  target?: GrantTarget;
  /** `call`: the tool it called. */
  toolName?: string;
  /** `call`: the call's arguments, in full: Allow covers exactly these. */
  details?: string;
  /** The agent's reason, in its words. */
  reason?: string;
  createdAt: string;
  expiresAt: string;
}

export const GRANT_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_GRANT_REQUESTS_PER_AGENT = 3;
/** Longest reason kept, in characters. */
export const GRANT_REQUEST_REASON_MAX = 500;
/**
 * Longest arguments a call request shows, in characters. Allow covers the
 * whole call, so the user sees all of it; a longer call isn't asked about.
 */
export const GRANT_REQUEST_DETAILS_MAX = 20_000;

export type GrantRequestAnswer = { ok: true } | { ok: false; error: string };
