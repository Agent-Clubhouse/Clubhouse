import { useMemo, useRef } from 'react';
import type { Agent } from '../../../shared/types';
import { useChromeStore } from '../chromeStore';
import { sortByRecent, sortProjectsByRecent } from './treeModel';

/**
 * Projects and their agents in the order the sidebar shows them (#2116):
 * as given (the saved, manual order), or most recent activity first for
 * whichever of the two is set to Recent. The tree and the filter results both
 * use this, so they agree. In Recent, a project row counts its linked copies
 * (`members`) and its running agents on any machine (#3542).
 */
export function useSidebarOrder<P extends { id: string }>(
  projects: P[],
  agentsByProject: Record<string, Agent[]>,
  members?: Readonly<Record<string, readonly string[]>>,
): { projects: P[]; agentsByProject: Record<string, Agent[]> } {
  const projectSort = useChromeStore((s) => s.projectSort);
  const agentSort = useChromeStore((s) => s.agentSort);
  const projectActivity = useChromeStore((s) => s.projectActivity);
  const agentActivity = useChromeStore((s) => s.agentActivity);
  // Agent status events give agentsByProject a new identity without moving
  // any row; the same rows in the same order keep the same array.
  const previous = useRef<P[]>([]);
  const sortedProjects = useMemo(() => {
    const next = projectSort === 'recent' ? sortProjectsByRecent(projects, { projectActivity, members, agentsByProject, agentActivity }) : projects;
    const same = next.length === previous.current.length && next.every((p, i) => p === previous.current[i]);
    if (!same) previous.current = next;
    return previous.current;
  }, [projectSort, projects, projectActivity, members, agentsByProject, agentActivity]);
  const sortedAgents = useMemo(
    () => (agentSort === 'recent'
      ? Object.fromEntries(Object.entries(agentsByProject).map(([id, list]) => [id, sortByRecent(list, agentActivity)]))
      : agentsByProject),
    [agentSort, agentsByProject, agentActivity],
  );
  return { projects: sortedProjects, agentsByProject: sortedAgents };
}
