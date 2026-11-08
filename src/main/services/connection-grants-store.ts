/**
 * Per-direction connection permissions (D129, #2969, #2972): the store.
 *
 * `connection-grants.json` in the app's data folder (not a project folder an
 * agent can write), `{ version: 1, directions: ConnectionDirection[] }`.
 * One entry per direction that has anything to say: a direction with no
 * entry keeps what its source gave it, which is how helper and Dispatcher
 * wires keep working unchanged.
 *
 * The API, for the canvas, the Connections card, and agents across machines
 * (#3056 Stage 7, where the receiving machine checks a call):
 * - getConnectionDirection(from, to): the entry, or undefined;
 * - deniedConnectionTools(from, to): the tools `from` may not use on `to`;
 * - setConnectionTools(from, to, disabledTools): replace one direction's list;
 * - setConnectionLink(from, to, on): the user's own link for one direction;
 * - listConnectionDirections(agentId): every entry touching an agent;
 * - listLinkedDirections(): every direction the user linked (Make two-way);
 * - removeConnectionDirections(agentId): drop an agent's entries (deleted);
 * - onConnectionGrantsChanged(listener): told after each write.
 * A write updates the live binding's disabled tools, so calls are checked
 * against the store with the existing call path.
 */

import {
  directionKey, normalizeConnectionDirection, type AgentAddress, type ConnectionDirection,
} from '../../shared/connection-grants';
import { createSettingsStore } from './settings-store';

export const CONNECTION_GRANTS_VERSION = 1;

interface ConnectionGrantsFile {
  version?: number;
  directions: unknown[];
}

const store = createSettingsStore<ConnectionGrantsFile>(
  'connection-grants.json',
  { version: CONNECTION_GRANTS_VERSION, directions: [] },
  undefined,
  { audit: { key: 'connection_grants' } },
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

/** Every entry where the agent sends or receives. */
export function listConnectionDirections(agentId: string): ConnectionDirection[] {
  return entries().filter((d) => d.from.agentId === agentId || d.to.agentId === agentId);
}

/** Every direction the user made a link for. */
export function listLinkedDirections(): ConnectionDirection[] {
  return entries().filter((d) => !!d.link);
}

async function updateDirection(from: AgentAddress, to: AgentAddress, fn: (current: ConnectionDirection | undefined) => ConnectionDirection | null): Promise<ConnectionDirection | null> {
  if (!writable()) throw new Error('This connection file was saved by a newer Clubhouse, so this one won’t change it.');
  let next: ConnectionDirection | null = null;
  await store.update((file) => {
    const list = (Array.isArray(file.directions) ? file.directions : []).map(normalizeConnectionDirection).filter((d): d is ConnectionDirection => !!d);
    const key = directionKey(from, to);
    const current = list.find((d) => directionKey(d.from, d.to) === key);
    next = fn(current);
    const rest = list.filter((d) => directionKey(d.from, d.to) !== key);
    return { version: CONNECTION_GRANTS_VERSION, directions: next ? [...rest, next] : rest };
  });
  for (const listener of [...listeners]) {
    try {
      listener(from, to);
    } catch {
      // telemetry-exempt: one listener failing must not stop the others
    }
  }
  return next;
}

/** Replace one direction's disabled tools. An empty list with no link drops the entry. */
export function setConnectionTools(from: AgentAddress, to: AgentAddress, disabledTools: readonly string[]): Promise<ConnectionDirection | null> {
  return updateDirection(from, to, (current) => {
    const tools = [...new Set(disabledTools)];
    // An entry is kept even when empty: "everything on" must not fall back to a source's list.
    return { from, to, disabledTools: tools, ...(current?.link && { link: current.link }), updatedAt: new Date().toISOString() };
  });
}

/** Turn the user's own link for one direction on or off (Make two-way). */
export function setConnectionLink(from: AgentAddress, to: AgentAddress, on: boolean, defaultTools: readonly string[] = []): Promise<ConnectionDirection | null> {
  return updateDirection(from, to, (current) => {
    if (!on) return current ? { ...current, link: undefined, updatedAt: new Date().toISOString() } : null;
    return {
      from, to,
      disabledTools: current?.disabledTools ?? [...defaultTools],
      link: current?.link ?? { createdAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    };
  });
}

/** Drop every entry of a deleted agent. */
export async function removeConnectionDirections(agentId: string): Promise<void> {
  if (!writable()) return;
  await store.update((file) => {
    const list = (Array.isArray(file.directions) ? file.directions : []).map(normalizeConnectionDirection).filter((d): d is ConnectionDirection => !!d);
    return { version: CONNECTION_GRANTS_VERSION, directions: list.filter((d) => d.from.agentId !== agentId && d.to.agentId !== agentId) };
  });
}

export function onConnectionGrantsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
