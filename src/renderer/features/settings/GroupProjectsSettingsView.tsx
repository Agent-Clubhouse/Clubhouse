import { GroupProjectsPane } from '../group-projects/GroupProjectsPane';

/** Settings > Group Projects: the same hub and workspace as the main pane, with no manager of its own (#3544). */
export function GroupProjectsSettingsView() {
  return <GroupProjectsPane surface="settings" />;
}
