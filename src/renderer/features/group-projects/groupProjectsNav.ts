import { openAppView } from '../../chrome/openAppView';
import { GROUP_PROJECTS_VIEW_ID } from '../../chrome/coreAppItems';
import { useGroupProjectsNavStore, type GroupProjectsView } from './groupProjectsNavStore';
import type { GroupWorkspaceRoute } from './groupProjectRoute';

/** Open the hub in the main pane, all groups unless a view is given. The search text is kept. */
export function openGroupProjectsHub(view: GroupProjectsView = { kind: 'all' }): void {
  const nav = useGroupProjectsNavStore.getState();
  nav.setRoute(null);
  nav.setView(view);
  openAppView(GROUP_PROJECTS_VIEW_ID);
}

/** Open the hub as one project's view: groups verified to cover it, plus app-wide groups. */
export function openGroupProjectsForProject(projectId: string): void {
  openGroupProjectsHub({ kind: 'project', projectId });
}

/** Open one group's workspace (Board unless a section is named). The one route every opener uses. */
export function openGroupWorkspace(route: GroupWorkspaceRoute): void {
  useGroupProjectsNavStore.getState().setRoute({ groupId: route.groupId, ...(route.section && { section: route.section }) });
  openAppView(GROUP_PROJECTS_VIEW_ID);
}
