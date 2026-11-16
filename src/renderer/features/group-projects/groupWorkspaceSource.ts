import { useCallback } from 'react';
import { create } from 'zustand';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { openDispatcher } from '../dispatcher/dispatcherNav';
import { openGroupWorkspace } from './groupProjectsNav';
import { useGroupProjectsNavStore } from './groupProjectsNavStore';
import type { GroupWorkspaceRoute } from './groupProjectRoute';

/**
 * Where a group's workspace was opened from (#3545). The workspace header names
 * it ("Back to Canvas") and Back returns there. Opening a group any other way,
 * from a hub row or a plain link, has no source, and Back goes to the hub.
 */
export interface GroupWorkspaceSource {
  /** What Back names: "Canvas", an agent's name. */
  label: string;
  /** Put the view the person came from back on screen. */
  restore: () => void;
  /** The route this source belongs to: a later open by another path makes a new route, so a stale source is ignored. */
  forRoute?: GroupWorkspaceRoute | null;
}

interface SourceState {
  source: GroupWorkspaceSource | null;
  setSource: (source: GroupWorkspaceSource | null) => void;
}

const useSourceStore = create<SourceState>((set) => ({ source: null, setSource: (source) => set({ source }) }));

/** Open a group's workspace and remember where the person came from. */
export function openGroupWorkspaceFrom(route: GroupWorkspaceRoute, source: Pick<GroupWorkspaceSource, 'label' | 'restore'>): void {
  openGroupWorkspace(route);
  useSourceStore.getState().setSource({ ...source, forRoute: useGroupProjectsNavStore.getState().route });
}

/** The view on screen now, as a source: Back puts the same tab, project and Dispatcher state back. */
export function currentViewSource(label: string): Pick<GroupWorkspaceSource, 'label' | 'restore'> {
  const ui = useUIStore.getState();
  const { explorerTab, dispatcherOpen } = ui;
  const projectId = useProjectStore.getState().activeProjectId ?? undefined;
  return {
    label,
    restore: () => {
      if (dispatcherOpen) openDispatcher();
      else useUIStore.getState().setExplorerTab(explorerTab, projectId);
    },
  };
}

/**
 * The source for the open route and the Back action for the workspace: both
 * the app view and the Settings page use it.
 */
export function useGroupWorkspaceBack(): { source: GroupWorkspaceSource | null; back: () => void } {
  const route = useGroupProjectsNavStore((s) => s.route);
  const stored = useSourceStore((s) => s.source);
  const source = stored && stored.forRoute === route ? stored : null;
  const back = useCallback(() => {
    useGroupProjectsNavStore.getState().setRoute(null);
    useSourceStore.getState().setSource(null);
    source?.restore();
  }, [source]);
  return { source, back };
}
