import { useEffect, useRef } from 'react';
import { DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { rendererLog } from '../../plugins/renderer-logger';
import { useDispatcherState } from './useDispatcherEnabled';
import { useDispatcherStore } from './dispatcherStore';

/**
 * Keeps the renderer's Dispatcher in step with main (#2538): the shared
 * state, and its agent in the agent store under DISPATCHER_PROJECT_ID with
 * its folder as the project path, loaded the way a project's agents are.
 * Turning it off drops the agent and closes its view. Mounted once, by the
 * shell.
 */
export function useDispatcherSync(): void {
  const state = useDispatcherState();
  const loadedId = useRef<string | null>(null);

  useEffect(() => {
    useDispatcherStore.getState().setState(state);
    const on = !!state?.enabled && !!state.agentId && !!state.path;
    if (!on) {
      if (loadedId.current) useAgentStore.getState().removeAgent(loadedId.current);
      loadedId.current = null;
      useUIStore.getState().setDispatcherOpen(false);
      return;
    }
    if (loadedId.current && loadedId.current !== state.agentId) useAgentStore.getState().removeAgent(loadedId.current);
    loadedId.current = state.agentId;
    // A resume that ran before this state arrived keyed the agent on its folder (#2552).
    const loaded = useAgentStore.getState().agents[state.agentId!];
    if (loaded && loaded.projectId !== DISPATCHER_PROJECT_ID) {
      useAgentStore.setState((s) => ({ agents: { ...s.agents, [loaded.id]: { ...s.agents[loaded.id], projectId: DISPATCHER_PROJECT_ID } } }));
    }
    // A config change (model, runtime) arrives as a new state, and reloading picks it up.
    useAgentStore.getState().loadDurableAgents(DISPATCHER_PROJECT_ID, state.path!).catch((err) => {
      rendererLog('core:agents', 'error', 'Failed to load the Dispatcher agent', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    });
  }, [state]);
}
