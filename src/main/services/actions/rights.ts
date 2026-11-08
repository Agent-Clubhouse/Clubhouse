/**
 * Who may have an action do what (#2918). Checked when an action is created
 * or edited, and again on every run.
 *
 * Interim rule until the permission model's grants land (#2921, action.*):
 * - You, the Dispatcher and Clubhouse may do any step.
 * - An agent's actions may act on itself, its own helpers, and agents it is
 *   connected to (an MCP wire from it to them). A quick agent may start only
 *   in its own project.
 * - A helper's actions may act only on itself, plus notify you.
 * - Anyone may notify you; it follows Settings > Notifications & alerts.
 */

import type { ActionOwner, ActionStep } from '../../../shared/actions';
import type { ActionRights } from './engine';

export interface RightsFacts {
  agentName(agentId: string): string | undefined;
  /** The helper's orchestrator, for helpers. */
  parentOf(agentId: string): string | undefined;
  /** A wire from `from` to `to` (Canvas wire, saved link, Dispatcher or helper link). */
  isConnected(from: string, to: string): boolean;
  agentProjectId(agentId: string): string | undefined;
}

function targetOf(step: ActionStep): string | undefined {
  if (step.kind === 'quick') return step.worktreeAgentId;
  if (step.kind === 'notify') return undefined;
  return step.agentId;
}

const VERB: Record<ActionStep['kind'], string> = {
  wake: 'wake',
  message: 'message',
  sleep: 'put to sleep',
  quick: 'start a quick agent in the worktree of',
  notify: 'notify',
};

export function createInterimRights(facts: RightsFacts): ActionRights {
  return {
    checkStep(owner: ActionOwner, step: ActionStep): string | null {
      if (owner.kind !== 'agent') return null;
      if (step.kind === 'notify') return null;
      const self = owner.agentId;
      const who = facts.agentName(self) ?? 'This agent';
      const target = targetOf(step);

      if (step.kind === 'quick') {
        const ownProject = facts.agentProjectId(self);
        if (owner.helper) return `${who} is a helper, so its actions can only act on itself.`;
        if (!ownProject || step.projectId !== ownProject) return `${who} can only start quick agents in its own project.`;
        if (!target) return null;
      }
      if (!target || target === self) return null;
      const targetName = facts.agentName(target) ?? 'that agent';
      if (owner.helper) return `${who} is a helper, so its actions can only act on itself.`;
      if (facts.parentOf(target) === self) return null;
      if (facts.isConnected(self, target)) return null;
      return `${who} can no longer ${VERB[step.kind]} ${targetName}.`;
    },
  };
}
