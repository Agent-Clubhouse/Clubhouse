import type { Grant, GrantAction, GrantSource, GrantTarget } from './agent-grants';

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
  /** Has an orchestrator. */
  helper: boolean;
  /** "Let this agent orchestrate" is on. */
  orchestrates: boolean;
  /** Cross-project helpers is on (with orchestration). */
  crossProject: boolean;
}

const g = (source: GrantSource) => (action: GrantAction, target: GrantTarget, mode: Grant['mode'] = 'allow'): Grant => ({ action, target, mode, source });

const SELF: GrantTarget = { kind: 'self' };
const CONNECTED: GrantTarget = { kind: 'connected' };
const HELPERS: GrantTarget = { kind: 'my_helpers' };
const OWN_PROJECT: GrantTarget = { kind: 'project', project: 'own' };
const ANY_PROJECT: GrantTarget = { kind: 'project', project: 'any' };
const APP: GrantTarget = { kind: 'app' };
const ANY: GrantTarget = { kind: 'any' };

export function defaultGrants(facts: GrantCallerFacts): Grant[] {
  const every = g('every_agent');
  const structural = g('structural');
  const out: Grant[] = [
    every('agent.read', SELF), every('agent.display', SELF),
    every('agent.read', CONNECTED), every('agent.message', CONNECTED),
    every('agent.reset', { kind: 'connected', excludeDispatcher: true }),
    every('browser.read', CONNECTED), every('browser.act', CONNECTED),
    every('project.read', OWN_PROJECT), every('project.display', OWN_PROJECT),
    every('group_project.read', { kind: 'group_project', role: 'member' }),
    every('group_project.post', { kind: 'group_project', role: 'member' }),
    every('group_project.admin', { kind: 'group_project', role: 'admin' }),
    every('agent.message', { kind: 'group_members' }), every('agent.wake', { kind: 'group_members' }),
    every('agent.sleep', { kind: 'group_members' }), every('agent.reset', { kind: 'group_members' }),
    every('settings.app.read', APP), every('user.notify', APP), every('models.read', APP),
    every('grant.request', SELF),
    // Actions (#2918) declare the app; each agent reaches only its own, which the Action tools check.
    every('action.read', APP), every('action.write', APP), every('action.run', APP),
  ];
  if (facts.helper) out.push(structural('agent.message', { kind: 'parent' }));
  if (facts.orchestrates && !facts.dispatcher) {
    for (const a of ['agent.read', 'agent.message', 'agent.wake', 'agent.sleep', 'agent.reset', 'agent.dispose', 'agent.display'] as const) {
      out.push(structural(a, HELPERS));
    }
    // What it passes to its helpers at start_helper, never more than it holds (fixed rule 2).
    out.push(structural('agent.create', OWN_PROJECT), structural('connection.manage', HELPERS), structural('connection.manage', SELF), structural('agent.grant', HELPERS));
    if (facts.crossProject) out.push(structural('agent.create', ANY_PROJECT), structural('project.read', ANY_PROJECT));
  }
  if (facts.dispatcher) {
    // Broad power over agents; the maintainer kept the builder's v1 reach (any agent, any project).
    for (const a of ['agent.read', 'agent.message', 'agent.wake', 'agent.sleep', 'agent.reset', 'agent.display', 'agent.configure', 'connection.manage'] as const) {
      out.push(structural(a, CONNECTED));
    }
    for (const a of ['agent.read', 'agent.display', 'agent.grant', 'agent.restart', 'library.read', 'library.write', 'template.write', 'template.push', 'action.read', 'action.write', 'action.run'] as const) {
      out.push(structural(a, ANY));
    }
    out.push(
      structural('agent.create', ANY_PROJECT), structural('project.read', ANY_PROJECT), structural('project.display', ANY_PROJECT),
      structural('project.configure', ANY_PROJECT, 'ask'), structural('settings.app.write', APP, 'ask'),
    );
  }
  return out;
}
