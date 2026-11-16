import type { ComponentType } from 'react';
import { GroupProjectsPane } from '../features/group-projects/GroupProjectsPane';
import { GROUP_PROJECTS_VIEW_ID } from './coreAppItems';

/** The main-pane views of the core app-row entries, by id. Consulted before any plugin's app view. */
const CORE_APP_VIEWS: Record<string, ComponentType> = {
  [GROUP_PROJECTS_VIEW_ID]: () => <GroupProjectsPane surface="main" />,
};

export function coreAppViewFor(id: string): ComponentType | null {
  return CORE_APP_VIEWS[id] ?? null;
}
