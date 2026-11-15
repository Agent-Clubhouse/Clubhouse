import { useUIStore } from '../../stores/uiStore';
import { useGroupProjectsNavStore } from './groupProjectsNavStore';
import type { GroupWorkspaceRoute } from './groupProjectRoute';

/**
 * Open one group's workspace (Board unless a section is named). The one route
 * every opener uses.
 *
 * Stand-in until the Group Projects view (#3544) lands: that view replaces this
 * file with one that opens `plugin:app:group-projects`. Until then the route is
 * shown by Settings > Group Projects, which mounts the workspace for it.
 */
export function openGroupWorkspace(route: GroupWorkspaceRoute): void {
  useGroupProjectsNavStore.getState().setRoute({ groupId: route.groupId, ...(route.section && { section: route.section }) });
  const ui = useUIStore.getState();
  ui.setActiveHost(null);
  ui.setDispatcherOpen(false);
  ui.setSettingsContext('app');
  ui.setSettingsSubPage('group-projects');
  if (ui.explorerTab !== 'settings') ui.toggleSettings();
}
