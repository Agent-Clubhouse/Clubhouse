/**
 * The skills a provider reported loaded for an agent's current chat session
 * (#2863, #2929). Only a report bound to this agent, its effective provider and
 * its exact session counts. A file on disk never stands in for one.
 */
import type { Agent } from '../../../../shared/types';
import type { ChatViewState } from '../../../stores/chatStore';

export type ProviderSkillsReport = NonNullable<ChatViewState['providerSkills']>;

export interface ReportedSkills {
  /** This provider and session can report skills at all. */
  supported: boolean;
  /** The report for this session, when one arrived. Its `names` is null when it was missing or invalid. */
  report: ProviderSkillsReport | null;
}

/** The provider an agent runs on: its own choice, else its project's default. Null while the project is unknown. */
export function effectiveProviderOf(agent: Pick<Agent, 'orchestrator'>, project: { orchestrator?: string } | undefined): string | null {
  return agent.orchestrator || (project ? project.orchestrator || 'claude-code' : null);
}

export function reportedSkillsFor(
  agent: Pick<Agent, 'id' | 'orchestrator'>,
  chat: ChatViewState | null | undefined,
  project: { orchestrator?: string } | undefined,
): ReportedSkills {
  if (!chat || chat.agentId !== agent.id) return { supported: false, report: null };
  const provider = effectiveProviderOf(agent, project);
  const supported = provider !== null && provider === chat.provider && chat.provider === 'claude-code';
  const r = chat.providerSkills;
  const report = supported && r && r.sessionId === chat.sessionId && r.driver === chat.driver && r.nativeSessionId === chat.nativeSessionId ? r : null;
  return { supported, report };
}

/**
 * What a row in the agent's Skills list may say about a skill found on disk:
 * loaded only when the provider's report names it (by folder or SKILL.md
 * name), else not confirmed. `null` names (no valid report) confirm nothing.
 */
export function loadedState(skill: { name: string; skillName?: string }, names: string[] | null | undefined): 'reported' | 'not-confirmed' {
  if (!names) return 'not-confirmed';
  return names.includes(skill.name) || (!!skill.skillName && names.includes(skill.skillName)) ? 'reported' : 'not-confirmed';
}
