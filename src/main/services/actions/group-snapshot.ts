import type { Action } from '../../../shared/actions';
import type { RemoteGroupAction } from '../../../shared/actions/view';
import type { GroupProject } from '../../../shared/group-project-types';

/** Only the authoritative host shares summaries, and only for network groups. */
export function groupActionSummaries(
  projects: GroupProject[], actions: Array<Pick<Action, 'id' | 'name' | 'owner' | 'enabled'>>,
  isHost: (project: GroupProject) => boolean,
): RemoteGroupAction[] {
  const shared = new Map(projects.filter((project) => project.scope?.reach === 'network' && isHost(project)).map((project) => [project.id, project]));
  return actions.flatMap((action) => {
    if (action.owner.kind !== 'group_project') return [];
    const project = shared.get(action.owner.groupProjectId);
    return project ? [{ id: action.id, name: action.name, groupProjectId: project.id, groupProjectName: project.name, enabled: action.enabled }] : [];
  });
}
