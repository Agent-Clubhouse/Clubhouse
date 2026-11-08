/**
 * Who may have an action do what (#2918). Checked when an action is created,
 * edited or turned on, and again every time it runs.
 *
 * Interim rule until the permission model's grants land (#2921, action.*).
 * This file is the whole rule, so #2921 replaces it here:
 * - You (Settings) and Clubhouse may do anything.
 * - The Dispatcher's actions may wake, message and put to sleep agents
 *   connected to it, watch those agents and app events, and notify you. They
 *   can't start quick agents (#2921 gives the Dispatcher no agent.create).
 * - An agent's actions may act on itself, its own helpers and agents it is
 *   connected to (an MCP wire from it to them), and start quick agents in its
 *   own project. They may watch the same agents, its own project and app
 *   events.
 * - A helper's actions may act on and watch only itself, plus notify you.
 * - Quick agents from actions run at Full access (#3033), so an agent's
 *   actions may start them only while the agent itself runs at Full access.
 * - Anyone may notify you; it follows Settings > Notifications & alerts.
 * - Agents and the Dispatcher may own a limited number of actions.
 *
 * A refusal reads the same whether or not the agent or project exists.
 */

import { APP_EVENT_KINDS, QUICK_STEP_ACCESS, type ActionOwner, type ActionStep, type ActionTrigger } from '../../../shared/actions';
import type { ActionRights } from './engine';
import { accessLabel, type AccessLevel } from '../../../shared/agent-access';

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
}

/** The most actions one owner may have. People and Clubhouse have no limit. */
export const MAX_ACTIONS = { agent: 20, helper: 5, dispatcher: 50 } as const;

function targetOf(step: ActionStep): string | undefined {
  if (step.kind === 'quick') return step.worktreeAgentId;
  if (step.kind === 'notify') return undefined;
  return step.agentId;
}

export function createInterimRights(facts: RightsFacts): ActionRights {
  const ownerName = (owner: ActionOwner): string => {
    if (owner.kind === 'dispatcher') return 'The Dispatcher';
    if (owner.kind === 'agent') return facts.agentName(owner.agentId) ?? 'This agent';
    return 'Clubhouse';
  };
  const onAgent = (owner: ActionOwner) => `${ownerName(owner)} can’t act on that agent.`;
  const onProject = (owner: ActionOwner) => `${ownerName(owner)} can’t act on that project.`;
  const helperOnly = (owner: ActionOwner) => `${ownerName(owner)} is a helper, so its actions can only act on itself.`;

  /** Whether the owner may act on or watch this agent. */
  const reaches = (owner: ActionOwner, agentId: string): boolean => {
    if (owner.kind === 'user' || owner.kind === 'app') return true;
    if (owner.kind === 'dispatcher') {
      const dispatcher = facts.dispatcherAgentId();
      return !!dispatcher && facts.isConnected(dispatcher, agentId);
    }
    const self = owner.agentId;
    if (agentId === self) return true;
    if (owner.helper) return false;
    return facts.parentOf(agentId) === self || facts.isConnected(self, agentId);
  };

  return {
    checkStep(owner: ActionOwner, step: ActionStep): string | null {
      if (owner.kind === 'user' || owner.kind === 'app') return null;
      if (step.kind === 'notify') return null;
      if (step.kind === 'quick') {
        if (owner.kind === 'dispatcher') return 'The Dispatcher can’t start quick agents from an action yet.';
        if (owner.helper) return helperOnly(owner);
        if (!facts.canStartAgents(owner.agentId)) return `${ownerName(owner)} can’t start agents, so its actions can’t start quick agents. Turn on "Let this agent orchestrate" for it first.`;
        const ownProject = facts.agentProjectId(owner.agentId);
        if (!ownProject || step.projectId !== ownProject) return onProject(owner);
        // A worktree in another project would run there, outside the agent's project.
        if (step.worktreeAgentId && facts.agentProjectId(step.worktreeAgentId) !== ownProject) return onAgent(owner);
        const level = facts.agentAccess(owner.agentId);
        if (level !== QUICK_STEP_ACCESS) {
          return `Agent steps run with ${accessLabel(QUICK_STEP_ACCESS)}, and ${ownerName(owner)} runs at ${accessLabel(level)}, so its actions can’t start quick agents.`;
        }
      }
      const target = targetOf(step);
      if (!target || reaches(owner, target)) return null;
      return owner.kind === 'agent' && owner.helper ? helperOnly(owner) : onAgent(owner);
    },

    checkSource(owner: ActionOwner, trigger: ActionTrigger): string | null {
      if (owner.kind === 'user' || owner.kind === 'app') return null;
      if (trigger.kind !== 'event') return null;
      const helper = owner.kind === 'agent' && !!owner.helper;
      const source = trigger.source;
      if (source.kind === 'agent') {
        if (reaches(owner, source.agentId)) return null;
        return helper ? helperOnly(owner) : onAgent(owner);
      }
      if (helper) return helperOnly(owner);
      // App events (Clubhouse starts, a project is added or removed) say nothing private.
      if (APP_EVENT_KINDS.includes(trigger.event) && owner.kind === 'dispatcher') return null;
      if (source.kind === 'app') return null;
      if (owner.kind === 'agent' && facts.agentProjectId(owner.agentId) === source.projectId) return null;
      return onProject(owner);
    },

    maxActions(owner: ActionOwner): number | null {
      if (owner.kind === 'dispatcher') return MAX_ACTIONS.dispatcher;
      if (owner.kind === 'agent') return owner.helper ? MAX_ACTIONS.helper : MAX_ACTIONS.agent;
      return null;
    },
  };
}
