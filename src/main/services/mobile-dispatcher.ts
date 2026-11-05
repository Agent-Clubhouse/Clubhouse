/**
 * The app-wide Dispatcher (#2533, #2535) from a phone. It is in no project,
 * so the mobile protocol lists it on its own (the snapshot's `dispatcher`)
 * under the synthetic project id `__dispatcher__`, and resolves its agent id
 * for the agent routes and commands only while it is turned on. A phone may
 * turn it on or off as Settings > Dispatcher does. See
 * docs/mobile-control-v1.md#dispatcher.
 */

import type { Project } from '../../shared/types';
import { DISPATCHER_PROJECT_ID, type DispatcherState } from '../../shared/dispatcher-types';
import * as dispatcher from './dispatcher/dispatcher-service';
import { newChromeEnabled } from '../window-chrome';
import { MobileControlError } from './mobile-control';
import { MCP_REQUIRED_MESSAGE } from '../../shared/orchestration-policy';

export { DISPATCHER_PROJECT_ID };

export const DISPATCHER_CHANGED_EVENT = 'dispatcher:changed';

export const isDispatcherProjectId = (projectId: unknown): boolean => projectId === DISPATCHER_PROJECT_ID;

/** The Dispatcher's folder as a project, so agent code that takes `{ id, path }` runs unchanged. */
export function dispatcherProject(): Project {
  return { id: DISPATCHER_PROJECT_ID, name: dispatcher.DISPATCHER_NAME, path: dispatcher.getDispatcherPath() };
}

type DurableConfig = NonNullable<DispatcherState['config']>;

type OffReason = 'mcp_off' | 'switched_off' | 'classic_layout';

/** Why it is off, as a phone reads it. `switched_off` wins over `mcp_off`, as the desktop's reasons do. */
function offReasonOf(state: DispatcherState): OffReason | null {
  if (state.enabled) return null;
  if (state.offReason === 'mcp_off') return 'mcp_off';
  return state.offReason === 'classic_layout' ? 'classic_layout' : 'switched_off';
}

/**
 * Its routes answer while it is on, and with Clubhouse MCP off, so a running
 * session can still be seen and its history read after it ends. Switched off or
 * on the classic layout they answer as they always have.
 */
function isReachable(state: DispatcherState): boolean {
  return state.enabled || state.offReason === 'mcp_off';
}

/** What a phone may send for the Dispatcher with MCP off and a session running. */
const COMMANDS_WHILE_RUNNING = ['agent.stop', 'chat.interrupt', 'chat.permission', 'chat.queue.remove', 'chat.question', 'chat.send', 'dispatcher.setEnabled'] as const;
const COMMANDS_WHILE_STOPPED = ['dispatcher.setEnabled'] as const;

/**
 * The commands accepted while it is off, advertised as `commandsWhileOff` and
 * enforced by assertDispatcherCommand: this one list is both. Empty while it is
 * on, when the usual rules apply. Some are limited by payload there:
 * dispatcher.setEnabled turns it off, and chat.permission and chat.question answer
 * a pending request.
 */
export function dispatcherCommandsWhileOff(state: DispatcherState): readonly string[] {
  if (state.enabled) return [];
  return offReasonOf(state) === 'mcp_off' && state.running ? COMMANDS_WHILE_RUNNING : COMMANDS_WHILE_STOPPED;
}

/** Refuse what the list doesn't hold for the Dispatcher's id. No new authority comes from being off. */
export function assertDispatcherCommand(type: string, agentId: unknown): void {
  if (!dispatcher.isDispatcherAgentId(typeof agentId === 'string' ? agentId : undefined)) return;
  const state = dispatcher.getDispatcherState();
  if (state.enabled || dispatcherCommandsWhileOff(state).includes(type)) return;
  throw offReasonOf(state) === 'mcp_off'
    ? new MobileControlError('mcp_off', 409, 'rejected', MCP_OFF_MESSAGE)
    : new MobileControlError('dispatcher_off', 409, 'rejected', 'The Dispatcher is turned off.');
}

const MCP_OFF_MESSAGE = 'Clubhouse MCP is off, so the Dispatcher can only be stopped or answered from a phone. Turn on Clubhouse MCP on the desktop.';

/** A pending-only command that found nothing pending, while MCP is off. */
export function dispatcherNothingPending(agentId: string, err: unknown): MobileControlError | null {
  if (!dispatcher.isDispatcherAgentId(agentId) || !(err instanceof MobileControlError) || err.code !== 'pending_request_not_found') return null;
  const state = dispatcher.getDispatcherState();
  return !state.enabled && offReasonOf(state) === 'mcp_off' ? new MobileControlError('mcp_off', 409, 'rejected', MCP_OFF_MESSAGE) : null;
}

/** The record, whatever state it is in: the snapshot keeps it, so history isn't lost. */
export function dispatcherRecord(): DurableConfig | null {
  return dispatcher.getDispatcherState().config;
}

/** The Dispatcher's config and folder while its routes answer; null when they don't, it isn't created yet, or `agentId` is another agent. */
export function activeDispatcher(agentId?: string): { config: DurableConfig; project: Project } | null {
  if (agentId !== undefined && !dispatcher.isDispatcherAgentId(agentId)) return null;
  const state = dispatcher.getDispatcherState();
  if (!isReachable(state)) return null;
  return state.config ? { config: state.config, project: dispatcherProject() } : null;
}

/** True for the Dispatcher's id while its routes don't answer. */
export function isDisabledDispatcherId(agentId: string): boolean {
  return dispatcher.isDispatcherAgentId(agentId) && !isReachable(dispatcher.getDispatcherState());
}

/** The Dispatcher's folder as a project for a phone's session list, while its routes answer. */
export function dispatcherFolderProject(projectId: unknown): Project | undefined {
  return isDispatcherProjectId(projectId) && isReachable(dispatcher.getDispatcherState()) ? dispatcherProject() : undefined;
}

/** The Dispatcher's folder for a phone's shell, only while it is on. */
export function dispatcherShellProject(projectId: unknown): Project | undefined {
  return isDispatcherProjectId(projectId) && dispatcher.isDispatcherEnabled() ? dispatcherProject() : undefined;
}

/** `dispatcher.setEnabled`'s result, and the part of `dispatcher:changed` every phone reads. The agent id only while it is on. */
export function dispatcherChange(state: DispatcherState = dispatcher.getDispatcherState()) {
  return { enabled: state.enabled, flagOn: state.flagOn, agentId: state.enabled ? state.agentId : null };
}
export type MobileDispatcherChange = ReturnType<typeof dispatcherChange>;

/** The agent as a phone's payloads carry it. annex-server maps it, in the one shape all three use. */
type AgentView = (config: DurableConfig) => { status?: string } | DurableConfig;

/**
 * What the snapshot, dispatcher:changed and the capabilities all add while it is
 * off, built here so they can't disagree. Nothing while it is on.
 */
export function dispatcherOffFields(state: DispatcherState, view: AgentView) {
  const offReason = offReasonOf(state);
  if (!offReason) return {};
  const detail = offReason === 'mcp_off'
    ? (state.running ? 'MCP off; session running' : 'MCP off')
    : offReason === 'classic_layout' ? 'Needs the new layout' : 'Turned off';
  const agent = state.config ? view(state.config) : null;
  return {
    offReason,
    running: state.running,
    // What the agent itself says, so the two can't differ. Before it exists, nothing is running.
    status: (agent as { status?: string } | null)?.status ?? (state.running ? 'running' : 'sleeping'),
    detail,
    commandsWhileOff: [...dispatcherCommandsWhileOff(state)],
    agent,
  };
}

/** The snapshot's `enabled` and `flagOn`, both false while it is off with MCP off. */
export function dispatcherSnapshotFlags() {
  const { enabled, flagOn } = dispatcher.getDispatcherState();
  return { enabled, flagOn };
}

/** The capabilities' `dispatcher`. Turning it on needs `flagOn`, which is false while Clubhouse MCP is off at app level, and `newLayout`; off always works. */
export function dispatcherCapability(view: AgentView = (config) => config) {
  const state = dispatcher.getDispatcherState();
  return {
    version: 1 as const, enabled: state.enabled, flagOn: state.flagOn, newLayout: newChromeEnabled(),
    projectId: DISPATCHER_PROJECT_ID, snapshotField: 'dispatcher', event: DISPATCHER_CHANGED_EVENT, commands: ['dispatcher.setEnabled'],
    ...dispatcherOffFields(state, view),
  };
}

/**
 * dispatcher.setEnabled: Settings > Dispatcher's switch. On needs Clubhouse MCP
 * at app level and the new layout (its view is in the new layout only, #2565); one
 * that is still on can always be turned off, in every state.
 */
export async function setDispatcherEnabledFromPhone(enabled: boolean, assertAuthorized: () => void): Promise<MobileDispatcherChange> {
  const state = dispatcher.getDispatcherState();
  if (enabled && state.enabled) return dispatcherChange(state);
  if (enabled && offReasonOf(state) === 'mcp_off') throw new MobileControlError('mcp_off', 409, 'rejected', MCP_OFF_MESSAGE);
  // Switched off as well as no MCP: an existing path with its existing code, and `message` says what to do now.
  if (enabled && !state.flagOn) throw new MobileControlError('dispatcher_flag_off', 409, 'rejected', MCP_REQUIRED_MESSAGE);
  if (enabled && !state.savedOn && !newChromeEnabled()) {
    throw new MobileControlError('dispatcher_layout_off', 409, 'rejected', 'The Dispatcher needs the new layout. Turn off Classic layout in Settings > Display & UI on the desktop, then restart Clubhouse.');
  }
  assertAuthorized();
  return dispatcherChange(await dispatcher.setDispatcherEnabled(enabled));
}
