import type { Grant, GrantAction, GrantMode, GrantSource, GrantTarget } from './agent-grants';
import type { OrchestrationControl } from './orchestration-policy';

/**
 * Default grants (#2921, #2968): today's behavior as grants, from structural
 * facts about the caller. Grants add up. Built-in templates will carry these
 * once the Builder's permissions tab lands (#2971); until then they are the
 * whole set.
 *
 * Two of the epic's defaults wait for directed connections (#2969), so nothing
 * that works on a canvas wire today stops before there's a way to grant it
 * back: every agent keeps `agent.reset` on agents it is connected to. What
 * changes now are the epic's two gap fixes: a helper reaches its orchestrator
 * only to message it, and nothing connected to the Dispatcher can reset it.
 */
export interface GrantCallerFacts {
  dispatcher: boolean;
  /**
   * The Dispatcher's chat (#3036). It has no permissions of its own: it reads,
   * and hands every action to the Dispatcher. Its grants replace all others.
   */
  dispatcherChat?: boolean;
  /** Has an orchestrator. */
  helper: boolean;
  /** "Let this agent orchestrate" is on. */
  orchestrates: boolean;
  /** Cross-project helpers is on (with orchestration). */
  crossProject: boolean;
  /**
   * The orchestrator's approval setting (#2970). It sets Ask first or Allow on
   * starting helpers (`agent.create`) and disposing them (`agent.dispose`).
   * Left out, both allow (hands-off).
   */
  control?: OrchestrationControl;
}

/** The modes an orchestrator's approval setting gives its start and dispose grants (#2970). */
export function controlGrantModes(control: OrchestrationControl): { create: GrantMode; dispose: GrantMode } {
  switch (control) {
    case 'hands-off': return { create: 'allow', dispose: 'allow' };
    case 'ask-before-start': return { create: 'ask', dispose: 'allow' };
    case 'ask-everything': return { create: 'ask', dispose: 'ask' };
  }
}

/**
 * The approval setting a pair of start and dispose modes stands for: the other
 * direction of controlGrantModes. Asking before a dispose but not a start has
 * no setting of its own, so it reads as asking for both, the nearer of the two
 * that asks at least as much.
 */
export function controlFromGrantModes(modes: { create: GrantMode; dispose: GrantMode }): OrchestrationControl {
  if (modes.dispose === 'ask') return 'ask-everything';
  return modes.create === 'ask' ? 'ask-before-start' : 'hands-off';
}

const g = (source: GrantSource) => (action: GrantAction, target: GrantTarget, mode: Grant['mode'] = 'allow'): Grant => ({ action, target, mode, source });

const SELF: GrantTarget = { kind: 'self' };
const CONNECTED: GrantTarget = { kind: 'connected' };
const HELPERS: GrantTarget = { kind: 'my_helpers' };
const OWN_PROJECT: GrantTarget = { kind: 'project', project: 'own' };
const ANY_PROJECT: GrantTarget = { kind: 'project', project: 'any' };
const APP: GrantTarget = { kind: 'app' };
const ANY: GrantTarget = { kind: 'any' };

/**
 * The Dispatcher's chat (#3036): reading only, `agent.message` on itself,
 * which is how it hands work to the Dispatcher (one identity, two agents), and
 * `agent.wake` on the Dispatcher alone, so a hand-off wakes it (#3037).
 * Nothing that acts on another agent, a project, an Action or a setting.
 */
function dispatcherChatGrants(): Grant[] {
  const structural = g('structural');
  return [
    structural('agent.read', SELF), structural('agent.read', CONNECTED), structural('agent.read', ANY),
    structural('agent.message', SELF),
    structural('agent.wake', { kind: 'connected', onlyDispatcher: true }),
    structural('project.read', ANY_PROJECT),
    structural('settings.app.read', APP), structural('models.read', APP), structural('action.read', APP),
  ];
}

export function defaultGrants(facts: GrantCallerFacts): Grant[] {
  if (facts.dispatcherChat) return dispatcherChatGrants();
  const every = g('every_agent');
  const structural = g('structural');
  const out: Grant[] = [
    every('agent.read', SELF), every('agent.display', SELF),
    // On itself: what an agent's own Actions need to remind it, wake it or put it to sleep (#2960).
    // No tool reaches an agent's own runtime this way, so this opens nothing else.
    every('agent.message', SELF), every('agent.wake', SELF), every('agent.sleep', SELF),
    every('agent.read', CONNECTED), every('agent.message', CONNECTED),
    every('agent.reset', { kind: 'connected', excludeDispatcher: true }),
    // A message to a sleeping Dispatcher wakes it to deliver the message (#3037).
    every('agent.wake', { kind: 'connected', onlyDispatcher: true }),
    // wake_agent on a connection on this computer whose Wake it switch is on (#3215): on for a new
    // connection (2026-11-09), so this grant's Ask first or Off is what holds wake back by default.
    every('agent.wake', { kind: 'connected', wakeOn: true }),
    every('browser.read', CONNECTED), every('browser.act', CONNECTED),
    every('project.read', OWN_PROJECT), every('project.display', OWN_PROJECT),
    every('group_project.read', { kind: 'group_project', role: 'member' }),
    every('group_project.post', { kind: 'group_project', role: 'member' }),
    every('group_project.admin', { kind: 'group_project', role: 'admin' }),
    every('agent.message', { kind: 'group_members' }), every('agent.wake', { kind: 'group_members' }),
    every('agent.sleep', { kind: 'group_members' }), every('agent.reset', { kind: 'group_members' }),
    every('settings.app.read', APP), every('user.notify', APP), every('models.read', APP),
    every('grant.request', SELF),
    // Actions (#2918): every agent reads all of them and creates its own (the app); it changes
    // and runs only its own. A person's Action, or another agent's, needs a grant on it.
    every('action.read', APP), every('action.write', APP),
    every('action.write', SELF), every('action.run', SELF),
  ];
  if (facts.helper) out.push(structural('agent.message', { kind: 'parent' }));
  if (facts.orchestrates && !facts.dispatcher) {
    // The approval setting decides whether starts and disposes ask first (#2970).
    // start_helper and dispose_helper ask themselves, with their own requests.
    const modes = controlGrantModes(facts.control ?? 'hands-off');
    for (const a of ['agent.read', 'agent.message', 'agent.wake', 'agent.sleep', 'agent.reset', 'agent.display'] as const) {
      out.push(structural(a, HELPERS));
    }
    out.push(structural('agent.dispose', HELPERS, modes.dispose));
    // What it passes to its helpers at start_helper, never more than it holds (fixed rule 2).
    out.push(structural('agent.create', OWN_PROJECT, modes.create), structural('connection.manage', HELPERS), structural('connection.manage', SELF), structural('agent.grant', HELPERS));
    // The parts and templates start_helper can name, read with list_agent_templates and list_agent_parts (#3001).
    out.push(structural('library.read', ANY));
    if (facts.crossProject) out.push(structural('agent.create', ANY_PROJECT, modes.create), structural('project.read', ANY_PROJECT));
  }
  if (facts.dispatcher) {
    // Broad power over agents; the maintainer kept the builder's v1 reach (any agent, any project).
    for (const a of ['agent.read', 'agent.message', 'agent.wake', 'agent.sleep', 'agent.reset', 'agent.display', 'agent.configure', 'connection.manage'] as const) {
      out.push(structural(a, CONNECTED));
    }
    for (const a of ['agent.read', 'agent.display', 'agent.grant', 'agent.restart', 'library.read', 'library.write', 'template.write', 'template.push', 'action.read', 'action.write', 'action.run'] as const) {
      out.push(structural(a, ANY));
    }
    // Creating agents and connections replaces #2576's no-create rule (#3034, #3050). Adding or opening
    // a project, changing project defaults and changing app settings ask first.
    out.push(
      structural('agent.create', ANY_PROJECT), structural('project.read', ANY_PROJECT), structural('project.display', ANY_PROJECT),
      structural('project.add', ANY_PROJECT, 'ask'),
      structural('project.configure', ANY_PROJECT, 'ask'), structural('settings.app.write', APP, 'ask'),
      // Deleting an agent (delete_agent, #3182) asks first: each call waits in Needs you.
      structural('agent.dispose', ANY, 'ask'),
      structural('connection.bootstrap', { kind: 'created_by_me' }, 'ask'),
      // The Annex Network's devices (#3068): it sees them, and asks before it changes any.
      structural('device.read', APP), structural('device.manage', APP, 'ask'),
    );
  }
  return out;
}
