import { createHash } from 'crypto';
import type { MobileProjectLinksPayload } from '../../shared/mobile-control';
import { projectLinksStore, type ProjectLinksStore } from './project-links-store';
import { appLog } from './log-service';
import { projectRefKey } from '../../shared/project-links';

export const MOBILE_PROJECT_LINKS_EVENT = 'project-links:changed';
/** Display-only groups from the shared replica, never inferred from remotes. */
export const MOBILE_PROJECT_LINKS_MAX_GROUPS = 200;
export const MOBILE_PROJECT_LINKS_MAX_REFS = 2000;
export function mobileProjectLinks(store: ProjectLinksStore = projectLinksStore()): MobileProjectLinksPayload {
  const groups = store.groups();
  const projectLinks: MobileProjectLinksPayload['projectLinks'] = [];
  let refs = 0, truncated = false;
  for (const projects of groups) {
    if (projectLinks.length >= MOBILE_PROJECT_LINKS_MAX_GROUPS || refs + projects.length > MOBILE_PROJECT_LINKS_MAX_REFS) {
      truncated = true; continue;
    }
    refs += projects.length;
    projectLinks.push({ id: createHash('sha256').update(JSON.stringify(projects.map(projectRefKey))).digest('hex'), projects });
  }
  if (truncated) appLog('core:annex', 'warn', 'Mobile project links exceeded the publication budget', { meta: { groups: groups.length, publishedGroups: projectLinks.length, publishedRefs: refs } });
  return { projectLinks, ...(truncated && { projectLinksTruncated: true as const }) };
}
