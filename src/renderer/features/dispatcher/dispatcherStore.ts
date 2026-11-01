import { create } from 'zustand';
import type { Agent } from '../../../shared/types';
import { DISPATCHER_PROJECT_ID, type DispatcherState } from '../../../shared/dispatcher-types';
import { useProjectStore } from '../../stores/projectStore';

/**
 * The renderer's copy of the Dispatcher's state (#2538), kept by
 * useDispatcherSync so the sidebar, the view and the agent views read one
 * subscription. The Dispatcher isn't in projectStore (#2533): its agent runs
 * under DISPATCHER_PROJECT_ID with its folder as the project path, and
 * `project` is that pair, set only while it's turned on.
 */

/** What agent views need of an agent's project: its id, name and folder. */
export interface LocalProject {
  id: string;
  name: string;
  path: string;
}

interface DispatcherStoreState {
  state: DispatcherState | null;
  project: LocalProject | null;
  setState: (state: DispatcherState | null) => void;
}

export const useDispatcherStore = create<DispatcherStoreState>((set, get) => ({
  state: null,
  project: null,
  setState: (state) => {
    const path = state?.enabled && state.agentId ? state.path : null;
    // Keep the same object while the folder is the same, so selectors stay stable.
    const current = get().project;
    const project = !path ? null : current?.path === path ? current : { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path };
    set({ state, project });
  },
}));

export function isDispatcherProjectId(projectId: string | null | undefined): boolean {
  return projectId === DISPATCHER_PROJECT_ID;
}

export function isDispatcherAgent(agent: Pick<Agent, 'projectId'> | null | undefined): boolean {
  return !!agent && agent.projectId === DISPATCHER_PROJECT_ID;
}

/** The Dispatcher's agent id while it's turned on. */
export function useDispatcherAgentId(): string | null {
  return useDispatcherStore((s) => (s.project ? s.state?.agentId ?? null : null));
}

/** A local project by id, or the Dispatcher's folder for its synthetic id. */
export function findLocalProject(projectId: string | undefined): LocalProject | undefined {
  if (!projectId) return undefined;
  if (isDispatcherProjectId(projectId)) return useDispatcherStore.getState().project ?? undefined;
  return useProjectStore.getState().projects.find((p) => p.id === projectId);
}

/** findLocalProject as a hook. */
export function useLocalProject(projectId: string | undefined): LocalProject | undefined {
  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
  const dispatcher = useDispatcherStore((s) => (isDispatcherProjectId(projectId) ? s.project : null));
  return project ?? dispatcher ?? undefined;
}
