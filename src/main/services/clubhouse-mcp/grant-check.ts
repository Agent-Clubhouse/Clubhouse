/**
 * The call-time grant check (#2968, part of #2921). callTool asks it after
 * the caller gate and the tool groups, for every tool, and the tool list is
 * filtered the same way. A call goes ahead only when a default grant covers
 * every action its tool declares (#2967), on the target the call reaches.
 *
 * The old checks (tool groups, wires, per-handler checks) still run, so this
 * can only narrow what an agent could do. What it narrows now are the epic's
 * two gap fixes: a helper reaches its orchestrator only to message it (not to
 * read, clear or compact it), and nothing connected to the Dispatcher can
 * reset it.
 *
 * Targets named in a call's arguments (`agent_arg`, `project_arg`) aren't
 * resolved here yet: their tools keep their own handler checks until those
 * move into this check (#2974). Plugin tools get no new access, and
 * call_wire_tool's inner call is checked as its own tool.
 *
 * Grants are a cooperative guardrail on the Clubhouse MCP, not a sandbox.
 */

import { evaluateGrant, GRANT_REFUSAL_MESSAGES, type Grant, type GrantCallTarget, type GrantCaller, type GrantRefusal } from '../../../shared/agent-grants';
import { defaultGrants } from '../../../shared/default-grants';
import { isProjectAdmin } from '../../../shared/group-project-admin';
import { agentRegistry } from '../agent-registry';
import { isDispatcherAgent, isTrackedDispatcher } from './dispatcher-gate';
import { mcpCallerParent } from './mcp-call-gate';
import { isCrossProjectEnabled, isOrchestrationEnabled } from './orchestration-gate';
import { toolGrantDeclarations, type ToolGrant, type ToolGrantTarget } from './tool-grants';
import type { McpBinding } from './types';

export type GrantCheck = { ok: true } | { ok: false; reason: GrantRefusal | 'ask_first'; message: string };

const OK: GrantCheck = { ok: true };

/** What the check needs about the call's wire, when it has one. */
export interface GrantCheckWire {
  binding: Pick<McpBinding, 'targetId' | 'targetKind'>;
  /** For a group project wire: the project's metadata, for its admins. */
  groupMetadata?: Record<string, unknown>;
}

/** How the wire's target stands to the caller. The caller's orchestrator is its parent, not a connection. */
function boundTarget(agentId: string, wire: GrantCheckWire): GrantCallTarget | null {
  const { binding } = wire;
  switch (binding.targetKind) {
    case 'agent': {
      const isDispatcher = isTrackedDispatcher(binding.targetId);
      if (binding.targetId === agentId) return { kind: 'agent', relations: ['self'], isDispatcher };
      if (mcpCallerParent(agentId) === binding.targetId) return { kind: 'agent', relations: ['parent'], isDispatcher };
      return { kind: 'agent', relations: ['connected'], isDispatcher };
    }
    case 'browser':
      return { kind: 'browser', relations: ['connected'] };
    case 'group-project':
      return { kind: 'group_project', groupRole: isProjectAdmin(wire.groupMetadata, agentId) ? 'admin' : 'member' };
    default:
      // Terminals and plugin targets: no grant action covers them yet.
      return null;
  }
}

/** The target a declaration names, resolved for this call. Null: not checked here (see the file comment). */
function resolveTarget(agentId: string, target: ToolGrantTarget, wire: GrantCheckWire | undefined): GrantCallTarget | null {
  switch (target) {
    case 'bound': return wire ? boundTarget(agentId, wire) : null;
    // Members of a group project its admins act on: the caller must administer the bound group.
    case 'group_members': return { kind: 'agent', relations: wire && isProjectAdmin(wire.groupMetadata, agentId) ? ['group_member'] : [] };
    case 'parent': return { kind: 'agent', relations: ['parent'] };
    case 'my_helpers': return { kind: 'agent', relations: ['my_helper'] };
    case 'connected': return { kind: 'agent', relations: ['connected'] };
    case 'app': return { kind: 'app' };
    case 'library': return { kind: 'library' };
    case 'all_projects': return { kind: 'project' };
    case 'agent_arg':
    case 'project_arg':
      return null;
  }
}

/** Where a refused call was aimed, in the caller's terms. Never says whether a target exists. */
function whereText(target: GrantCallTarget): string {
  const rel = target.relations ?? [];
  if (target.isDispatcher && rel.includes('connected')) return 'the Dispatcher';
  if (rel.includes('parent')) return 'your orchestrator';
  if (rel.includes('my_helper')) return 'your helpers';
  if (rel.includes('connected')) return target.kind === 'browser' ? 'a canvas browser you are wired to' : 'an agent you are connected to';
  if (rel.includes('group_member')) return 'members of this group project';
  if (rel.includes('self')) return 'yourself';
  switch (target.kind) {
    case 'group_project': return 'this group project';
    case 'project': return 'projects';
    case 'library': return 'the parts and templates library';
    case 'app': return 'the app';
    default: return 'this target';
  }
}

/**
 * The refusal an agent gets: which permission it lacks, on what, and what to
 * do. Only the user grants Clubhouse permissions, and an agent can't give
 * itself one, so it says to ask the user.
 */
function refusalMessage(reason: GrantRefusal, action: string, target: GrantCallTarget): string {
  if (reason !== 'no_grant') return GRANT_REFUSAL_MESSAGES[reason];
  const where = whereText(target);
  const hint = (target.relations ?? []).includes('parent') ? ' To report to your orchestrator, use message_parent.' : '';
  return `You don't have the Clubhouse permission ${action} on ${where}.${hint} Only the user can grant it; ask them if you need it.`;
}

/** A running agent's default grants, from what the gates know about it. */
export function callerGrants(agentId: string): Grant[] {
  const tracked = isTrackedDispatcher(agentId);
  return defaultGrants({
    dispatcher: isDispatcherAgent(agentId),
    helper: mcpCallerParent(agentId) !== undefined,
    orchestrates: !tracked && isOrchestrationEnabled(agentId),
    crossProject: !tracked && isCrossProjectEnabled(agentId),
  });
}

/**
 * Whether `agentId` may make this call. `args` decides which declarations
 * apply (`ifArgs`); a listing passes none, so it checks what every call
 * needs. A tool registered without a declaration (tests only; real tools
 * can't) is let through.
 */
export function checkToolGrant(agentId: string, grant: ToolGrant | undefined, args: Record<string, unknown>, wire?: GrantCheckWire): GrantCheck {
  if (!grant) return OK;
  const declarations = toolGrantDeclarations(grant)
    .filter((d) => !d.ifArgs || d.ifArgs.some((a) => args[a] !== undefined && args[a] !== null));
  if (declarations.length === 0) return OK;
  const caller: GrantCaller = { kind: 'agent', agentId, projectPath: agentRegistry.get(agentId)?.projectPath };
  const grants = callerGrants(agentId);
  for (const d of declarations) {
    const target = resolveTarget(agentId, d.target, wire);
    if (!target) continue;
    for (const action of d.actions) {
      const decision = evaluateGrant({ caller, action, target }, grants);
      if (decision.outcome === 'refuse') return { ok: false, reason: decision.reason, message: refusalMessage(decision.reason, action, target) };
      // No default grant on a tool is Ask first yet; requests in Needs you come with #2970.
      if (decision.outcome === 'ask') return { ok: false, reason: 'ask_first', message: 'This needs the user\'s approval, and asking isn\'t available yet.' };
    }
  }
  return OK;
}
