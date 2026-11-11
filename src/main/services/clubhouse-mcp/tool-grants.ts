/**
 * Tool grant declarations (#2967, part of #2921): every Clubhouse MCP tool
 * says, next to its registration, which grant actions a call needs and where
 * the call's target comes from. Declarations only for now: nothing reads them
 * to allow or refuse a call yet. The evaluator (`evaluateGrant` in
 * shared/agent-grants) will resolve each declared target against the caller
 * at call time and check the actions on it.
 */

import type { GrantAction } from '../../../shared/agent-grants';

/**
 * Where a call's target comes from. A closed set: each names a place the
 * evaluator looks at call time, not a relation. How the resolved target
 * stands to the caller (self, parent, helper, connected, group member, own
 * project) is what decides which grant covers it.
 */
export const TOOL_GRANT_TARGETS = [
  /**
   * The target of the wire the tool is called through: the agent, browser
   * widget or group project the template tool was generated for.
   */
  'bound',
  /**
   * Agents in the bound group project: the one named in the arguments
   * (target_agent_id), or every member when the tool reaches them all (broadcast).
   */
  'group_members',
  /** The caller itself. */
  'self',
  /** A helper's orchestrator, the agent that started it. */
  'parent',
  /** The caller's direct helpers: the one named in the arguments, or all of them. */
  'my_helpers',
  /** The new agent this creation call will make, not an id supplied by the caller. */
  'created_by_me',
  /**
   * Every agent connected to the caller, as a set. For the Dispatcher, every
   * agent with Connect to Dispatcher on.
   */
  'connected',
  /**
   * An agent (or agents) named in the arguments, wherever it is. Tools that
   * default to the caller when it's left out say so (update_agent, read_settings).
   */
  'agent_arg',
  /**
   * A project named in the arguments. Tools that default to the caller's own
   * project when it's left out say so (update_project, start_helper, read_settings).
   * For agent.create, and agent.grant on the new agent, the project it's created in.
   */
  'project_arg',
  /** Every Clubhouse project on this machine. */
  'all_projects',
  /** The app itself: app settings, model lists, the user's attention. */
  'app',
  /** The managed agents library: shared parts and templates (#2819). */
  'library',
  /**
   * An Action (#2918) named in the arguments. The Actions module tells the
   * check who owns it (`registerActionOwnerLookup`): the caller's own Action
   * is `self`; anyone else's needs a grant on that Action, or on `any`.
   */
  'action_arg',
] as const;

export type ToolGrantTarget = (typeof TOOL_GRANT_TARGETS)[number];

/**
 * One target and the actions a call needs on it. A tool that does two things
 * declares both actions; a tool that reaches two targets has one declaration
 * per target, and a call needs every declaration that applies to it.
 */
export interface ToolGrantDeclaration {
  actions: readonly GrantAction[];
  target: ToolGrantTarget;
  /**
   * The declaration applies only to a call that passes one of these
   * arguments, such as create_managed_agent's `settings` (agent.grant) or
   * wake_agent's `message` (agent.message). Left out, it always applies.
   */
  ifArgs?: readonly string[];
  /** Applies only when one of these boolean arguments is true. */
  ifTrue?: readonly string[];
  /** Actions only: a flat source or trigger.source of {kind: 'any'}, including its default window. */
  ifAnyAgentSource?: true;
  /**
   * When one of these actions is Ask first, the tool decides itself whether
   * and how to ask, so the check lets the call reach it instead of asking
   * (#2970). start_helper and dispose_helper ask with requests of their own,
   * from the orchestrator's approval setting; hand_off never asked under it
   * (a handed-off helper's work is already taken), and still doesn't.
   */
  askHandledByTool?: true;
  /**
   * For `agent_arg` and `project_arg` (#2974): the arguments that name the
   * target, each an id, a name or a path, or a list of them. `project`: the
   * argument that places a name (an agent named in that project). `missing`:
   * what a call that names none reaches, `caller` (itself, or its own project)
   * or nothing to check. `all`: a boolean argument meaning every agent or
   * every project. `names`: where a name is looked up, in a project (the
   * default) or among the caller and its helpers. Without `from` the target
   * isn't resolved, and the tool's own checks stand alone.
   */
  from?: { args: readonly string[]; project?: string; missing?: 'caller'; all?: string; names?: 'project' | 'self_and_helpers' };
}

/**
 * A tool with no action of its own, marked so the evaluator has to decide
 * rather than read it as "needs nothing":
 * - `called_tool`: call_wire_tool. It calls a wire's tool through callTool,
 *   which checks that tool's own declaration.
 * - `plugin`: a tool a plugin contributes. Plugins get no new access (#2921),
 *   and no grant action covers them yet.
 */
export type ToolGrantPassThrough = 'called_tool' | 'plugin';

/** What a tool's registration declares. */
export type ToolGrant = ToolGrantDeclaration | readonly ToolGrantDeclaration[] | ToolGrantPassThrough;

export function isToolGrantPassThrough(grant: ToolGrant): grant is ToolGrantPassThrough {
  return typeof grant === 'string';
}

/** The declarations of a grant, as a list. A pass-through has none. */
export function toolGrantDeclarations(grant: ToolGrant): readonly ToolGrantDeclaration[] {
  if (isToolGrantPassThrough(grant)) return [];
  return Array.isArray(grant) ? grant : [grant as ToolGrantDeclaration];
}

/**
 * One line per grant, for the declaration table and logs:
 * `agent.create on project_arg; agent.grant on project_arg if settings`.
 */
export function describeToolGrant(grant: ToolGrant | undefined): string {
  if (grant === undefined) return '(none)';
  if (isToolGrantPassThrough(grant)) return `(${grant})`;
  return toolGrantDeclarations(grant)
    .map((d) => `${d.actions.join(', ')} on ${d.target}${d.ifArgs ? ` if ${d.ifArgs.join(' or ')}` : ''}${d.ifTrue ? ` if ${d.ifTrue.join(' or ')} is true` : ''}${d.ifAnyAgentSource ? ' if any-agent source' : ''}`)
    .join('; ');
}
