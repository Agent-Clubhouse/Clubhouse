/**
 * The route to one group project's workspace (#3544, epic #3543). Everything that
 * opens a group, from a hub row to a deep link, builds this and hands it to
 * `openGroupWorkspace` (groupProjectsNav.ts). The workspace (#3545) reads it back
 * from `useGroupProjectsNavStore`, so this small module is the contract between
 * the navigation lane and the workspace lane.
 *
 * The group is always named by its stable id, never by name.
 */

/** The workspace's sections, in the order its navigation lists them. */
export const GROUP_WORKSPACE_SECTIONS = ['board', 'members', 'permissions', 'actions', 'delivery', 'canvases', 'details'] as const;
export type GroupWorkspaceSection = (typeof GROUP_WORKSPACE_SECTIONS)[number];

/** A group opened with no named section lands on its Board (epic #3543). */
export const DEFAULT_GROUP_WORKSPACE_SECTION: GroupWorkspaceSection = 'board';

export interface GroupWorkspaceRoute {
  groupId: string;
  /** Absent means the default section, Board. */
  section?: GroupWorkspaceSection;
}

export function isGroupWorkspaceSection(value: unknown): value is GroupWorkspaceSection {
  return typeof value === 'string' && (GROUP_WORKSPACE_SECTIONS as readonly string[]).includes(value);
}

/** The route with its section filled in; an unknown section falls back to the default. */
export function resolveGroupWorkspaceRoute(route: GroupWorkspaceRoute): { groupId: string; section: GroupWorkspaceSection } {
  return { groupId: route.groupId, section: isGroupWorkspaceSection(route.section) ? route.section : DEFAULT_GROUP_WORKSPACE_SECTION };
}
