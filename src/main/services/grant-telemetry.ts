/**
 * Clubhouse permissions in the telemetry record (#2973, part of #2921; spec
 * §6.13). Three audited events:
 * - `clubhouse.audit.grant_decision`: a call the permissions refused or asked
 *   about. Allowed calls aren't events: the `clubhouse.mcp.tool_call` span
 *   already counts every call, and an event per allowed call would swamp the
 *   record.
 * - `clubhouse.audit.grant_request`: the user's answer to a request, or its expiry.
 * - `clubhouse.audit.grant_change`: who changed what, from which surface.
 *
 * Attributes are enums and hashed ids only. The local detail holds short
 * names (a built-in tool name, an action, a target kind, tool names) and ids
 * listed in `detailIds`, which are hashed. Never a path, a name or a value
 * someone typed. Every function never throws.
 */

import { ATTR } from '../../shared/telemetry/attributes';
import type { GrantAction, GrantTarget } from '../../shared/agent-grants';
import { tel } from '../telemetry/facade';
import { currentSettingsOrigin } from './settings-audit';

type TargetKind = Parameters<typeof ATTR.grantTargetKind>[0];

/** The built-in part of a tool name: `agent__<name>__get_status` → `get_status`. A plugin's tool is `other`. */
export function toolPart(toolName: string): string {
  const parts = toolName.split('__');
  const suffix = parts[parts.length - 1] ?? toolName;
  return /^[a-z][a-z0-9_]{0,63}$/.test(suffix) && !toolName.startsWith('plugin__') ? suffix : 'other';
}

/** A call refused, or held for the user. */
export function recordGrantDecision(input: {
  agentId: string;
  toolName: string;
  decision: 'refused' | 'asked';
  reason: 'no_grant' | 'raise_self' | 'exceeds_caller' | 'ask_first';
  actions: readonly GrantAction[];
  targetKind?: TargetKind;
}): void {
  try {
    tel.event('clubhouse.audit.grant_decision', [
      ATTR.grantDecision(input.decision),
      ATTR.grantRefusalReason(input.reason),
      ...(input.actions[0] ? [ATTR.grantAction(input.actions[0])] : []),
      ...(input.targetKind ? [ATTR.grantTargetKind(input.targetKind)] : []),
      ATTR.auditActorIdHash(input.agentId),
    ], {
      severity: input.decision === 'refused' ? 'warn' : 'info',
      detail: { tool: toolPart(input.toolName), ...(input.actions.length > 1 && { actions: [...input.actions].slice(0, 8) }) },
    });
  } catch {
    // telemetry-exempt: recording must never fail the call
  }
}

/** The user answered a request, or it expired. */
export function recordGrantRequest(input: {
  agentId: string;
  kind: 'call' | 'grant';
  outcome: 'allowed' | 'declined' | 'expired';
  actions: readonly GrantAction[];
}): void {
  try {
    tel.event('clubhouse.audit.grant_request', [
      ATTR.grantRequestKind(input.kind),
      ATTR.grantRequestOutcome(input.outcome),
      ...(input.actions[0] ? [ATTR.grantAction(input.actions[0])] : []),
      ATTR.auditActorIdHash(input.agentId),
    ], {
      detail: { kind: input.kind, actions: [...input.actions].slice(0, 8) },
    });
  } catch {
    // telemetry-exempt: recording must never fail the answer
  }
}

function surface(): Parameters<typeof ATTR.auditSurface>[0] {
  return currentSettingsOrigin().surface;
}

/** A change to one agent's permissions: its own, its template's, or the approval setting through its rows. */
export function recordGrantChange(input: {
  agentId: string;
  layer: 'own' | 'template' | 'control';
  mode: 'off' | 'ask' | 'allow' | 'reset';
  action?: GrantAction;
  target?: GrantTarget;
}): void {
  try {
    const actor = currentSettingsOrigin().actorId;
    tel.event('clubhouse.audit.grant_change', [
      ATTR.auditSurface(surface()),
      ATTR.grantChangeLayer(input.layer),
      ATTR.grantChangeMode(input.mode),
      ...(input.action ? [ATTR.grantAction(input.action)] : []),
      ...(actor ? [ATTR.auditActorIdHash(actor)] : []),
      ATTR.auditTargetIdHash(input.agentId),
    ], {
      detail: { ...(input.target && { target: input.target.kind }), ...(input.action && { action: input.action }) },
    });
  } catch {
    // telemetry-exempt: recording must never fail the change
  }
}

/** A change to one direction of a connection: its disabled tools, or the user's link. */
export function recordConnectionChange(input: {
  fromAgentId: string;
  toAgentId: string;
  disabledTools: readonly string[];
  link?: boolean;
  migrated?: boolean;
}): void {
  try {
    const actor = currentSettingsOrigin().actorId;
    tel.event('clubhouse.audit.grant_change', [
      ATTR.auditSurface(input.migrated ? 'system' : surface()),
      ATTR.grantChangeLayer('connection'),
      ATTR.grantChangeMode(input.disabledTools.length > 0 ? 'off' : 'allow'),
      ...(actor ? [ATTR.auditActorIdHash(actor)] : []),
      ATTR.auditTargetIdHash(input.fromAgentId),
    ], {
      detail: {
        target: 'connection',
        disabled: input.disabledTools.filter((t) => /^[a-z][a-z0-9_]{0,63}$/.test(t)).slice(0, 8),
        ...(input.link !== undefined && { link: input.link }),
        ...(input.migrated && { migrated: true }),
      },
      detailIds: { to: [input.toAgentId] },
    });
  } catch {
    // telemetry-exempt: recording must never fail the change
  }
}
