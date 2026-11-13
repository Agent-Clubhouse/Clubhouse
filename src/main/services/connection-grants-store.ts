/**
 * Per-direction connection permissions (D129, #2969, #2972): the store.
 *
 * `connection-grants.json` in the app's data folder (not a project folder an
 * agent can write), `{ version: 1, directions: ConnectionDirection[] }`.
 * One entry per direction that has anything to say: a direction with no
 * entry keeps what its source gave it: a helper or Dispatcher link's starting
 * list, wake included (#3214), until it's saved here.
 *
 * The API, for the canvas, the Connections card, and agents across machines
 * (#3056 Stage 7, where the receiving machine checks a call):
 * - getConnectionDirection(from, to): the entry, or undefined;
 * - deniedConnectionTools(from, to): the tools `from` may not use on `to`;
 * - localConnectionWakeOn(fromId, toId): whether Wake it is on, on this computer (#3215), else as its source started it (#3214);
 * - setConnectionTools(from, to, disabledTools, enabledTools?): replace one direction's lists;
 * - setConnectionDirections(changes, guard): the Dispatcher's lists for several directions, checked under the lock;
 * - fillConnectionTools(from, to, disabledTools, enabledTools): the lists a connection Clubhouse made starts with, where none is saved (#3214);
 * - removeConnectionDirection(from, to): drop one direction's entry;
 * - setConnectionLink(from, to, on): the user's own link for one direction;
 * - linkConnectionDirections(pairs): add user links in one write, retaining saved switches;
 * - listConnectionDirections(agentId): every entry touching an agent;
 * - listLinkedDirections(): every direction the user linked (Make two-way);
 * - removeConnectionDirections(agentId): drop an agent's entries (deleted);
 * - listAllConnectionDirections(): every entry (Stage 7 sends another machine its share);
 * - putConnectionDirection(direction): write one entry as given, keeping its
 *   `updatedAt` (Stage 7: another machine's newer copy of a direction with it);
 * - runConnectionMigration(name, directions, replaceIf?) / connectionMigrationDone(name): a one-time change with its done marker;
 * - onConnectionGrantsChanged(listener): told after each write.
 * A write updates the live binding's disabled tools, so calls are checked
 * against the store with the existing call path.
 */

import {
  activeAgentLinks, NEW_CONNECTION_SWITCHES, WAKE_TOOL, directionKey, localWakeOn, normalizeConnectionDirection, type AgentAddress, type ConnectionDirection,
} from '../../shared/connection-grants';
import { createSettingsStore, peekStoredSettingsSync, type SettingsCommitPrecondition } from './settings-store';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { appLog } from './log-service';

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

/** Whether this build may write the file: false for a newer build's (#3214 says so once, not on every rebuild). */
export function connectionGrantsWritable(): boolean {
  return writable();
}

/** For tests: mark the file as saved by another build's version. */
export async function _setConnectionGrantsVersionForTesting(version: number): Promise<void> {
  await store.update((file) => ({ ...file, version }));
}

const sameAddress = (a: AgentAddress, b: AgentAddress) => a.agentId === b.agentId && (a.machineId ?? '') === (b.machineId ?? '');

export function getConnectionDirection(from: AgentAddress, to: AgentAddress): ConnectionDirection | undefined {
  return entries().find((d) => sameAddress(d.from, from) && sameAddress(d.to, to));
}

/** The tools `from` may not use on `to`: the entry's list, or undefined when the store has nothing to say. */
export function deniedConnectionTools(from: AgentAddress, to: AgentAddress): string[] | undefined {
  return getConnectionDirection(from, to)?.disabledTools;
}

/**
 * Whether `fromId`'s connection to `toId`, both on this computer, has Wake it
 * on (#3215): as saved, else as the source that bound it started it (#3214).
 */
export function localConnectionWakeOn(fromId: string, toId: string): boolean {
  const saved = getConnectionDirection({ agentId: fromId }, { agentId: toId });
  if (saved) return localWakeOn(saved);
  const live = bindingManager.getBindingsForAgent(fromId).find((b) => b.targetKind === 'agent' && b.targetId === toId);
  return localWakeOn(undefined, live?.enabledTools) && !live?.disabledTools?.includes(WAKE_TOOL);
}

/** Every entry where the agent sends or receives. */
export function listConnectionDirections(agentId: string): ConnectionDirection[] {
  return entries().filter((d) => d.from.agentId === agentId || d.to.agentId === agentId);
}

/** Committed display metadata only: no optimistic cache, temp cleanup, migration or permission writes. */
export function listConnectionDirectionsForInspection(agentId: string): ConnectionDirection[] {
  const raw = peekStoredSettingsSync('connection-grants.json');
  if (raw === 'missing') return [];
  if (raw === 'unreadable' || !Array.isArray(raw.directions)
    || (raw.version !== undefined && raw.version !== CONNECTION_GRANTS_VERSION)) {
    throw new Error('Saved connection direction metadata could not be read. Its files were left unchanged.');
  }
  const directions = raw.directions.map(normalizeConnectionDirection);
  if (!directions.every((direction): direction is ConnectionDirection => direction !== null)
    || new Set(directions.map((direction) => directionKey(direction.from, direction.to))).size !== directions.length) {
    throw new Error('Saved connection direction metadata is invalid or ambiguous. Its files were left unchanged.');
  }
  return directions.filter((direction) => direction.from.agentId === agentId || direction.to.agentId === agentId);
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
      ...(current?.link && { link: current.link }), ...(current?.agentLinks && { agentLinks: current.agentLinks }), updatedAt: new Date().toISOString(),
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
 * Replace several directions' lists in one write, with their Dispatcher or
 * agent author retained for subsequent ownership checks.
 * `guard` sees each direction's entry under the store's lock, so a user's
 * write that lands after the caller looked is seen too; it throws to refuse,
 * and then nothing is written. Returning false leaves that direction alone.
 */
export async function setConnectionDirections(
  changes: readonly DirectionToolsChange[],
  guard: (current: ConnectionDirection | undefined, change: DirectionToolsChange) => void | false,
  options: { agentId?: string; precondition?: SettingsCommitPrecondition } = {},
): Promise<ConnectionDirection[]> {
  if (!writable()) throw new Error('This connection file was saved by a newer Clubhouse, so this one won’t change it.');
  let written: ConnectionDirection[] = [];
  await store.update((file) => {
    const list = (Array.isArray(file.directions) ? file.directions : []).map(normalizeConnectionDirection).filter((d): d is ConnectionDirection => !!d);
    const now = new Date().toISOString();
    const next = changes.flatMap((c): ConnectionDirection[] => {
      const current = list.find((d) => directionKey(d.from, d.to) === directionKey(c.from, c.to));
      if (guard(current, c) === false) return [];
      return [{
        from: c.from, to: c.to, disabledTools: [...new Set(c.disabledTools)],
        ...(c.enabledTools.length > 0 && { enabledTools: [...new Set(c.enabledTools)] }),
        ...(options.agentId ? { setByAgent: options.agentId } : { setBy: 'dispatcher' as const }),
        ...(current?.link && { link: current.link }), ...(current?.agentLinks && { agentLinks: current.agentLinks }), updatedAt: now,
      }];
    });
    const keys = new Set(next.map((d) => directionKey(d.from, d.to)));
    written = next;
    return { ...file, version: CONNECTION_GRANTS_VERSION, directions: [...list.filter((d) => !keys.has(directionKey(d.from, d.to))), ...next] };
  }, options.precondition);
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

/** Roll back only entries this call wrote, never a user's intervening edit. */
export async function rollBackConnectionDirections(written: readonly ConnectionDirection[]): Promise<void> {
  if (written.length === 0) return;
  if (!writable()) throw new Error('This connection file was saved by a newer Clubhouse, so this one won’t change it.');
  await store.update((file) => ({
    ...file,
    directions: (Array.isArray(file.directions) ? file.directions : []).filter((raw) => {
      const current = normalizeConnectionDirection(raw);
      return !current || !written.some((d) => JSON.stringify(d) === JSON.stringify(current));
    }),
  }));
  for (const d of written) {
    for (const listener of [...listeners]) {
      try { listener(d.from, d.to); } catch {
        // telemetry-exempt: one listener failing must not stop the others
      }
    }
  }
}

/**
 * Save the lists a direction starts with, only where it has no entry yet
 * (decided under the store's lock): a connection Clubhouse made (#3214), so a
 * choice saved meanwhile stands. Returns whether it was written.
 */
export async function fillConnectionTools(from: AgentAddress, to: AgentAddress, disabledTools: readonly string[], enabledTools: readonly string[] = []): Promise<boolean> {
  let written = false;
  await updateDirection(from, to, (current) => {
    if (current) return UNCHANGED;
    written = true;
    const enabled = [...new Set(enabledTools)];
    return { from, to, disabledTools: [...new Set(disabledTools)], ...(enabled.length > 0 && { enabledTools: enabled }), updatedAt: new Date().toISOString() };
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
      ...(current?.agentLinks && { agentLinks: current.agentLinks }),
      updatedAt: new Date().toISOString(),
    };
  });
}

/** Add explicit user links atomically; only absent directions get new-connection defaults. */
export async function linkConnectionDirections(pairs: readonly Pick<ConnectionDirection, 'from' | 'to'>[]): Promise<ConnectionDirection[]> {
  const requested = new Map<string, Pick<ConnectionDirection, 'from' | 'to'>>();
  for (const pair of pairs) {
    const valid = normalizeConnectionDirection(pair);
    if (!valid) throw new Error('That connection address is not valid.');
    requested.set(directionKey(valid.from, valid.to), { from: valid.from, to: valid.to });
  }
  if (requested.size === 0) return [];
  const written: ConnectionDirection[] = [];
  await store.update((file) => {
    if (file.version !== undefined && file.version > CONNECTION_GRANTS_VERSION) throw new Error('This connection file was saved by a newer Clubhouse, so this one won’t change it.');
    if (!Array.isArray(file.directions)) throw new Error('The saved connection directions are not a list, so this version will not change them.');
    // Read through the normalizer, but do not rewrite unrelated or already-linked raw records.
    const directions = [...file.directions];
    const list = directions.map(normalizeConnectionDirection);
    const now = new Date().toISOString();
    for (const [key, { from, to }] of requested) {
      const index = list.findIndex((d) => d && directionKey(d.from, d.to) === key);
      const current = list[index];
      if (current?.link) continue;
      const enabled = current ? current.enabledTools : NEW_CONNECTION_SWITCHES.enabledTools;
      const next: ConnectionDirection = {
        from, to, disabledTools: [...(current?.disabledTools ?? NEW_CONNECTION_SWITCHES.disabledTools)],
        ...(enabled && enabled.length > 0 && { enabledTools: [...enabled] }),
        link: { createdAt: now }, ...(current?.agentLinks && { agentLinks: current.agentLinks }), updatedAt: now,
      };
      if (index >= 0) directions[index] = next;
      else directions.push(next);
      written.push(next);
    }
    return written.length === 0 ? file : { ...file, version: CONNECTION_GRANTS_VERSION, directions };
  });
  for (const d of written) {
    for (const listener of [...listeners]) {
      try {
        listener(d.from, d.to);
      } catch {
        // telemetry-exempt: the fixed appLog warning reports failure without exposing listener details
        appLog('core:mcp', 'warn', 'Could not notify a connection-permissions listener after saving grants');
      }
    }
  }
  return written;
}


function cHasRemoteSender(pair: Pick<ConnectionDirection, 'from' | 'to'>): boolean { return !!pair.from.machineId; }

/** Update an agent-created network source under the store lock. */
export async function updateAgentNetworkLinks(
  pairs: readonly Pick<ConnectionDirection, 'from' | 'to'>[],
  owner: { agentId: string; machineId: string; name?: string },
  action: 'add' | 'remove' | 'tools',
  disabled?: readonly (readonly string[])[],
): Promise<ConnectionDirection[]> {
  if (!writable()) throw new Error('This connection file was saved by a newer Clubhouse.');
  const written: ConnectionDirection[] = [];
  await store.update((file) => {
    if (file.version !== undefined && file.version > CONNECTION_GRANTS_VERSION) throw new Error('This connection file was saved by a newer Clubhouse.');
    if (!Array.isArray(file.directions)) throw new Error('Saved connection directions are invalid.');
    const directions = [...file.directions];
    const now = new Date().toISOString();
    for (const [i, pair] of pairs.entries()) {
      const key = directionKey(pair.from, pair.to);
      const index = directions.findIndex((raw) => { const d = normalizeConnectionDirection(raw); return d && directionKey(d.from, d.to) === key; });
      const current = index < 0 ? undefined : normalizeConnectionDirection(directions[index]) ?? undefined;
      const links = current?.agentLinks ?? [];
      const active = activeAgentLinks(current);
      const mine = active.some((l) => l.agentId === owner.agentId && l.machineId === owner.machineId);
      if (action !== 'add' && !mine) throw new Error('You did not make that connection source.');
      if (action === 'tools' && (current?.link || active.length !== 1 || current.setByAgent !== owner.agentId || (cHasRemoteSender(pair) && current.agentToolsProtected !== false))) throw new Error('Another source or the user owns these switches.');
      if (action === 'add' && disabled?.[i] && current && (current.link || active.length || current.setByAgent !== owner.agentId)) throw new Error('That direction already has saved switches.');
      if (action === 'add' && !mine && links.length >= 50 && !links.some((l) => l.agentId === owner.agentId && l.machineId === owner.machineId)) throw new Error('This direction has too many saved agent sources.');
      if (action === 'add' && links.some((l) => l.removedByUser)) throw new Error('The user removed an agent source. Only the user can reconnect it.');
      const nextLinks = action === 'add' && !mine ? [...links.filter((l) => l.agentId !== owner.agentId || l.machineId !== owner.machineId), { ...owner, createdAt: new Date(Math.max(Date.parse(now), ...links.filter((l) => l.agentId === owner.agentId && l.machineId === owner.machineId).map((l) => Date.parse(l.removedAt ?? l.createdAt) + 1))).toISOString() }]
        : action === 'remove' ? links.map((l) => l.agentId === owner.agentId && l.machineId === owner.machineId ? { ...l, removedAt: new Date(Math.max(Date.parse(now), Date.parse(l.createdAt) + 1)).toISOString() } : l) : links;
      const next: ConnectionDirection = {
        ...current, ...pair,
        disabledTools: [...(disabled?.[i] ?? current?.disabledTools ?? NEW_CONNECTION_SWITCHES.disabledTools)],
        ...(nextLinks.length ? { agentLinks: nextLinks } : { agentLinks: undefined }),
        ...((action === 'tools' || (action === 'add' && (!current || !!disabled?.[i]))) && { setByAgent: owner.agentId }),
        updatedAt: now,
      };
      if (index < 0) directions.push(next); else directions[index] = next;
      written.push(next);
    }
    return { ...file, version: CONNECTION_GRANTS_VERSION, directions };
  });
  for (const d of written) for (const listener of [...listeners]) {
    try { listener(d.from, d.to); } catch { /* telemetry-exempt: other listeners still run */ }
  }
  return written;
}

/** Remove every agent-created network source on a direction at the user's request. */
export function removeAgentNetworkSources(from: AgentAddress, to: AgentAddress, options: { byUser?: boolean } = {}): Promise<ConnectionDirection | null> {
  return updateDirection(from, to, (current) => activeAgentLinks(current).length
    ? { ...current!, agentLinks: current!.agentLinks!.map((l) => l.removedAt ? l : ({ ...l, removedAt: new Date(Math.max(Date.now(), Date.parse(l.createdAt) + 1)).toISOString(), ...(options.byUser !== false && { removedByUser: true }) })), updatedAt: new Date().toISOString() } : UNCHANGED);
}

/** The person explicitly reconnected a pair, so agent-source removals no longer block it. */
export function clearUserRemovedAgentNetworkSources(from: AgentAddress, to: AgentAddress): Promise<ConnectionDirection | null> {
  if (!getConnectionDirection(from, to)?.agentLinks?.some((link) => link.removedByUser)) return Promise.resolve(null);
  return updateDirection(from, to, (current) => {
    if (!current?.agentLinks?.some((link) => link.removedByUser)) return UNCHANGED;
    const now = Date.now();
    return { ...current, agentLinks: current.agentLinks.map((link) => link.removedByUser
      ? { ...link, removedByUser: undefined, removedAt: new Date(Math.max(now, Date.parse(link.removedAt ?? link.createdAt) + 1)).toISOString() } : link), updatedAt: new Date(now).toISOString() };
  });
}

/**
 * Write one direction as given, `updatedAt` included, when it's newer than the
 * entry here (decided under the store's lock): another machine's copy of a
 * direction between it and this one (#3064, D234). Returns whether it was written.
 */
export async function putConnectionDirection(direction: ConnectionDirection, options: { allowUserReconnect?: boolean } = {}): Promise<boolean> {
  let applied = false;
  await updateDirection(direction.from, direction.to, (current) => {
    const incoming = direction.agentLinks;
    const merged = new Map((current?.agentLinks ?? []).map((link) => [`${link.agentId}\u0000${link.machineId}`, link]));
    for (const link of incoming ?? []) {
      const key = `${link.agentId}\u0000${link.machineId}`;
      const prior = merged.get(key);
      if (prior?.removedByUser && !link.removedAt) continue;
      if (!prior || Date.parse(link.removedAt ?? link.createdAt) > Date.parse(prior.removedAt ?? prior.createdAt) || (link.removedAt && !prior.removedAt && link.removedAt === prior.createdAt)) {
        // Only a newer, explicit removal tombstone from an authenticated endpoint
        // can clear a user removal. Active sources alone never clear it.
        const reconnect = options.allowUserReconnect && !!link.removedAt && !link.removedByUser;
        merged.set(key, prior?.removedByUser && !reconnect ? { ...link, removedByUser: true } : link);
      }
    }
    const newer = !current || Date.parse(current.updatedAt) < Date.parse(direction.updatedAt);
    const links = [...merged.values()];
    if (links.length > 50) throw new Error('This direction has too many saved agent sources to merge safely.');
    const protectedState = direction.agentToolsProtected ?? current?.agentToolsProtected;
    if (!newer && protectedState === current?.agentToolsProtected && JSON.stringify(links) === JSON.stringify(current?.agentLinks ?? [])) return UNCHANGED;
    applied = true;
    return { ...(newer ? direction : current!), ...(protectedState !== undefined && { agentToolsProtected: protectedState }), ...(links.length ? { agentLinks: links } : { agentLinks: undefined }) };
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
      directions: list.filter((d) => (d.from.agentId !== agentId && d.to.agentId !== agentId) || (options.keepOtherMachines && (!!d.from.machineId || !!d.to.machineId || !!d.agentLinks?.length))),
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
 * given is written only where the store has no entry for it yet, or where
 * `replaceIf` says the entry there may go (both decided under the store's
 * lock), and the marker is kept so it never runs again (#3215). Returns the
 * directions it wrote, or null when the change was already made.
 */
export async function runConnectionMigration(
  name: string, directions: readonly ConnectionDirection[], replaceIf: (current: ConnectionDirection, next: ConnectionDirection) => boolean = () => false,
): Promise<ConnectionDirection[] | null> {
  if (!writable()) throw new Error('This connection file was saved by a newer Clubhouse, so this one won’t change it.');
  let written = null as ConnectionDirection[] | null;
  await store.update((file) => {
    const done = Array.isArray(file.migrations) ? file.migrations.filter((m): m is string => typeof m === 'string') : [];
    if (done.includes(name)) return file;
    const list = (Array.isArray(file.directions) ? file.directions : []).map(normalizeConnectionDirection).filter((d): d is ConnectionDirection => !!d);
    const current = new Map(list.map((d) => [directionKey(d.from, d.to), d]));
    written = directions.filter((d) => {
      const there = current.get(directionKey(d.from, d.to));
      return !there || replaceIf(there, d);
    });
    const replaced = new Set(written.map((d) => directionKey(d.from, d.to)));
    return { ...file, version: CONNECTION_GRANTS_VERSION, directions: [...list.filter((d) => !replaced.has(directionKey(d.from, d.to))), ...written], migrations: [...done, name] };
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
