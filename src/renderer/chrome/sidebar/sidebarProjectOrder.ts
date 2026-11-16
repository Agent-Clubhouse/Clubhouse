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

export interface SidebarOrderContext {
  runningIds: ReadonlySet<string>;
  activeProjectId: string | null;
  now: number;
  /** The project ids each row stands for (linked copies, other machines'); a row missing here is just itself. */
  members?: Readonly<Record<string, readonly string[]>>;
}

/**
 * A row's last activity for the idle rule: the newest of its members' (#3557),
 * the same members the Recent order uses. Only finite times count, as remote
 * values are untrusted; a row none of whose members has one has none, so it is
 * not idle yet.
 */
function rowActivity(
  projects: readonly { id: string }[],
  activity: Readonly<Record<string, number>>,
  members: SidebarOrderContext['members'],
): Record<string, number> {
  if (!members) return activity;
  const out: Record<string, number> = { ...activity };
  for (const { id } of projects) {
    const ids = members[id];
    if (!ids) continue;
    let newest: number | undefined;
    for (const member of ids) {
      const at = activity[member];
      if (typeof at === 'number' && Number.isFinite(at) && (newest === undefined || at > newest)) newest = at;
    }
    if (newest === undefined) delete out[id];
    else out[id] = newest;
  }
  return out;
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
  context: SidebarOrderContext,
): { pinned: P[]; active: P[]; idle: P[] } {
  const sorted = state.projectSort === 'recent' ? sortByRecent(projects, state.projectActivity) : [...projects];
  const { pinned, rest } = orderProjects(sorted, state.pinnedProjectIds);
  const { active, idle } = partitionIdle(rest, {
    activity: rowActivity(rest, state.projectActivity, context.members), pinnedIds: state.pinnedProjectIds, runningIds: context.runningIds,
    activeProjectId: context.activeProjectId, idleDays: state.idleDays, now: context.now, inactiveIds: state.inactiveProjectIds,
  });
  return { pinned, active, idle };
}

export function sidebarProjectOrder<P extends { id: string }>(
  projects: readonly P[],
  state: SidebarOrderState,
  context: SidebarOrderContext,
): P[] {
  const { pinned, active, idle } = sidebarProjectGroups(projects, state, context);
  return [...pinned, ...active, ...idle];
}
