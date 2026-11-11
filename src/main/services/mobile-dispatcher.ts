/**
 * The app-wide Dispatcher (#2533, #2535) from a phone. It is in no project,
 * so the mobile protocol lists it on its own (the snapshot's `dispatcher`)
 * under the synthetic project id `__dispatcher__`, and resolves its agent id
 * for the agent routes and commands only while it is turned on. A phone may
 * turn it on or off as Settings > Dispatcher does. See
 * docs/mobile-control-v1.md#dispatcher.
 *
 * A phone sees the agent the user talks to (#3036): the Dispatcher's chat,
 * with its folder as the project. The agent that holds its connections and
 * does the work is never listed, and its id answers as no agent at all.
 *
 * Its chat reaches a phone as the desktop draws it (#3043): a group chat with
 * no tool calls, thoughts or Clubhouse updates. See phoneChatEvent.
 */

import type { Project } from '../../shared/types';
import type { ChatEvent } from '../../shared/chat';
import { DISPATCHER_PROJECT_ID, type DispatcherState } from '../../shared/dispatcher-types';
import { groupChatEvent, groupChatEvents, type GroupChatContext } from '../../shared/dispatcher-group-chat';
import * as dispatcher from './dispatcher/dispatcher-service';
import { newChromeEnabled } from '../window-chrome';
import { MobileControlError } from './mobile-control';

export { DISPATCHER_PROJECT_ID };

export const DISPATCHER_CHANGED_EVENT = 'dispatcher:changed';

export const isDispatcherProjectId = (projectId: unknown): boolean => projectId === DISPATCHER_PROJECT_ID;

/** The chat's folder as the Dispatcher's project, so agent code that takes `{ id, path }` runs unchanged. */
export function dispatcherProject(): Project {
  return { id: DISPATCHER_PROJECT_ID, name: dispatcher.DISPATCHER_NAME, path: dispatcher.getDispatcherChatPath() };
}

/** The id a phone knows the Dispatcher by: its chat's. */
function isPhoneDispatcherId(agentId: string | undefined): boolean {
  return dispatcher.isDispatcherChatAgentId(agentId);
}

type DurableConfig = NonNullable<DispatcherState['config']>;

/**
 * Why it is off, as a phone reads it. The phone's `mcp_off` is never sent any
 * more: the Clubhouse MCP always runs.
 */
type OffReason = 'switched_off' | 'classic_layout';

function offReasonOf(state: DispatcherState): OffReason | null {
  if (state.enabled) return null;
  return state.offReason === 'classic_layout' ? 'classic_layout' : 'switched_off';
}

/** Its routes answer while it is on. Switched off or on the classic layout they answer as they always have. */
function isReachable(state: DispatcherState): boolean {
  return state.enabled;
}

const COMMANDS_WHILE_OFF = ['dispatcher.setEnabled'] as const;

/**
 * The commands accepted while it is off, advertised as `commandsWhileOff` and
 * enforced by assertDispatcherCommand: this one list is both. Empty while it is
 * on, when the usual rules apply.
 */
export function dispatcherCommandsWhileOff(state: DispatcherState): readonly string[] {
  return state.enabled ? [] : COMMANDS_WHILE_OFF;
}

/** Refuse what the list doesn't hold for the Dispatcher's id. No new authority comes from being off. */
export function assertDispatcherCommand(type: string, agentId: unknown): void {
  if (!isPhoneDispatcherId(typeof agentId === 'string' ? agentId : undefined)) return;
  const state = dispatcher.getDispatcherState();
  if (state.enabled || dispatcherCommandsWhileOff(state).includes(type)) return;
  throw new MobileControlError('dispatcher_off', 409, 'rejected', 'The Dispatcher is turned off.');
}

/** The record, whatever state it is in: the snapshot keeps it, so history isn't lost. */
export function dispatcherRecord(): DurableConfig | null {
  return dispatcher.getDispatcherChatConfig();
}

/** The Dispatcher's config and folder while its routes answer; null when they don't, it isn't created yet, or `agentId` is another agent. */
export function activeDispatcher(agentId?: string): { config: DurableConfig; project: Project } | null {
  if (agentId !== undefined && !isPhoneDispatcherId(agentId)) return null;
  if (!isReachable(dispatcher.getDispatcherState())) return null;
  const config = dispatcher.getDispatcherChatConfig();
  return config ? { config, project: dispatcherProject() } : null;
}

/** True for the Dispatcher's id while its routes don't answer. */
export function isDisabledDispatcherId(agentId: string): boolean {
  return isPhoneDispatcherId(agentId) && !isReachable(dispatcher.getDispatcherState());
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
  return { ...dispatcherSnapshotFlags(state), agentId: state.enabled ? state.chatAgentId : null };
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
  const detail = offReason === 'classic_layout' ? 'Needs the new layout' : 'Turned off';
  const record = dispatcherRecord();
  const agent = record ? view(record) : null;
  return {
    offReason,
    running: state.chatRunning,
    // What the agent itself says, so the two can't differ. Before it exists, nothing is running.
    status: (agent as { status?: string } | null)?.status ?? (state.chatRunning ? 'running' : 'sleeping'),
    detail,
    commandsWhileOff: [...dispatcherCommandsWhileOff(state)],
    agent,
  };
}

/** State shared by snapshots, change events and capabilities. `flagOn` is always true: the Clubhouse MCP always runs. */
export function dispatcherSnapshotFlags(state: DispatcherState = dispatcher.getDispatcherState()) {
  const { enabled, flagOn, requestsUnderWay } = state;
  return { enabled, flagOn, requestsUnderWay };
}

/** Settings > Dispatcher from a phone (#3206): its read route and commands, beside dispatcher.setEnabled. */
export const DISPATCHER_SETTINGS_COMMANDS = ['dispatcher.update', 'dispatcher.setModels', 'dispatcher.clearChat', 'dispatcher.forgetEverything'] as const;

/** The capabilities' `dispatcher`. Turning it on needs `newLayout`; off always works. `flagOn` is always true. */
export function dispatcherCapability(view: AgentView = (config) => config) {
  const state = dispatcher.getDispatcherState();
  return {
    version: 1 as const, ...dispatcherSnapshotFlags(state), newLayout: newChromeEnabled(),
    projectId: DISPATCHER_PROJECT_ID, snapshotField: 'dispatcher', event: DISPATCHER_CHANGED_EVENT, commands: ['dispatcher.setEnabled', ...DISPATCHER_SETTINGS_COMMANDS],
    settings: { version: 1 as const, path: '/api/v1/mobile/dispatcher/settings' },
    ...dispatcherOffFields(state, view),
  };
}

/**
 * dispatcher.setEnabled: Settings > Dispatcher's switch. On needs the new layout
 * (its view is in the new layout only, #2565); one that is still on can always
 * be turned off, in every state.
 */
export async function setDispatcherEnabledFromPhone(enabled: boolean, assertAuthorized: () => void): Promise<MobileDispatcherChange> {
  const state = dispatcher.getDispatcherState();
  if (enabled && state.enabled) return dispatcherChange(state);
  if (enabled && !state.savedOn && !newChromeEnabled()) {
    throw new MobileControlError('dispatcher_layout_off', 409, 'rejected', 'The Dispatcher needs the new layout. Turn off Classic layout in Settings > Display & UI on the desktop, then restart Clubhouse.');
  }
  assertAuthorized();
  return dispatcherChange(await dispatcher.setDispatcherEnabled(enabled));
}

/** The group chat's context for the Dispatcher's agents (its chat and the coordinator), else null: any other agent's chat goes whole. */
function groupChatContextFor(agentId: string): GroupChatContext | null {
  if (!dispatcher.isDispatcherChatAgentId(agentId) && !dispatcher.isDispatcherAgentId(agentId)) return null;
  const ids = [dispatcher.getDispatcherChatAgentId(), dispatcher.getDispatcherAgentId()].filter((id): id is string => !!id);
  return { ownAgentIds: new Set(ids) };
}

/**
 * A chat event as Annex sends it, live and on replay: the Dispatcher's as its
 * group chat shows them (shared/dispatcher-group-chat.ts), or null when it
 * isn't sent. Every other agent's event is returned as it is.
 */
export function phoneChatEvent(event: ChatEvent): ChatEvent | null {
  const ctx = groupChatContextFor(event.agentId);
  return ctx ? groupChatEvent(event, ctx) : event;
}

/** An agent's chat history as Annex pages it: the Dispatcher's as its group chat shows it, every other agent's whole. */
export function phoneChatEvents(agentId: string, events: ChatEvent[]): ChatEvent[] {
  const ctx = groupChatContextFor(agentId);
  return ctx ? groupChatEvents(events, ctx) : events;
}
