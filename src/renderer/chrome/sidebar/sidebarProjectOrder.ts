import { partitionIdle } from '../projectActivity';
import { orderProjects, sortByRecent } from './treeModel';
import type { SidebarSort } from '../chromeStore';

export interface SidebarOrderState {
  projectSort: SidebarSort;
  projectActivity: Readonly<Record<string, number>>;
  pinnedProjectIds: readonly string[];
  inactiveProjectIds: readonly string[];
  idleDays: number;
}

/**
 * Projects in the order the new sidebar lists them (#2447): sorted manually or
 * by recent activity, pinned first, then active, then idle or inactive. The
 * tree renders these groups; pickers elsewhere (canvas cards) use the flat
 * order so the same project is in the same place.
 */
export function sidebarProjectGroups<P extends { id: string }>(
  projects: readonly P[],
  state: SidebarOrderState,
  context: { runningIds: ReadonlySet<string>; activeProjectId: string | null; now: number },
): { pinned: P[]; active: P[]; idle: P[] } {
  const sorted = state.projectSort === 'recent' ? sortByRecent(projects, state.projectActivity) : [...projects];
  const { pinned, rest } = orderProjects(sorted, state.pinnedProjectIds);
  const { active, idle } = partitionIdle(rest, {
    activity: state.projectActivity, pinnedIds: state.pinnedProjectIds, runningIds: context.runningIds,
    activeProjectId: context.activeProjectId, idleDays: state.idleDays, now: context.now, inactiveIds: state.inactiveProjectIds,
  });
  return { pinned, active, idle };
}

export function sidebarProjectOrder<P extends { id: string }>(
  projects: readonly P[],
  state: SidebarOrderState,
  context: { runningIds: ReadonlySet<string>; activeProjectId: string | null; now: number },
): P[] {
  const { pinned, active, idle } = sidebarProjectGroups(projects, state, context);
  return [...pinned, ...active, ...idle];
}
