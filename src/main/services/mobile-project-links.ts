import { createHash } from 'crypto';
import type { MobileProjectLinkGroup } from '../../shared/mobile-control';
import { projectLinksStore, type ProjectLinksStore } from './project-links-store';
import { projectRefKey } from '../../shared/project-links';

export const MOBILE_PROJECT_LINKS_EVENT = 'project-links:changed';
/** Display-only groups from the shared replica, never inferred from remotes. */
export function mobileProjectLinks(store: ProjectLinksStore = projectLinksStore()): MobileProjectLinkGroup[] {
  return store.groups().map((projects) => ({
    id: createHash('sha256').update(JSON.stringify(projects.map(projectRefKey))).digest('hex'),
    projects,
  }));
}
