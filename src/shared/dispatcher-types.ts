import type { DurableAgentConfig } from './types';

/**
 * What the renderer and other services see of the app-wide Dispatcher
 * (#2533). `enabled` is the experimental flag AND the app setting. The agent
 * id, folder and config stay set after it's turned off, so turning it back on
 * resumes; they're null only before it was first created.
 */
export interface DispatcherState {
  enabled: boolean;
  agentId: string | null;
  path: string | null;
  config: DurableAgentConfig | null;
}

/**
 * The synthetic project id the Dispatcher runs under. It isn't in
 * `projectStore`; main and renderer use this to tell its agent apart.
 */
export const DISPATCHER_PROJECT_ID = '__dispatcher__';

export const DISPATCHER_OFF: DispatcherState = { enabled: false, agentId: null, path: null, config: null };
