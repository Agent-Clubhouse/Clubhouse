/**
 * Who may have an action do what (#2918, #2960). Checked when an action is
 * created, edited or turned on, and again every time it runs.
 *
 * An action does what its owner may do (D131): each step and trigger is
 * checked against the owner's Clubhouse permissions (#2921) on its target,
 * the same grants the owner's own calls are checked against, worked out from
 * its saved settings so they apply while it sleeps:
 * - message, wake and sleep steps need agent.message, agent.wake and
 *   agent.sleep on the agent (itself, its helpers, its orchestrator, agents
 *   it is connected to, as its permissions say); a wake with a prompt needs
 *   agent.message too, and a message step wakes a sleeping agent only for an
 *   owner that may wake it (steps.ts asks wakeRefusal when it runs);
 * - a quick agent step needs agent.create on its project; quick agents from
 *   actions run at Full access (D140), so only an owner at Full access may
 *   start them, and never the Dispatcher; one in another agent's worktree
 *   needs that agent to be the owner's helper or connected to it;
 * - a notify step needs user.notify;
 * - a trigger watching an agent needs agent.read on it, a project's events
 *   project.read on it, and app events settings.app.read.
 * Ask first counts as no: nobody is there to ask when an action runs.
 * You (Settings) and Clubhouse may do anything. Per-owner caps on how many
 * actions there are stay a rule of Actions (they aren't a permission).
 *
 * A refusal names the missing permission, and reads the same whether or not
 * the agent or project exists.
 */

import { APP_EVENT_KINDS, QUICK_STEP_ACCESS, type ActionOwner, type ActionStep, type ActionTrigger } from '../../../shared/actions';
import type { ActionRights } from './engine';
import { accessLabel, type AccessLevel } from '../../../shared/agent-access';
import { evaluateGrant, type Grant, type GrantAction, type GrantCallTarget } from '../../../shared/agent-grants';

export interface RightsFacts {
  agentName(agentId: string): string | undefined;
  /** The helper's orchestrator, for helpers. */
  parentOf(agentId: string): string | undefined;
  /** A wire from `from` to `to` (Canvas wire, saved link, Dispatcher or helper link). */
  isConnected(from: string, to: string): boolean;
  agentProjectId(agentId: string): string | undefined;
  /** The Dispatcher's agent id, for its wires to the agents connected to it. */
  dispatcherAgentId(): string | undefined;
  /**
   * Whether the agent may start helpers ("Let this agent orchestrate").
   * Starting agents from an action needs at least what starting a helper does.
   */
  canStartAgents(agentId: string): boolean;
  /** The agent's own Access level (#2761): its actions start quick agents only at Full access. */
  agentAccess(agentId: string): AccessLevel;
  /** The owner's Clubhouse permissions now, from its saved settings and changes (#2921). */
  grantsOf(agentId: string): Grant[];
  /** Paths, for project permissions. */
  agentProjectPath(agentId: string): string | undefined;
  projectPath(projectId: string): string | undefined;
}

/** The most actions one owner may have. People and Clubhouse have no limit. */
export const MAX_ACTIONS = { agent: 20, helper: 5, dispatcher: 50 } as const;

export function createGrantRights(facts: RightsFacts): ActionRights {
  const ownerName = (owner: ActionOwner): string => {
    if (owner.kind === 'dispatcher') return 'The Dispatcher';
    if (owner.kind === 'agent') return facts.agentName(owner.agentId) ?? 'This agent';
    return 'Clubhouse';
  };
  const ownerId = (owner: ActionOwner): string | undefined =>
    owner.kind === 'agent' ? owner.agentId : owner.kind === 'dispatcher' ? facts.dispatcherAgentId() : undefined;

  /** How an agent stands to the owner, for its permissions. */
  const agentTarget = (owner: string, agentId: string): GrantCallTarget => {
    const relations: Array<NonNullable<GrantCallTarget['relations']>[number]> = [];
    if (agentId === owner) relations.push('self');
    if (facts.parentOf(owner) === agentId) relations.push('parent');
    if (facts.parentOf(agentId) === owner) relations.push('my_helper');
    if (facts.isConnected(owner, agentId)) relations.push('connected');
    const projectPath = facts.agentProjectPath(agentId);
    return { kind: 'agent', relations, isDispatcher: agentId === facts.dispatcherAgentId(), ...(projectPath && { projectPath }) };
  };

  /** Null when the owner holds the action with Allow on the target, else the refusal. */
  const holds = (owner: ActionOwner, action: GrantAction, target: GrantCallTarget, where: string): string | null => {
    const id = ownerId(owner);
    if (!id) return `${ownerName(owner)} can\u2019t ${where}.`;
    const projectPath = facts.agentProjectPath(id);
    const decision = evaluateGrant({ caller: { kind: 'agent', agentId: id, ...(projectPath && { projectPath }) }, action, target }, facts.grantsOf(id));
    if (decision.outcome === 'allow') return null;
    const why = decision.outcome === 'ask' ? ' It\u2019s set to Ask first, and an action runs with nobody there to ask.' : '';
    return `${ownerName(owner)} doesn\u2019t have the Clubhouse permission ${action} ${where}.${why} Change it on its Clubhouse permissions page.`;
  };

  const STEP_ACTION: Record<'message' | 'wake' | 'sleep', GrantAction> = { message: 'agent.message', wake: 'agent.wake', sleep: 'agent.sleep' };

  return {
    checkStep(owner: ActionOwner, step: ActionStep): string | null {
      if (owner.kind === 'user' || owner.kind === 'app') return null;
      if (step.kind === 'notify') return holds(owner, 'user.notify', { kind: 'app' }, 'to notify you');
      const id = ownerId(owner);
      if (step.kind === 'quick') {
        // D140: quick agents from actions run at Full access. The Dispatcher's actions never start them.
        if (owner.kind === 'dispatcher') return 'The Dispatcher can\u2019t start quick agents from an action.';
        if (!id) return `${ownerName(owner)} can\u2019t start quick agents.`;
        if (!facts.canStartAgents(id)) return `${ownerName(owner)} can\u2019t start agents, so its actions can\u2019t start quick agents. Turn on "Let this agent orchestrate" for it first.`;
        const ownProject = facts.agentProjectId(id);
        if (!ownProject || step.projectId !== ownProject) return `${ownerName(owner)} can\u2019t start agents in that project.`;
        // A worktree in another project would run there, outside the agent's project. In its own
        // project, only the worktree of an agent it works with: itself, its helper, or one connected to it.
        if (step.worktreeAgentId) {
          const relations = agentTarget(id, step.worktreeAgentId).relations ?? [];
          const worksWith = relations.some((rel) => rel === 'self' || rel === 'my_helper' || rel === 'connected');
          if (facts.agentProjectId(step.worktreeAgentId) !== ownProject || !worksWith) return `${ownerName(owner)} can\u2019t use that agent\u2019s worktree.`;
        }
        const projectPath = facts.projectPath(step.projectId);
        const refused = holds(owner, 'agent.create', { kind: 'project', ...(projectPath && { projectPath }) }, 'in that project');
        if (refused) return refused;
        const level = facts.agentAccess(id);
        if (level !== QUICK_STEP_ACCESS) {
          return `Agent steps run with ${accessLabel(QUICK_STEP_ACCESS)}, and ${ownerName(owner)} runs at ${accessLabel(level)}, so its actions can\u2019t start quick agents.`;
        }
        return null;
      }
      if (!id) return `${ownerName(owner)} can\u2019t act on that agent.`;
      // The Dispatcher's actions tell it things (#3042); they never put it to sleep.
      if (owner.kind === 'dispatcher' && step.kind === 'sleep' && step.agentId === id) return 'The Dispatcher\u2019s actions can\u2019t put it to sleep.';
      const target = agentTarget(id, step.agentId);
      // A wake with a prompt also delivers it, as wake_agent's message does.
      if (step.kind === 'wake' && step.prompt) return holds(owner, 'agent.wake', target, 'on that agent') ?? holds(owner, 'agent.message', target, 'on that agent');
      return holds(owner, STEP_ACTION[step.kind], target, 'on that agent');
    },

    checkSource(owner: ActionOwner, trigger: ActionTrigger): string | null {
      if (owner.kind === 'user' || owner.kind === 'app') return null;
      if (trigger.kind !== 'event') return null;
      const id = ownerId(owner);
      if (!id) return `${ownerName(owner)} can\u2019t watch that.`;
      const source = trigger.source;
      if (source.kind === 'agent') return holds(owner, 'agent.read', agentTarget(id, source.agentId), 'on that agent');
      // App events (Clubhouse starts, a project is added or removed) say nothing private.
      if (source.kind === 'app' || (APP_EVENT_KINDS.includes(trigger.event) && owner.kind === 'dispatcher')) {
        return holds(owner, 'settings.app.read', { kind: 'app' }, 'to watch app events');
      }
      const projectPath = facts.projectPath(source.projectId);
      return holds(owner, 'project.read', { kind: 'project', ...(projectPath && { projectPath }) }, 'on that project');
    },

    maxActions(owner: ActionOwner): number | null {
      if (owner.kind === 'dispatcher') return MAX_ACTIONS.dispatcher;
      if (owner.kind === 'agent') return owner.helper ? MAX_ACTIONS.helper : MAX_ACTIONS.agent;
      return null;
    },
  };
}
