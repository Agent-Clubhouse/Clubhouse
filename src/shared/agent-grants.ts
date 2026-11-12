import { ACCESS_LEVELS, type AccessLevel } from './agent-access';

/**
 * Agent grants (#2921, #2966): what an agent may do to other agents, to
 * projects and to the app through the Clubhouse MCP. A grant is an action on
 * a target, in a mode of Allow or Ask first. The model is allow-only: a call
 * goes ahead only when a grant covers it, and then only if the fixed rules
 * below agree.
 *
 * Grants are a cooperative guardrail on the supported Clubhouse API. They are
 * not a sandbox: another process running as the same user can edit the files,
 * and the user's own CLI can call the same services, and neither is stopped
 * by a grant. Nothing here claims OS-level enforcement.
 *
 * Grants are separate from an agent's Access (#2761). Access is what its CLI
 * may do on the machine; grants are what it may do through Clubhouse. They
 * meet in one place: an agent can't give another agent an Access level above
 * its own (fixed rule 2).
 */

/** One verb on one kind of thing. A tool that does two things needs both. */
export const GRANT_ACTIONS = [
  // Agents
  'agent.read', // status, output, settings, helper state
  'agent.watch', // coalesced turn activity across readable agents; also needs agent.read on each
  'agent.message', // put text in front of an agent
  'agent.wake',
  'agent.sleep',
  'agent.reset', // clear or compact its context
  'agent.restart', // stop and start again, possibly mid-turn (#2855): not the same as wake or sleep
  'agent.display', // name, color, icon
  'agent.configure', // how it runs: provider, model, effort, auto-sleep
  'agent.create', // the target is the project it's created in
  'agent.dispose', // remove an agent and its worktree
  'agent.grant', // what an agent can do or reach: Access, helper policy, MCP servers, skills, instructions, its grants
  'memory.write', // the Dispatcher's controller writes its own memory through write_memory
  // Connections and group projects
  'connection.manage',
  'connection.bootstrap',
  'group_project.read',
  'group_project.post',
  'group_project.admin',
  // Projects
  'project.read',
  'project.add', // add or open a project (#3050): the target is the folder, which may not be a project yet
  'project.display',
  'project.configure', // how agents in it run: defaults
  // The managed agents library (#2819): shared parts and templates. Edits reach every agent using them.
  'library.read',
  'library.write',
  'template.write',
  'template.push',
  // The app
  'settings.app.read',
  'settings.app.write',
  'app.update', // request an update; applying always needs a person's one-time approval
  'action.read', // Actions (#2918)
  'action.write',
  'action.run',
  'user.notify',
  'models.read',
  'browser.read',
  'browser.act',
  'grant.request', // ask for a grant for itself
  // Annex Network (#3068): this machine's devices. No action lets an agent finish a pairing.
  'device.read', // names, and whether each is online
  'device.manage', // rename, reconnect, remove, and start adding one (a person finishes it)
] as const;

export type GrantAction = (typeof GRANT_ACTIONS)[number];

/**
 * Who or what a grant covers, from the caller's point of view.
 * - `self`; `parent`: a helper's orchestrator; `my_helpers`: direct helpers only.
 * - `connected`: agents the caller sends to on a connection. For the
 *   Dispatcher, agents with Connect to Dispatcher on.
 * - `project`: `own` (the caller's project), `any`, or one project by path.
 *   For `project.add` the path is the folder being added, which isn't a
 *   Clubhouse project yet; `own` never covers it (there's nothing to add).
 * - `group_project`: groups the caller is a `member` of (admins are members),
 *   or that it is an `admin` of.
 * - `group_members`: agents in a group project the caller administers.
 * - `app`; `any`: every target of the action's kind.
 */
export type GrantTarget =
  | { kind: 'self' }
  | { kind: 'parent' }
  | { kind: 'my_helpers' }
  /** Only the new agent created by this call, never an existing agent. */
  | { kind: 'created_by_me' }
  /**
   * `excludeDispatcher`: not the Dispatcher, which nothing connected to it may reset (#2921 gap fix).
   * `onlyDispatcher`: the Dispatcher alone, which a message from a connected agent wakes (#3037).
   * `wakeOn`: only agents the caller's connection has Wake it turned on for (#3215).
   */
  | { kind: 'connected'; excludeDispatcher?: boolean; onlyDispatcher?: boolean; wakeOn?: boolean }
  /** The fixed safe surface of a Dispatcher on another computer in this Annex Network. */
  | { kind: 'remote_dispatcher' }
  | { kind: 'project'; project: 'own' | 'any' | { path: string } }
  | { kind: 'group_project'; role: 'member' | 'admin' }
  | { kind: 'group_members' }
  | { kind: 'app' }
  /** One Action (#2918), by id: an explicit grant on an Action the caller doesn't own. */
  | { kind: 'action'; id: string }
  | { kind: 'any' };

export type GrantMode = 'allow' | 'ask';

/** Where a grant comes from, shown beside it. */
export type GrantSource = 'every_agent' | 'structural' | 'template' | 'user' | 'dispatcher' | 'parent';

export interface Grant {
  action: GrantAction;
  target: GrantTarget;
  mode: GrantMode;
  source?: GrantSource;
}

/** What is known about the caller, from its bridge identity. */
export interface GrantCaller {
  /** The user's own surfaces (the app, a paired phone) are above every agent. */
  kind: 'agent' | 'user';
  agentId?: string;
  projectPath?: string;
  /** The caller's Access, for fixed rule 2. Unknown reads as Ask first. */
  access?: AccessLevel;
}

/**
 * What a call reaches, resolved against the caller by main. `relations` says
 * how a target agent stands to the caller; the rest places the target.
 */
export interface GrantCallTarget {
  kind: 'agent' | 'browser' | 'project' | 'group_project' | 'app' | 'library' | 'action';
  /** For an Action target: its id. `relations` has `self` when the caller owns it. */
  actionId?: string;
  relations?: ReadonlyArray<'self' | 'parent' | 'my_helper' | 'connected' | 'group_member' | 'created_by_me'>;
  /** The target agent is the Dispatcher. */
  isDispatcher?: boolean;
  /** Resolved by main from authenticated membership/controller discovery, never a tool argument. */
  isRemoteDispatcher?: boolean;
  /** The caller's connection to the target agent, on this computer, has Wake it on (#3215). */
  wakeOn?: boolean;
  /** The project the target agent lives in, or the project itself. */
  projectPath?: string;
  /** A group admin named an agent that isn't a member of the group (#2974): said so in the refusal. */
  notGroupMember?: boolean;
  /** For a group project target: the caller's role in it. */
  groupRole?: 'member' | 'admin' | null;
}

/** An `agent.grant` call says what it would change, so fixed rule 2 can check it. */
export interface GrantChange {
  /** The Access level the call would set on the target. */
  access?: AccessLevel;
  /** Grants the call would give the target. */
  grants?: readonly Grant[];
}

export interface GrantCall {
  caller: GrantCaller;
  action: GrantAction;
  target: GrantCallTarget;
  change?: GrantChange;
}

/** Why a call was refused. Never says whether the target exists. */
export type GrantRefusal =
  | 'no_grant' // nothing covers it
  | 'raise_self' // fixed rule 1
  | 'exceeds_caller'; // fixed rule 2

export type GrantDecision =
  | { outcome: 'allow'; grant?: Grant }
  | { outcome: 'ask'; grant: Grant }
  | { outcome: 'refuse'; reason: GrantRefusal };

export function isGrantAction(value: unknown): value is GrantAction {
  return typeof value === 'string' && (GRANT_ACTIONS as readonly string[]).includes(value);
}

/** Whether a grant's target covers what a call reaches. */
export function targetCovers(grant: GrantTarget, caller: GrantCaller, target: GrantCallTarget, action?: GrantAction): boolean {
  const rel = target.relations ?? [];
  // Existing local connections/projects must not silently authorize another machine's Dispatcher.
  if (target.isRemoteDispatcher && grant.kind !== 'remote_dispatcher' && grant.kind !== 'any') return false;
  switch (grant.kind) {
    case 'any': return true;
    case 'self': return rel.includes('self');
    case 'parent': return rel.includes('parent');
    case 'my_helpers': return rel.includes('my_helper');
    case 'created_by_me': return target.kind === 'agent' && rel.includes('created_by_me') && !target.isDispatcher;
    case 'connected':
      return rel.includes('connected') && !(grant.excludeDispatcher && target.isDispatcher) && !(grant.onlyDispatcher && !target.isDispatcher)
        && !(grant.wakeOn && !target.wakeOn);
    case 'remote_dispatcher':
      return target.kind === 'agent' && target.isDispatcher === true && target.isRemoteDispatcher === true
        && (action === undefined || action === 'agent.read' || action === 'agent.message');
    case 'group_members': return rel.includes('group_member');
    case 'app': return target.kind === 'app';
    case 'action': return target.kind === 'action' && target.actionId === grant.id;
    case 'group_project':
      if (target.kind !== 'group_project' || !target.groupRole) return false;
      return grant.role === 'member' || target.groupRole === 'admin';
    case 'project': {
      if (target.kind !== 'project' && target.kind !== 'agent') return false;
      if (action === 'project.add') {
        // Adding a project: only a project target, and only `any` or that exact folder.
        if (target.kind !== 'project' || grant.project === 'own') return false;
        if (grant.project === 'any') return true;
        return !!target.projectPath && samePath(grant.project.path, target.projectPath);
      }
      if (grant.project === 'any') return true;
      if (!target.projectPath) return false;
      if (grant.project === 'own') return !!caller.projectPath && samePath(caller.projectPath, target.projectPath);
      return samePath(grant.project.path, target.projectPath);
    }
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '');
  return norm(a) === norm(b);
}

function rank(level: AccessLevel | undefined): number {
  return ACCESS_LEVELS.indexOf(level ?? 'ask');
}

/** Whether `held` covers `given`: the same action, in a mode no weaker, on a target at least as wide. */
function holds(held: readonly Grant[], given: Grant): boolean {
  return held.some((h) => h.action === given.action
    && (h.mode === 'allow' || given.mode === 'ask')
    && widerOrSame(h.target, given.target));
}

/** Whether a held target covers everything a given one does. */
export function widerOrSame(held: GrantTarget, given: GrantTarget): boolean {
  if (held.kind === 'any') return true;
  if (held.kind !== given.kind) return false;
  if (held.kind === 'connected' && given.kind === 'connected') {
    if (held.onlyDispatcher) return !!given.onlyDispatcher;
    if (held.wakeOn && !given.wakeOn) return false;
    return !held.excludeDispatcher || !!given.excludeDispatcher;
  }
  if (held.kind === 'project' && given.kind === 'project') {
    return held.project === 'any' || JSON.stringify(held.project) === JSON.stringify(given.project);
  }
  if (held.kind === 'group_project' && given.kind === 'group_project') return held.role === 'member' || given.role === 'admin';
  if (held.kind === 'action' && given.kind === 'action') return held.id === given.id;
  return true;
}

/**
 * The one check. A user caller is above every agent (fixed rule 4). For an
 * agent, the matching grants are found (Allow wins over Ask first), and then
 * the fixed rules run; they can't be granted away:
 * 1. No raising yourself: `agent.grant` on yourself is refused. Ask for it
 *    with `grant.request` instead.
 * 2. No granting what you don't hold: `agent.grant` can't set an Access above
 *    the caller's own, or give a grant the caller doesn't hold. The tools that
 *    set Access check the level where they decide it (main's access-ceiling.ts, D126).
 * 3. (The Clubhouse MCP always runs, D69, so there is no "MCP off" rule.)
 * 4. The user is above every agent.
 * `held` is the caller's own grants, for rule 2; it defaults to `grants`.
 */
export function evaluateGrant(call: GrantCall, grants: readonly Grant[], held: readonly Grant[] = grants): GrantDecision {
  if (call.caller.kind === 'user') return { outcome: 'allow' };
  const matching = grants.filter((g) => g.action === call.action && targetCovers(g.target, call.caller, call.target, call.action));
  if (matching.length === 0) return { outcome: 'refuse', reason: 'no_grant' };
  if (call.action === 'agent.grant' && (call.target.relations ?? []).includes('self')) return { outcome: 'refuse', reason: 'raise_self' };
  if (call.action === 'agent.grant' && call.change) {
    if (call.change.access && rank(call.change.access) > rank(call.caller.access)) return { outcome: 'refuse', reason: 'exceeds_caller' };
    if (call.change.grants?.some((g) => !holds(held, g))) return { outcome: 'refuse', reason: 'exceeds_caller' };
  }
  const allow = matching.find((g) => g.mode === 'allow');
  return allow ? { outcome: 'allow', grant: allow } : { outcome: 'ask', grant: matching[0] };
}

/** The message an agent gets for a refusal. Plain, and never says whether the target exists. */
export const GRANT_REFUSAL_MESSAGES: Readonly<Record<GrantRefusal, string>> = {
  no_grant: 'You don\'t have a Clubhouse permission for this. Ask the user if you need it.',
  raise_self: 'You can\'t change your own Clubhouse permissions or Access. Ask the user if you need it.',
  exceeds_caller: 'You can\'t give another agent more than you have yourself.',
};
