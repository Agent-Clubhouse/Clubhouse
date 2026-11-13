/**
 * The Dispatchers on this person's other computers (#3349): who they are,
 * which machine, whether each is there and busy, and the state of the
 * controller link to it (#3345). Read-only; built from link status and Annex
 * Network presence, with no polling of its own.
 */

/** What a remote Dispatcher's computer last published about it. */
export type PublishedDispatcherState = 'online' | 'working' | 'asleep';

/**
 * - `online`, `working`, `asleep`: connected, as it last published.
 * - `offline`: its computer isn't connected now; `lastSeen` says when it was.
 * - `off`: its Dispatcher is turned off.
 * - `unknown`: a computer member that hasn't published its Dispatcher yet.
 */
export type RemoteDispatcherState = PublishedDispatcherState | 'offline' | 'off' | 'unknown';

/**
 * The controller link to it: active, paused (its computer is offline), tripped
 * (a fixed cross-machine limit was reached, #3347) or unavailable (a Dispatcher is off).
 */
export type ControllerLinkState = 'active' | 'paused' | 'tripped' | 'unavailable';

export interface RemoteDispatcherPresence {
  /** The computer's fingerprint, lowercased. */
  machineId: string;
  /** The name this computer knows it by. */
  machineName: string;
  /** Its controller's machine-qualified address, or null while it is unknown. */
  address: string | null;
  dispatcherName: string | null;
  /** "<Dispatcher name> on <machine>". Never a bare id. */
  label: string;
  state: RemoteDispatcherState;
  /** ISO time it was last connected, while it is offline. */
  lastSeen?: string;
  link: { state: ControllerLinkState; reason?: string };
}

export interface DispatcherPresenceSnapshot {
  /** Computer members only, never phones, by machine name. */
  remotes: RemoteDispatcherPresence[];
}

export const PUBLISHED_DISPATCHER_STATES: readonly PublishedDispatcherState[] = ['online', 'working', 'asleep'];

export function isPublishedDispatcherState(value: unknown): value is PublishedDispatcherState {
  return typeof value === 'string' && (PUBLISHED_DISPATCHER_STATES as readonly string[]).includes(value);
}

/** "<Dispatcher name> on <machine>", with "Dispatcher" while its name is unknown. */
export function remoteDispatcherLabel(dispatcherName: string | null | undefined, machineName: string): string {
  return `${dispatcherName?.trim() || 'Dispatcher'} on ${machineName}`;
}

/** Words for a state, as the lists show it. */
export const REMOTE_DISPATCHER_STATE_LABELS: Readonly<Record<RemoteDispatcherState, string>> = {
  online: 'Online',
  working: 'Working',
  asleep: 'Asleep',
  offline: 'Offline',
  off: 'Turned off',
  unknown: 'Not known yet',
};

export const CONTROLLER_LINK_STATE_LABELS: Readonly<Record<ControllerLinkState, string>> = {
  active: 'Link active',
  paused: 'Link paused',
  tripped: 'Link tripped',
  unavailable: 'Link unavailable',
};
