import { create } from 'zustand';
import type { GroupWorkspaceRoute } from './groupProjectRoute';

/**
 * What the Group Projects hub shows: every group known here, or one project's
 * view (groups verified to cover it, plus app-wide groups). Changing the view
 * never changes a group's membership or scope.
 */
export type GroupProjectsView = { kind: 'all' } | { kind: 'project'; projectId: string };

interface GroupProjectsNavState {
  /** The open group, or null for the hub. */
  route: GroupWorkspaceRoute | null;
  view: GroupProjectsView;
  query: string;
  setRoute: (route: GroupWorkspaceRoute | null) => void;
  setView: (view: GroupProjectsView) => void;
  setQuery: (query: string) => void;
}

/** Not persisted: the hub's view and query survive opening a group and coming back, within a session. */
export const useGroupProjectsNavStore = create<GroupProjectsNavState>((set) => ({
  route: null,
  view: { kind: 'all' },
  query: '',
  setRoute: (route) => set({ route }),
  setView: (view) => set({ view }),
  setQuery: (query) => set({ query }),
}));
