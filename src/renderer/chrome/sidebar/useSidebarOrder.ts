import { useMemo } from 'react';
import type { Agent } from '../../../shared/types';
import { useChromeStore } from '../chromeStore';
import { sortByRecent } from './treeModel';

/**
 * Projects and their agents in the order the sidebar shows them (#2116):
 * as given (the saved, manual order), or most recent activity first for
 * whichever of the two is set to Recent. The tree and the filter results both
 * use this, so they agree.
 */
export function useSidebarOrder<P extends { id: string }>(
  projects: P[],
  agentsByProject: Record<string, Agent[]>,
): { projects: P[]; agentsByProject: Record<string, Agent[]> } {
  const projectSort = useChromeStore((s) => s.projectSort);
  const agentSort = useChromeStore((s) => s.agentSort);
  const projectActivity = useChromeStore((s) => s.projectActivity);
  const agentActivity = useChromeStore((s) => s.agentActivity);
  const sortedProjects = useMemo(
    () => (projectSort === 'recent' ? sortByRecent(projects, projectActivity) : projects),
    [projectSort, projects, projectActivity],
  );
  const sortedAgents = useMemo(
    () => (agentSort === 'recent'
      ? Object.fromEntries(Object.entries(agentsByProject).map(([id, list]) => [id, sortByRecent(list, agentActivity)]))
      : agentsByProject),
    [agentSort, agentsByProject, agentActivity],
  );
  return { projects: sortedProjects, agentsByProject: sortedAgents };
}
