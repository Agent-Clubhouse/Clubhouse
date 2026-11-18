import { GRANT_ACTION_LABELS } from './agent-grant-changes';
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
  /** `call`: the call's arguments, in full: Allow covers exactly these. The plain-words line, then the arguments. */
  details?: string;
  /** `call`: the plain-words line a tool gives for the call (#3068), also at the top of `details`. */
  detail?: string;
  /** `call`: the arguments alone, as JSON, also in `details`. */
  argumentsText?: string;
  /** The agent's reason, in its words. */
  reason?: string;
  /** Update requests need an explicit restart choice, never a generic Allow. */
  update?: import('./app-update').AppUpdateApproval;
  /** Main-generated exact review, never supplied by a model as approval. */
  importReview?: import('./project-import').ImportPlan;
  agentReview?: import('./project-import').ImportedAgentReview;
  /** Exact batch review generated on the originating computer. */
  deleteReview?: import('./delete-agents').DeleteAgentsReview;
  /** A person on another computer asks to create a group project here (#3547): the exact create, made on this computer. */
  remoteCreateReview?: RemoteCreateReview;
  createdAt: string;
  expiresAt: string;
}

/** Desktop network members may see that a host-only request waits, but none of its contents. */
export interface DesktopPendingGrantRequest {
  hostLabel: string;
  requestId: string;
  kind: GrantRequest['kind'];
  createdAt: string;
}

/** The tool name a remote create's approval is recorded under (#3547). Not an MCP tool: no agent can call it. */
export const REMOTE_CREATE_TOOL = 'remote_create_group_project';

/** What Allow would create, resolved by this computer, never by the asking one. */
export interface RemoteCreateReview {
  /** The asking computer's fingerprint and its name here. */
  machine: string;
  machineName: string;
  name: string;
  /** "The whole app", or this computer's project the group covers. */
  scopeLabel: string;
  /** How starting members are chosen, in words. */
  membershipLabel: string;
  /** Addresses kept out, relative to this computer. */
  excluded: string[];
}

export const GRANT_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_GRANT_REQUESTS_PER_AGENT = 3;
/** Remote create approvals (#3547) waiting on this computer at once, counted apart from the agent's own. */
export const MAX_PENDING_REMOTE_CREATES = 6;
/** Longest reason kept, in characters. */
export const GRANT_REQUEST_REASON_MAX = 500;
/**
 * Longest arguments a call request shows, in characters. Allow covers the
 * whole call, so the user sees all of it; a longer call isn't asked about.
 */
export const GRANT_REQUEST_DETAILS_MAX = 20_000;

export type GrantRequestAnswer = { ok: true } | { ok: false; error: string; reason?: 'request_not_found' };

/** The labels of the permissions a request needs. */
export function grantRequestActionLabels(request: Pick<GrantRequest, 'actions'>): string[] {
  return request.actions.map((a) => GRANT_ACTION_LABELS[a] ?? a);
}

/** The request's line in Needs you, on the desktop and on a phone (#3205). */
export function describeGrantRequest(request: Pick<GrantRequest, 'kind' | 'actions' | 'toolName' | 'where' | 'update' | 'deleteReview' | 'remoteCreateReview'>): string {
  if (request.update) return `Update Clubhouse to ${request.update.version}`;
  if (request.remoteCreateReview) return `${request.remoteCreateReview.machineName} asks to create the group project "${request.remoteCreateReview.name}" on this computer.`;
  if (request.deleteReview) {
    const count = request.deleteReview.items.filter((item) => item.status === 'ready').length;
    return `Review deleting ${count} ${count === 1 ? 'agent' : 'agents'} together.`;
  }
  const needs = grantRequestActionLabels(request).join(', ');
  return request.kind === 'call'
    ? `Wants to run ${request.toolName ?? 'a tool'}, which needs: ${needs} on ${request.where}.`
    : `Asks for ${needs} on ${request.where}.`;
}

/** What Allow does, shown under the request. */
export function grantRequestAllowEffect(request: Pick<GrantRequest, 'kind' | 'update' | 'remoteCreateReview'>): string {
  if (request.remoteCreateReview) return 'Allow creates this group project once, hosted on this computer. Decline creates nothing.';
  if (request.update) return 'Restart now interrupts the listed working agents, then stops any that do not become idle. Stopped agents will not resume. Restart when idle waits up to 30 minutes and never interrupts agents. Agent conversations resume, not interrupted turns.';
  return request.kind === 'call'
    ? 'Allow runs this one call when it tries again. Its permissions stay as they are.'
    : 'Allow adds this to its Clubhouse permissions, where you can remove it later.';
}
