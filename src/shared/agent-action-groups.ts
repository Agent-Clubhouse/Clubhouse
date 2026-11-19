/** Shared selected-agent action relationships; no stores or UI hooks. */
import type { Action, ActionView } from './actions';

export interface AgentActionGroups<T extends Action = ActionView> {
  /** Actions with a step that wakes, messages or otherwise acts on this agent. */
  targeting: T[];
  /** Actions this agent's events set off (itself, or any agent in its project). */
  triggeredBy: T[];
  /** Actions this agent made; usage counts toward it. */
  owned: T[];
}

export function agentActionGroups<T extends Action>(list: T[], agentId: string, projectId: string | undefined): AgentActionGroups<T> {
  const targets = (a: T) => a.steps.some((s) => (s.kind === 'quick' ? s.worktreeAgentId === agentId : 'agentId' in s && s.agentId === agentId));
  const triggers = (a: T) => a.trigger.kind === 'event'
    && ((a.trigger.source.kind === 'agent' && a.trigger.source.agentId === agentId)
      || (a.trigger.source.kind === 'project' && !!projectId && a.trigger.source.projectId === projectId));
  return {
    targeting: list.filter(targets),
    triggeredBy: list.filter(triggers),
    owned: list.filter((a) => a.owner.kind === 'agent' && a.owner.agentId === agentId),
  };
}

export const ACTION_RELATIONSHIPS = ['owned', 'targeting', 'triggered-by', 'dispatcher'] as const;
export const ACTION_OUTCOMES = ['running', 'done', 'failed', 'cancelled', 'skipped', 'throttled', 'expired'] as const;
export interface RemoteActionRow {
  group: typeof ACTION_RELATIONSHIPS[number];
  enabled: boolean;
  description: string;
  lastRun?: { outcome: typeof ACTION_OUTCOMES[number]; startedAt?: number };
}
