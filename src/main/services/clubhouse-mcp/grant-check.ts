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
 * Targets named in a call's arguments (`agent_arg`, `project_arg`) are
 * resolved before the check at call time (arg-targets.ts, #2974), from the
 * arguments each declaration names. One that doesn't resolve is left to the
 * tool, which says it wasn't found; the tools' own checks still run behind
 * this one until the tool groups go too. Plugin tools get no new access, and
 * call_wire_tool's inner call is checked as its own tool.
 *
 * Grants are a cooperative guardrail on the Clubhouse MCP, not a sandbox.
 */

import { evaluateGrant, GRANT_REFUSAL_MESSAGES, widerOrSame, type Grant, type GrantAction, type GrantCallTarget, type GrantCaller, type GrantDecision, type GrantRefusal } from '../../../shared/agent-grants';
import { defaultGrants } from '../../../shared/default-grants';
import { CROSS_PROJECT_OFF_MESSAGE, fiveLevelOf } from '../../../shared/orchestration-policy';
import { agentRegistry } from '../agent-registry';
import { bindingManager } from './binding-manager';
import { isDispatcherCoordinatorId, isDispatcherAgent, isTrackedDispatcher, isTrackedDispatcherChat } from './dispatcher-gate';
import { mcpCallerParent } from './mcp-call-gate';
import { getAgentGrantChanges } from '../agent-grants-store';
import { localConnectionWakeOn } from '../connection-grants-store';
import { applyGrantChanges } from '../../../shared/agent-grant-changes';
import { isCrossProjectEnabled, isOrchestrationEnabled, orchestrationControl } from './orchestration-gate';
import { toolGrantDeclarations, type ToolGrant, type ToolGrantDeclaration, type ToolGrantTarget } from './tool-grants';
import type { ArgTargets } from './arg-targets';
import type { McpBinding } from './types';

/** One action a call needs that is set to Ask first, and where (in the caller's terms). */
export interface AskedAction { action: GrantAction; where: string }

export type GrantCheck =
  | { ok: true }
  | { ok: false; reason: GrantRefusal; message: string; action?: GrantAction; targetKind?: GrantCallTarget['kind'] }
  /** Every action is allowed or Ask first, and at least one asks: the user decides (#2970). */
  | { ok: false; reason: 'ask_first'; message: string; asks: AskedAction[] };

/** Whether a tool is listed: allowed, or one the agent can ask for. */
export function isListable(check: GrantCheck): boolean {
  return check.ok === true || check.reason === 'ask_first';
}

const OK: GrantCheck = { ok: true };

/** What the check needs about the call's wire, when it has one. */
export interface GrantCheckWire {
  binding: Pick<McpBinding, 'targetId' | 'targetKind'>;
  /** For a group project wire: the project's metadata, for its admins. */
  groupMetadata?: Record<string, unknown>;
  /** Hypothetical switch state for the editor catalog; calls use the saved state. */
  wakeOn?: boolean;
}

/** How the wire's target stands to the caller. The caller's orchestrator is its parent, not a connection. */
function boundTarget(agentId: string, wire: GrantCheckWire): GrantCallTarget | null {
  const { binding } = wire;
  switch (binding.targetKind) {
    case 'agent': {
      const isDispatcher = isTrackedDispatcher(binding.targetId);
      if (binding.targetId === agentId) return { kind: 'agent', relations: ['self'], isDispatcher };
      if (mcpCallerParent(agentId) === binding.targetId) return { kind: 'agent', relations: ['parent'], isDispatcher };
      return { kind: 'agent', relations: ['connected'], isDispatcher, ...((wire.wakeOn ?? localConnectionWakeOn(agentId, binding.targetId)) && { wakeOn: true }) };
    }
    case 'browser':
      return { kind: 'browser', relations: ['connected'] };
    case 'group-project':
      // Bound is a member. Lead and admin are grants on this group project by id (#3360).
      return { kind: 'group_project', groupRole: 'member', groupProjectId: binding.targetId };
    default:
      // Terminals and plugin targets: no grant action covers them yet.
      return null;
  }
}

/** The target a declaration names, resolved for this call. Null: not checked here (see the file comment). */
function resolveTargets(agentId: string, d: ToolGrantDeclaration, wire: GrantCheckWire | undefined, args: Record<string, unknown>, argTargets?: ArgTargets): GrantCallTarget[] {
  // Named in the arguments: resolved before the check, at call time only (arg-targets.ts).
  if (d.target === 'handoff_peer' || d.target === 'agent_arg' || d.target === 'project_arg' || d.target === 'group_project_arg') return argTargets?.get(d) ?? [];
  const one = resolveTarget(agentId, d.target, wire, args);
  return one ? [one] : [];
}

function resolveTarget(agentId: string, target: ToolGrantTarget, wire: GrantCheckWire | undefined, args: Record<string, unknown>): GrantCallTarget | null {
  switch (target) {
    case 'remote_dispatcher': return { kind: 'agent', remoteDispatcher: true, isDispatcher: true };
    case 'bound': return wire ? boundTarget(agentId, wire) : null;
    // Members of the bound group project: an agent named in the call (target_agent_id) must be a
    // member of it (#2974). Broadcast names none. That the caller leads the group is its own
    // declaration, group_project.lead on the bound group project (#3360).
    case 'group_members': {
      if (!wire) return { kind: 'agent', relations: [] };
      // "all" taps every member, as broadcast does.
      const named = typeof args.target_agent_id === 'string' && args.target_agent_id !== 'all' ? args.target_agent_id : undefined;
      const member = !named || isGroupMember(wire.binding.targetId, named);
      return { kind: 'agent', relations: member ? ['group_member'] : [], ...(!member && { notGroupMember: true }) };
    }
    case 'self': return { kind: 'agent', relations: ['self'] };
    case 'parent': return { kind: 'agent', relations: ['parent'] };
    case 'my_helpers': return { kind: 'agent', relations: ['my_helper'] };
    case 'created_by_me': return { kind: 'agent', relations: ['created_by_me'] };
    case 'all_agents': return { kind: 'agent', relations: [] };
    case 'connected': return { kind: 'agent', relations: ['connected'] };
    case 'app': return { kind: 'app' };
    case 'library': return { kind: 'library' };
    case 'all_projects': return { kind: 'project' };
    case 'action_arg': {
      // Listing passes no arguments: which Action isn't known until the call,
      // which is checked then. Without this an agent couldn't see the tools for
      // its own Actions.
      if (!actionOwnerLookup || args.id === undefined) return null;
      const action = actionOwnerLookup(args);
      const groupAdmin = action?.groupProjectId && isGroupMember(action.groupProjectId, agentId) && decideGrant(agentId, 'group_project.admin', { kind: 'group_project', groupRole: 'member', groupProjectId: action.groupProjectId } as GrantCallTarget).outcome !== 'refuse';
      // An unknown id reads like someone else's: a refusal never says whether it exists.
      return { kind: 'action', actionId: action?.actionId, relations: action?.ownerAgentId === agentId || groupAdmin ? ['self'] : [] };
    }
    case 'action_group_project': {
      const groupProjectId = actionOwnerLookup?.(args)?.groupProjectId;
      return groupProjectId ? { kind: 'group_project', groupRole: isGroupMember(groupProjectId, agentId) ? 'member' : null, groupProjectId } as GrantCallTarget : null;
    }
    case 'handoff_peer':
    case 'agent_arg':
    case 'project_arg':
    case 'group_project_arg':
      return null; // resolveTargets takes these from the call's resolved arguments
  }
}

/** Whether an agent is bound to a group project: its member. */
export function isGroupMember(groupId: string, memberId: string): boolean {
  return bindingManager.getAllBindings().some((b) => b.targetKind === 'group-project' && b.targetId === groupId && b.agentId === memberId);
}

/** Who owns the Action a call names: an agent, or a person (no `ownerAgentId`). Undefined when the id is unknown. */
export type ActionOwnerLookup = (args: Record<string, unknown>) => { actionId: string; ownerAgentId?: string; groupProjectId?: string } | undefined;

let actionOwnerLookup: ActionOwnerLookup | null = null;

/** The Actions module registers how to find an Action's owner from a call's arguments (#2918). */
export function registerActionOwnerLookup(lookup: ActionOwnerLookup | null): void {
  actionOwnerLookup = lookup;
}

/** Where a refused call was aimed, in the caller's terms. Never says whether a target exists. */
export function whereText(target: GrantCallTarget): string {
  if (target.remoteDispatcher) return "another machine's Dispatcher";
  const rel = target.relations ?? [];
  if (target.isDispatcher && rel.includes('connected')) return 'the Dispatcher';
  if (rel.includes('parent')) return 'your orchestrator';
  if (rel.includes('my_helper')) return 'your helpers';
  if (rel.includes('created_by_me')) return 'the agent created by this call';
  if (rel.includes('connected')) return target.kind === 'browser' ? 'a canvas browser you are wired to' : 'an agent you are connected to';
  if (rel.includes('group_member')) return 'members of this group project';
  if (target.notGroupMember) return 'an agent that is not a member of this group project';
  if (target.kind === 'action') return rel.includes('self') ? 'your own Action' : 'an Action you don\'t own';
  if (rel.includes('self')) return 'yourself';
  switch (target.kind) {
    case 'group_project': return 'this group project';
    case 'project': return 'projects';
    case 'library': return 'the parts and templates library';
    case 'app': return 'the app';
    case 'agent': return 'that agent';
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
  const hint = (target.relations ?? []).includes('parent') ? ' To report to your orchestrator, use message_parent.'
    // Starting a helper in another project is what Cross-project helpers turns on (#2974).
    : action === 'agent.create' && target.kind === 'project' ? ` ${CROSS_PROJECT_OFF_MESSAGE} Starting helpers in other projects needs Cross-project helpers on, in your Helpers settings.`
      : '';
  return `You don't have the Clubhouse permission ${action} on ${where}.${hint} Only the user can grant it; ask them if you need it.`;
}

/**
 * The caller as the check sees it, with its running Access level for fixed
 * rule 2 ("no granting more than you hold"). Unknown reads as Ask first. The
 * Access a call would set is compared where the tool decides it, in
 * access-ceiling.ts (D126): creating an agent, a template push, a helper start.
 */
function callerOf(agentId: string): GrantCaller {
  const registration = agentRegistry.get(agentId);
  return {
    kind: 'agent', agentId, projectPath: registration?.projectPath,
    ...(registration?.launchAccess && { access: fiveLevelOf(registration.launchAccess) }),
  };
}

/** A running agent's grants: its defaults, from what the gates know about it, with a person's changes (#2971). */
export function callerGrants(agentId: string): Grant[] {
  const tracked = isTrackedDispatcher(agentId);
  return applyGrantChanges(defaultGrants({
    dispatcher: isDispatcherAgent(agentId),
    dispatcherChat: isTrackedDispatcherChat(agentId),
    dispatcherConnected: bindingManager.getBindingsForAgent(agentId).some((b) => b.targetKind === 'agent' && (isDispatcherCoordinatorId(b.targetId) || isTrackedDispatcher(b.targetId) && !isTrackedDispatcherChat(b.targetId))),
    helper: mcpCallerParent(agentId) !== undefined,
    orchestrates: !tracked && isOrchestrationEnabled(agentId),
    crossProject: !tracked && isCrossProjectEnabled(agentId),
    control: orchestrationControl(agentId),
  }), getAgentGrantChanges(agentId));
}

function hasAnyAgentSource(args: Record<string, unknown>): boolean {
  const isAny = (source: unknown) => !!source && typeof source === 'object' && 'kind' in source && source.kind === 'any';
  const trigger = args.trigger;
  return isAny(args.source) || (!!trigger && typeof trigger === 'object' && 'source' in trigger && isAny(trigger.source));
}

/**
 * Whether `agentId` may make this call. `args` decides which conditional
 * declarations apply; a listing passes none, so it checks what every call
 * needs. A tool registered without a declaration (tests only; real tools
 * can't) is let through.
 */
export function checkToolGrant(agentId: string, grant: ToolGrant | undefined, args: Record<string, unknown>, wire?: GrantCheckWire, argTargets?: ArgTargets, listing = false): GrantCheck {
  if (!grant) return OK;
  const declarations = toolGrantDeclarations(grant)
    .filter((d) => (!d.ifArgs || d.ifArgs.some((a) => args[a] !== undefined && args[a] !== null))
      && (!d.ifTrue || d.ifTrue.some((a) => args[a] === true)))
    .filter((d) => !d.ifAnyAgentSource || hasAnyAgentSource(args));
  if (declarations.length === 0) return OK;
  const caller = callerOf(agentId);
  const grants = callerGrants(agentId);
  // A refusal wins over an ask: there's no point asking the user for a call that would fail anyway.
  const asks: AskedAction[] = [];
  for (const d of declarations) {
    if (d.target === 'handoff_peer' && listing) {
      // Listing: any target covered by this action makes the tool useful. The
      // actual peer is resolved and checked before an execution or an Ask-first request.
      for (const action of d.actions) {
        const matching = grants.filter((g) => g.action === action);
        if (!matching.length) return { ok: false, reason: 'no_grant', message: GRANT_REFUSAL_MESSAGES.no_grant, action, targetKind: 'agent' };
        if (!matching.some((g) => g.mode === 'allow')) asks.push({ action, where: 'a handoff participant' });
      }
      continue;
    }
    if (d.target === 'handoff_peer' && !argTargets?.get(d)?.length) {
      return { ok: false, reason: 'no_grant', message: 'This handoff target or metadata is unavailable or unsafe.' };
    }
    for (const target of resolveTargets(agentId, d, wire, args, argTargets)) {
      if ((d.target === 'action_group_project' || d.requiresGroupMembership) && target.groupRole !== 'member') {
        return { ok: false, reason: 'no_grant', message: 'You must be a current member of this group project to manage its Actions.', action: 'group_project.admin', targetKind: 'group_project' };
      }
      for (const action of d.actions) {
        const decision = evaluateGrant({ caller, action, target }, grants);
        if (decision.outcome === 'refuse') return { ok: false, reason: decision.reason, message: refusalMessage(decision.reason, action, target), action, targetKind: target.kind };
        if (decision.outcome === 'ask' && !d.askHandledByTool) asks.push({ action, where: whereText(target) });
      }
    }
  }
  if (asks.length > 0) {
    return { ok: false, reason: 'ask_first', asks, message: 'This call needs the user\'s approval first.' };
  }
  return OK;
}

/**
 * Whether a running agent holds a grant for this action on this target, as a
 * call would be checked. For work Clubhouse does on an agent's behalf outside
 * a tool call: routing a helper's question to its orchestrator, or polling a
 * group project's board.
 */
export function holdsGrant(agentId: string, action: GrantAction, target: GrantCallTarget): boolean {
  return decideGrant(agentId, action, target).outcome === 'allow';
}

/** As holdsGrant, with the whole decision: allow, ask first, or refuse. */
export function decideGrant(agentId: string, action: GrantAction, target: GrantCallTarget): GrantDecision {
  return evaluateGrant({ caller: callerOf(agentId), action, target }, callerGrants(agentId));
}

/**
 * Permissions as an agent may pass them on, through a helper template or a
 * template it creates an agent from (#2971): never more than it holds (fixed
 * rule 2). Each entry is capped, not dropped, since dropping one would leave
 * the new agent at its default, which can be more: Allow becomes Ask first
 * where the holder only has Ask first, and Off where it has neither; Off always
 * passes. `elsewhere`: the new agent is in another project, so its own project
 * counts as one the holder needs on any project.
 */
export function capToHolder<T extends { action: GrantAction; target: Grant['target']; mode: 'off' | 'ask' | 'allow' | null }>(
  holderId: string,
  grants: readonly T[],
  options: { elsewhere?: boolean } = {},
): T[] {
  const held = callerGrants(holderId);
  const rank = { off: 0, ask: 1, allow: 2 } as const;
  return grants.map((g) => {
    if (g.mode === 'off' || g.mode === null) return g;
    const target = options.elsewhere && g.target.kind === 'project' && g.target.project === 'own' ? { kind: 'project' as const, project: 'any' as const } : g.target;
    const best = held
      .filter((h) => h.action === g.action && widerOrSame(h.target, target))
      .reduce<'off' | 'ask' | 'allow'>((m, h) => (rank[h.mode] > rank[m] ? h.mode : m), 'off');
    return rank[best] >= rank[g.mode] ? g : { ...g, mode: best };
  });
}
