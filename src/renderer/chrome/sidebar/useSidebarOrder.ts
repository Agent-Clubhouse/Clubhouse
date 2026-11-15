import { useMemo } from 'react';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { useChromeStore } from '../chromeStore';
import { projectRecency, sortByRecent } from './treeModel';

/** What the Recent project order needs beyond the store: which projects each row stands for, and agents' status times. */
export interface SidebarRecencyInput {
  members?: Readonly<Record<string, readonly string[]>>;
  detailed?: Readonly<Record<string, AgentDetailedStatus | undefined>>;
}

/**
 * Projects and their agents in the order the sidebar shows them (#2116):
 * as given (the saved, manual order), or most recent activity first for
 * whichever of the two is set to Recent. The tree and the filter results both
 * use this, so they agree. A project row's activity includes its linked
 * copies and its running agents on any machine (#3542).
 */
export function useSidebarOrder<P extends { id: string }>(
  projects: P[],
  agentsByProject: Record<string, Agent[]>,
  recency: SidebarRecencyInput = {},
): { projects: P[]; agentsByProject: Record<string, Agent[]> } {
  const projectSort = useChromeStore((s) => s.projectSort);
  const agentSort = useChromeStore((s) => s.agentSort);
  const projectActivity = useChromeStore((s) => s.projectActivity);
  const agentActivity = useChromeStore((s) => s.agentActivity);
  const { members, detailed } = recency;
  const sortedProjects = useMemo(
    () => (projectSort === 'recent'
      ? sortByRecent(projects, projectRecency(projects.map((p) => p.id), { projectActivity, members, agentsByProject, agentActivity, detailed }))
      : projects),
    [projectSort, projects, projectActivity, members, agentsByProject, agentActivity, detailed],
  );
  const sortedAgents = useMemo(
    () => (agentSort === 'recent'
      ? Object.fromEntries(Object.entries(agentsByProject).map(([id, list]) => [id, sortByRecent(list, agentActivity)]))
      : agentsByProject),
    [agentSort, agentsByProject, agentActivity],
  );
  return { projects: sortedProjects, agentsByProject: sortedAgents };
}
