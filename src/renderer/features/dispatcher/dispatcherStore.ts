import { create } from 'zustand';
import type { Agent } from '../../../shared/types';
import { findSenderAgent, type MessageSender } from '../../../shared/chat';
import { DISPATCHER_PROJECT_ID, type DispatcherState } from '../../../shared/dispatcher-types';
import { DEFAULT_DISPATCHER_BEHAVIOR, type DispatcherBehavior, type DispatcherBehaviorState } from '../../../shared/dispatcher-behavior';
import { useProjectStore } from '../../stores/projectStore';

/**
 * The renderer's copy of the Dispatcher's state (#2538), kept by
 * useDispatcherSync so the sidebar, the view and the agent views read one
 * subscription. The Dispatcher isn't in projectStore (#2533): its agent runs
 * under DISPATCHER_PROJECT_ID with its folder as the project path, and
 * `project` is that pair, set while it's turned on or still running.
 *
 * The agent shown is the Dispatcher's chat (#3036), in the chat's folder. The
 * agent that holds its connections, links and grants is never loaded or shown;
 * only its id is used, for those (dispatcherWiresAgentId).
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
  /** Why its agent didn't load into the agent store, shown by the view with Retry. */
  loadError: string | null;
  /** Bumped by Retry; useDispatcherSync loads again when it changes. */
  loadAttempt: number;
  /** Setup opened again from the chat or its menu (#3047). First-run setup shows without it. */
  setupOpen: boolean;
  setSetupOpen: (open: boolean) => void;
  setState: (state: DispatcherState | null) => void;
  setLoadError: (error: string | null) => void;
  retryLoad: () => void;
}

export const useDispatcherStore = create<DispatcherStoreState>((set, get) => ({
  state: null,
  project: null,
  loadError: null,
  loadAttempt: 0,
  setupOpen: false,
  setSetupOpen: (setupOpen) => set({ setupOpen }),
  setState: (state) => {
    const path = (state?.enabled || state?.running) && state.chatAgentId ? state.chatPath : null;
    // Keep the same object while the folder is the same, so selectors stay stable.
    const current = get().project;
    const project = !path ? null : current?.path === path ? current : { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path };
    set({ state, project });
  },
  setLoadError: (loadError) => set({ loadError }),
  retryLoad: () => set((s) => ({ loadError: null, loadAttempt: s.loadAttempt + 1 })),
}));

export function isDispatcherProjectId(projectId: string | null | undefined): boolean {
  return projectId === DISPATCHER_PROJECT_ID;
}

/**
 * Whether this is the Dispatcher's agent: either of its two (#3036). Its id
 * decides, so a record that came into the store with the wrong projectId (an
 * update-restart resume before the Dispatcher's state loaded, #2552) is still
 * recognised.
 */
export function isDispatcherAgent(agent: Pick<Agent, 'id' | 'projectId'> | null | undefined): boolean {
  if (!agent) return false;
  if (agent.projectId === DISPATCHER_PROJECT_ID) return true;
  const state = useDispatcherStore.getState().state;
  return !!state && (agent.id === state.chatAgentId || agent.id === state.agentId);
}

/**
 * A chat message sender's agent record (findSenderAgent), except that either
 * Dispatcher agent is the Dispatcher's chat agent: its controller has no
 * picture of its own and isn't the name the user knows it by.
 */
export function findChatSenderAgent<T extends { name: string }>(
  sender: MessageSender | undefined,
  agents: Record<string, T>,
  state: Pick<DispatcherState, 'agentId' | 'chatAgentId'> | null = useDispatcherStore.getState().state,
): T | undefined {
  const id = sender?.agentId;
  if (id && state?.chatAgentId && (id === state.chatAgentId || id === state.agentId)) {
    return agents[state.chatAgentId] ?? findSenderAgent(sender, agents);
  }
  return findSenderAgent(sender, agents);
}

/** The id of the agent shown as the Dispatcher (its chat), whatever state it is in. */
export function visibleDispatcherAgentId(): string | null {
  return useDispatcherStore.getState().state?.chatAgentId ?? null;
}

/** Requests from the hidden controller belong to the visible Dispatcher. */
export function visibleRequestAgentId(
  agentId: string,
  state: Pick<DispatcherState, 'agentId' | 'chatAgentId'> | null,
): string {
  return agentId === state?.agentId && state.chatAgentId ? state.chatAgentId : agentId;
}

/**
 * The id the Dispatcher's wires, links and grants are on, for an agent shown
 * as the Dispatcher. Any other agent's own id.
 */
export function dispatcherWiresAgentId(agent: Pick<Agent, 'id' | 'projectId'>): string {
  if (!isDispatcherAgent(agent)) return agent.id;
  return useDispatcherStore.getState().state?.agentId ?? agent.id;
}

/** The id of the agent shown as the Dispatcher while it's turned on or still running. */
export function useDispatcherAgentId(): string | null {
  return useDispatcherStore((s) => (s.project ? s.state?.chatAgentId ?? null : null));
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

/**
 * The Dispatcher's Behavior (#3045) as main last reported it: the level, its
 * provider and whether Auto gives that level its models. Null until the first
 * state lands. The composer chip and Settings both read main's state, so they
 * stay in step.
 */
export function useDispatcherBehavior(): DispatcherBehaviorState | null {
  return useDispatcherStore((s) => s.state?.behavior ?? null);
}

/** Whether the user chooses the Dispatcher's models (#3191), so Behavior sets only its frequencies. */
export function useDispatcherModelsByHand(): boolean {
  return useDispatcherStore((s) => s.state?.models?.byHand ?? false);
}

/** The current Behavior level, for code outside React (the group chat, #3043). Standard until the state lands. */
export function dispatcherBehaviorLevel(): DispatcherBehavior {
  return useDispatcherStore.getState().state?.behavior?.level ?? DEFAULT_DISPATCHER_BEHAVIOR;
}
