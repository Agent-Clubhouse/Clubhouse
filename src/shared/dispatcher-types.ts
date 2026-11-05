import type { DurableAgentConfig } from './types';

/**
 * Why the Dispatcher is off, the first of these that applies:
 * - `switch_off`: its switch is saved off.
 * - `experimental_off`: nothing on its switch, and a saved experimental
 *   `dispatcher: false` from before the flag was removed.
 * - `classic_layout`: nothing on its switch, and the classic layout, which has
 *   no way to reach it.
 * - `mcp_off`: Clubhouse MCP is off at app level.
 */
export type DispatcherOffReason = 'switch_off' | 'experimental_off' | 'classic_layout' | 'mcp_off';

/** The saved values and session facts that decide whether the Dispatcher is on. */
export interface DispatcherEnablementInput {
  /** `enabled` in dispatcher-settings.json, when it is there. */
  saved: boolean | undefined;
  /** isGraduatedFlagOn for `dispatcher` in experimental-settings.json: only a saved false reads off. */
  graduatedFlagOn: boolean;
  newLayout: boolean;
  /** MCP at app level: the MCP switch or the global Clubhouse mode. Project and agent overrides don't count. */
  appMcp: boolean;
}

export interface DispatcherEnablement {
  /** What the saved values say, MCP aside. This is what comes back with MCP. */
  savedOn: boolean;
  enabled: boolean;
  reason: DispatcherOffReason | null;
}

/**
 * On by default in the new layout. An explicit switch value wins over every
 * default, so a saved true stays on in the classic layout too. MCP going off
 * at app level derives it off and changes nothing saved.
 */
export function resolveDispatcherEnablement({ saved, graduatedFlagOn, newLayout, appMcp }: DispatcherEnablementInput): DispatcherEnablement {
  let reason: DispatcherOffReason | null = null;
  if (saved === false) reason = 'switch_off';
  else if (saved !== true && !graduatedFlagOn) reason = 'experimental_off';
  else if (saved !== true && !newLayout) reason = 'classic_layout';
  const savedOn = reason === null;
  if (savedOn && !appMcp) reason = 'mcp_off';
  return { savedOn, enabled: reason === null, reason };
}

/** The refusal for turning the Dispatcher on in the classic layout (#2565). */
export const DISPATCHER_CLASSIC_MESSAGE = 'The Dispatcher needs the new layout. Turn off Classic layout in Settings > Display & UI, then restart Clubhouse.';

/**
 * What the renderer and other services see of the app-wide Dispatcher
 * (#2533). The agent id, folder and config stay set after it's turned off, so
 * turning it back on resumes; they're null only before it was first created.
 */
export interface DispatcherState {
  /** Whether it is on now: see resolveDispatcherEnablement. */
  enabled: boolean;
  /** For phones, which read this as "can it be turned on": false while Clubhouse MCP is off at app level. The experimental flag it once was is gone. */
  flagOn: boolean;
  /** What its saved values say, MCP aside. It returns to this when MCP does. */
  savedOn: boolean;
  /** Why `enabled` is false, or null while it is on. */
  offReason: DispatcherOffReason | null;
  /** Clubhouse MCP is off at app level. */
  mcpOff: boolean;
  /** This session runs the classic layout. */
  classic: boolean;
  /**
   * Its agent is running. It can be while `enabled` is false: MCP going off stops
   * nothing, so the row and view stay until it stops.
   */
  running: boolean;
  agentId: string | null;
  path: string | null;
  config: DurableAgentConfig | null;
}

/**
 * The synthetic project id the Dispatcher runs under. It isn't in
 * `projectStore`; main and renderer use this to tell its agent apart.
 */
export const DISPATCHER_PROJECT_ID = '__dispatcher__';

export const DISPATCHER_OFF: DispatcherState = {
  enabled: false, flagOn: true, savedOn: false, offReason: 'switch_off', mcpOff: false, classic: false, running: false, agentId: null, path: null, config: null,
};
