/**
 * The app-wide Dispatcher (#2533, #2535) from a phone. It is in no project,
 * so the mobile protocol lists it on its own (the snapshot's `dispatcher`)
 * under the synthetic project id `__dispatcher__`, and resolves its agent id
 * for the agent routes and commands only while it is turned on. A phone may
 * turn it on or off as Settings > Dispatcher does, never flip the
 * experimental flag. See docs/mobile-control-v1.md#dispatcher.
 */

import type { Project } from '../../shared/types';
import { DISPATCHER_PROJECT_ID, type DispatcherState } from '../../shared/dispatcher-types';
import * as dispatcher from './dispatcher/dispatcher-service';
import { newChromeEnabled } from '../window-chrome';
import { MobileControlError } from './mobile-control';

export { DISPATCHER_PROJECT_ID };

export const DISPATCHER_CHANGED_EVENT = 'dispatcher:changed';

export const isDispatcherProjectId = (projectId: unknown): boolean => projectId === DISPATCHER_PROJECT_ID;

/** The Dispatcher's folder as a project, so agent code that takes `{ id, path }` runs unchanged. */
export function dispatcherProject(): Project {
  return { id: DISPATCHER_PROJECT_ID, name: dispatcher.DISPATCHER_NAME, path: dispatcher.getDispatcherPath() };
}

type DurableConfig = NonNullable<DispatcherState['config']>;

/** The Dispatcher's config and folder while it is on; null when it is off, not created yet, or `agentId` is another agent. */
export function activeDispatcher(agentId?: string): { config: DurableConfig; project: Project } | null {
  if (agentId !== undefined && !dispatcher.isDispatcherAgentId(agentId)) return null;
  if (!dispatcher.isDispatcherEnabled()) return null;
  const { config } = dispatcher.getDispatcherState();
  return config ? { config, project: dispatcherProject() } : null;
}

/** The Dispatcher's id while it is off: commands for it answer `dispatcher_off`. */
export function isDisabledDispatcherId(agentId: string): boolean {
  return dispatcher.isDispatcherAgentId(agentId) && !dispatcher.isDispatcherEnabled();
}

/** The Dispatcher's folder as a project for a phone's shell or session list, while it is on. */
export function dispatcherFolderProject(projectId: unknown): Project | undefined {
  return isDispatcherProjectId(projectId) && dispatcher.isDispatcherEnabled() ? dispatcherProject() : undefined;
}

/** `dispatcher:changed`'s payload. The agent id only while it is on, so a phone knows to drop it. */
export function dispatcherChange(state: DispatcherState = dispatcher.getDispatcherState()) {
  return { enabled: state.enabled, flagOn: state.flagOn, agentId: state.enabled ? state.agentId : null };
}
export type MobileDispatcherChange = ReturnType<typeof dispatcherChange>;

/** The capabilities' `dispatcher`. Turning it on needs `flagOn` and `newLayout`; off always works. */
export function dispatcherCapability() {
  const state = dispatcher.getDispatcherState();
  return {
    version: 1 as const, enabled: state.enabled, flagOn: state.flagOn, newLayout: newChromeEnabled(),
    projectId: DISPATCHER_PROJECT_ID, snapshotField: 'dispatcher', event: DISPATCHER_CHANGED_EVENT, commands: ['dispatcher.setEnabled'],
  };
}

/**
 * dispatcher.setEnabled: Settings > Dispatcher's switch. On needs the
 * experimental flag and the new layout (its view is in the new layout only,
 * #2565); one that is still on can always be turned off.
 */
export async function setDispatcherEnabledFromPhone(enabled: boolean, assertAuthorized: () => void): Promise<MobileDispatcherChange> {
  const state = dispatcher.getDispatcherState();
  if (enabled && state.enabled) return dispatcherChange(state);
  if (enabled && !state.flagOn) {
    throw new MobileControlError('dispatcher_flag_off', 409, 'rejected', 'Turn on Dispatcher in Settings > Experimental on the desktop first.');
  }
  if (enabled && !newChromeEnabled()) {
    throw new MobileControlError('dispatcher_layout_off', 409, 'rejected', 'The Dispatcher needs the new layout. Turn on New layout in Settings > Experimental on the desktop.');
  }
  assertAuthorized();
  return dispatcherChange(await dispatcher.setDispatcherEnabled(enabled));
}
