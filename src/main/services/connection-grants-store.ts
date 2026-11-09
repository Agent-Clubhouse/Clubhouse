/**
 * Per-direction connection permissions (D129, #2969, #2972): the store.
 *
 * `connection-grants.json` in the app's data folder (not a project folder an
 * agent can write), `{ version: 1, directions: ConnectionDirection[] }`.
 * One entry per direction that has anything to say: a direction with no
 * entry keeps what its source gave it: a helper or Dispatcher link's starting
 * list (#3214), until it's saved here.
 *
 * The API, for the canvas, the Connections card, and agents across machines
 * (#3056 Stage 7, where the receiving machine checks a call):
 * - getConnectionDirection(from, to): the entry, or undefined;
 * - deniedConnectionTools(from, to): the tools `from` may not use on `to`;
 * - localConnectionWakeOn(fromId, toId): whether Wake it is on, on this computer (#3215);
 * - setConnectionTools(from, to, disabledTools, enabledTools?): replace one direction's lists;
 * - setConnectionDirections(changes, guard): the Dispatcher's lists for several directions, checked under the lock;
 * - fillConnectionTools(from, to, disabledTools): the list a connection Clubhouse made starts with, where none is saved (#3214);
 * - removeConnectionDirection(from, to): drop one direction's entry;
 * - setConnectionLink(from, to, on): the user's own link for one direction;
 * - listConnectionDirections(agentId): every entry touching an agent;
 * - listLinkedDirections(): every direction the user linked (Make two-way);
 * - removeConnectionDirections(agentId): drop an agent's entries (deleted);
 * - listAllConnectionDirections(): every entry (Stage 7 sends another machine its share);
 * - putConnectionDirection(direction): write one entry as given, keeping its
 *   `updatedAt` (Stage 7: another machine's newer copy of a direction with it);
 * - runConnectionMigration(name, directions) / connectionMigrationDone(name): a one-time change with its done marker;
 * - onConnectionGrantsChanged(listener): told after each write.
 * A write updates the live binding's disabled tools, so calls are checked
 * against the store with the existing call path.
 */

import {
  directionKey, localWakeOn, normalizeConnectionDirection, type AgentAddress, type ConnectionDirection,
} from '../../shared/connection-grants';
import { createSettingsStore } from './settings-store';

export const CONNECTION_GRANTS_VERSION = 1;

interface ConnectionGrantsFile {
  version?: number;
  directions: unknown[];
  /** One-time changes already made to the file, by name (#3215). */
  migrations?: string[];
}

// Atomic, and a failed save rolls back, so the store and the live bindings never disagree.
// Audited like every settings store (the inventory requires it).
const store = createSettingsStore<ConnectionGrantsFile>(
  'connection-grants.json',
  { version: CONNECTION_GRANTS_VERSION, directions: [] },
  undefined,
  { atomic: true, rollBackFailedSaves: true, audit: { key: 'connection_grants' } },
);

type Listener = (from: AgentAddress, to: AgentAddress) => void;
const listeners = new Set<Listener>();

function entries(): ConnectionDirection[] {
  const file = store.get();
  const raw = Array.isArray(file?.directions) ? file.directions : [];
  return raw.map(normalizeConnectionDirection).filter((d): d is ConnectionDirection => !!d);
}

/** A newer build's file: read, never written over (it may hold more than this build knows). */
function writable(): boolean {
  const version = store.get()?.version;
  return version === undefined || version <= CONNECTION_GRANTS_VERSION;
}

const sameAddress = (a: AgentAddress, b: AgentAddress) => a.agentId === b.agentId && (a.machineId ?? '') === (b.machineId ?? '');

export function getConnectionDirection(from: AgentAddress, to: AgentAddress): ConnectionDirection | undefined {
  return entries().find((d) => sameAddress(d.from, from) && sameAddress(d.to, to));
}

/** The tools `from` may not use on `to`: the entry's list, or undefined when the store has nothing to say. */
export function deniedConnectionTools(from: AgentAddress, to: AgentAddress): string[] | undefined {
  return getConnectionDirection(from, to)?.disabledTools;
}

/** Whether `fromId`'s connection to `toId`, both on this computer, has Wake it on (#3215). */
export function localConnectionWakeOn(fromId: string, toId: string): boolean {
  return localWakeOn(getConnectionDirection({ agentId: fromId }, { agentId: toId }));
}

/** Every entry where the agent sends or receives. */
export function listConnectionDirections(agentId: string): ConnectionDirection[] {
  return entries().filter((d) => d.from.agentId === agentId || d.to.agentId === agentId);
}

/** Every entry. */
export function listAllConnectionDirections(): ConnectionDirection[] {
  return entries();
}

/** Every direction the user made a link for. */
export function listLinkedDirections(): ConnectionDirection[] {
  return entries().filter((d) => !!d.link);
}

/** What an update returns to leave the entry as it is, telling no one. */
const UNCHANGED = Symbol('unchanged');

async function updateDirection(from: AgentAddress, to: AgentAddress, fn: (current: ConnectionDirection | undefined) => ConnectionDirection | null | typeof UNCHANGED): Promise<ConnectionDirection | null> {
  if (!writable()) throw new Error('This connection file was saved by a newer Clubhouse, so this one won’t change it.');
  let next: ConnectionDirection | null = null;
  let changed = true;
  await store.update((file) => {
    const list = (Array.isArray(file.directions) ? file.directions : []).map(normalizeConnectionDirection).filter((d): d is ConnectionDirection => !!d);
    const key = directionKey(from, to);
    const current = list.find((d) => directionKey(d.from, d.to) === key);
    const result = fn(current);
    if (result === UNCHANGED) {
      changed = false;
      next = current ?? null;
      return file;
    }
    next = result;
    const rest = list.filter((d) => directionKey(d.from, d.to) !== key);
    return { ...file, version: CONNECTION_GRANTS_VERSION, directions: next ? [...rest, next] : rest };
  });
  if (!changed) return next;
  for (const listener of [...listeners]) {
    try {
      listener(from, to);
    } catch {
      // telemetry-exempt: one listener failing must not stop the others
    }
  }
  return next;
}

/**
 * Replace one direction's disabled tools, and its turned-on tools when given
 * (wake on this computer, #3215); left out, they stay as they are. It's the
 * user's write: a Dispatcher mark (`setBy`) goes. The Dispatcher writes with
 * {@link setConnectionDirections}.
 */
export function setConnectionTools(
  from: AgentAddress, to: AgentAddress, disabledTools: readonly string[], enabledTools?: readonly string[],
): Promise<ConnectionDirection | null> {
  return updateDirection(from, to, (current) => {
    const tools = [...new Set(disabledTools)];
    const enabled = enabledTools ? [...new Set(enabledTools)] : current?.enabledTools ?? [];
    // An entry is kept even when empty: "everything on" must not fall back to a source's list.
    return {
      from, to, disabledTools: tools, ...(enabled.length > 0 && { enabledTools: enabled }),
      ...(current?.link && { link: current.link }), updatedAt: new Date().toISOString(),
    };
  });
}

/** One direction's new lists, for {@link setConnectionDirections}. */
export interface DirectionToolsChange {
  from: AgentAddress;
  to: AgentAddress;
  disabledTools: readonly string[];
  enabledTools: readonly string[];
}

/**
 * Replace several directions' lists in one write, as the Dispatcher's (#3215).
 * `guard` sees each direction's entry under the store's lock, so a user's
 * write that lands after the caller looked is seen too; it throws to refuse,
 * and then nothing is written.
 */
export async function setConnectionDirections(
  changes: readonly DirectionToolsChange[],
  guard: (current: ConnectionDirection | undefined, change: DirectionToolsChange) => void,
): Promise<ConnectionDirection[]> {
  if (!writable()) throw new Error('This connection file was saved by a newer Clubhouse, so this one won’t change it.');
  let written: ConnectionDirection[] = [];
  await store.update((file) => {
    const list = (Array.isArray(file.directions) ? file.directions : []).map(normalizeConnectionDirection).filter((d): d is ConnectionDirection => !!d);
    const now = new Date().toISOString();
    const next = changes.map((c): ConnectionDirection => {
      const current = list.find((d) => directionKey(d.from, d.to) === directionKey(c.from, c.to));
      guard(current, c);
      return {
        from: c.from, to: c.to, disabledTools: [...new Set(c.disabledTools)],
        ...(c.enabledTools.length > 0 && { enabledTools: [...new Set(c.enabledTools)] }),
        setBy: 'dispatcher', ...(current?.link && { link: current.link }), updatedAt: now,
      };
    });
    const keys = new Set(next.map((d) => directionKey(d.from, d.to)));
    written = next;
    return { ...file, version: CONNECTION_GRANTS_VERSION, directions: [...list.filter((d) => !keys.has(directionKey(d.from, d.to))), ...next] };
  });
  for (const d of written) {
    for (const listener of [...listeners]) {
      try {
        listener(d.from, d.to);
      } catch {
        // telemetry-exempt: one listener failing must not stop the others
      }
    }
  }
  return written;
}

/**
 * Save the list a direction starts with, only where it has no entry yet
 * (decided under the store's lock): a connection Clubhouse made (#3214), so a
 * choice saved meanwhile stands. Returns whether it was written.
 */
export async function fillConnectionTools(from: AgentAddress, to: AgentAddress, disabledTools: readonly string[]): Promise<boolean> {
  let written = false;
  await updateDirection(from, to, (current) => {
    if (current) return UNCHANGED;
    written = true;
    return { from, to, disabledTools: [...new Set(disabledTools)], updatedAt: new Date().toISOString() };
  });
  return written;
}

/** Drop one direction's entry, link and all: a link the Dispatcher made and removed again (#3215). */
export function removeConnectionDirection(from: AgentAddress, to: AgentAddress): Promise<ConnectionDirection | null> {
  return updateDirection(from, to, (current) => (current ? null : UNCHANGED));
}

/** Turn the user's own link for one direction on or off (Make two-way). */
export function setConnectionLink(from: AgentAddress, to: AgentAddress, on: boolean, defaultTools: readonly string[] = []): Promise<ConnectionDirection | null> {
  return updateDirection(from, to, (current) => {
    if (!on) return current ? { ...current, link: undefined, updatedAt: new Date().toISOString() } : null;
    return {
      from, to,
      disabledTools: current?.disabledTools ?? [...defaultTools],
      ...(current?.enabledTools && { enabledTools: current.enabledTools }),
      link: current?.link ?? { createdAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * Write one direction as given, `updatedAt` included, when it's newer than the
 * entry here (decided under the store's lock): another machine's copy of a
 * direction between it and this one (#3064, D234). Returns whether it was written.
 */
export async function putConnectionDirection(direction: ConnectionDirection): Promise<boolean> {
  let applied = false;
  await updateDirection(direction.from, direction.to, (current) => {
    if (current && Date.parse(current.updatedAt) >= Date.parse(direction.updatedAt)) return UNCHANGED;
    applied = true;
    return direction;
  });
  return applied;
}

/**
 * Drop every entry of a deleted agent. `keepOtherMachines`: an entry with an
 * agent on another machine stays (its link already off), so that machine hears
 * of the removal rather than bringing the link back (#3064).
 */
export async function removeConnectionDirections(agentId: string, options: { keepOtherMachines?: boolean } = {}): Promise<void> {
  if (!writable()) return;
  await store.update((file) => {
    const list = (Array.isArray(file.directions) ? file.directions : []).map(normalizeConnectionDirection).filter((d): d is ConnectionDirection => !!d);
    return {
      ...file,
      version: CONNECTION_GRANTS_VERSION,
      directions: list.filter((d) => (d.from.agentId !== agentId && d.to.agentId !== agentId) || (options.keepOtherMachines && (!!d.from.machineId || !!d.to.machineId))),
    };
  });
}

/** Whether a one-time change named `name` was already made to the store (#3215). */
export function connectionMigrationDone(name: string): boolean {
  const done = store.get()?.migrations;
  return Array.isArray(done) && done.includes(name);
}

/**
 * Make a one-time change, in one write with its done marker: each direction
 * given is written only where the store has no entry for it yet, and the
 * marker is kept so it never runs again (#3215). Returns the directions it
 * wrote, or null when the change was already made (decided under the store's lock).
 */
export async function runConnectionMigration(name: string, directions: readonly ConnectionDirection[]): Promise<ConnectionDirection[] | null> {
  if (!writable()) throw new Error('This connection file was saved by a newer Clubhouse, so this one won’t change it.');
  let written = null as ConnectionDirection[] | null;
  await store.update((file) => {
    const done = Array.isArray(file.migrations) ? file.migrations.filter((m): m is string => typeof m === 'string') : [];
    if (done.includes(name)) return file;
    const list = (Array.isArray(file.directions) ? file.directions : []).map(normalizeConnectionDirection).filter((d): d is ConnectionDirection => !!d);
    const keys = new Set(list.map((d) => directionKey(d.from, d.to)));
    written = directions.filter((d) => !keys.has(directionKey(d.from, d.to)));
    return { ...file, version: CONNECTION_GRANTS_VERSION, directions: [...list, ...written], migrations: [...done, name] };
  });
  for (const d of written ?? []) {
    for (const listener of [...listeners]) {
      try {
        listener(d.from, d.to);
      } catch {
        // telemetry-exempt: one listener failing must not stop the others
      }
    }
  }
  return written;
}

/** For tests: forget a one-time change was made. */
export async function _forgetConnectionMigrationForTesting(name: string): Promise<void> {
  await store.update((file) => ({ ...file, migrations: (file.migrations ?? []).filter((m) => m !== name) }));
}

export function onConnectionGrantsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
