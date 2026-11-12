/**
 * Connection permissions in the live bindings (D129, #2969, #2972).
 *
 * - A new agent-to-agent binding takes its disabled tools from the store.
 * - A binding a source restores with its own list (a canvas wire saved
 *   before the store) keeps the store's list when it has one, and moves its
 *   own into the store when it doesn't: the migration, pair by pair.
 * - A store write updates the live binding, so calls are checked against the
 *   store by the existing call path (tool-registry's disabled tools).
 * - The user's own links (Make two-way) are a persisted binding source.
 */

import type { AgentAddress, ConnectionDirection, DirectionTools } from '../../shared/connection-grants';
import {
  NEW_CONNECTION_ENABLED_TOOLS, NEW_CONNECTION_SWITCHES, WAKE_TOOL, directionKey, localDirectionTools,
} from '../../shared/connection-grants';
import type { BindingTargetKind } from './clubhouse-mcp/types';
import { bindingManager, type RestoreOptions } from './clubhouse-mcp/binding-manager';
import {
  connectionGrantsWritable, connectionMigrationDone, deniedConnectionTools, fillConnectionTools, getConnectionDirection, listLinkedDirections, onConnectionGrantsChanged,
  linkConnectionDirections, listConnectionDirections, runConnectionMigration, setConnectionLink, setConnectionTools,
} from './connection-grants-store';
import { appLog } from './log-service';
import { recordConnectionChange } from './grant-telemetry';
import * as agentConfig from './agent-config';
import * as projectStore from './project-store';
import {
  clearBindingRemovedByUser, collectSourcesByPair, isBindingRemovedByUser, listPairsWithoutTools, listStartingTools, onBindingRemovedByUser, registerPersistedBindingSource,
  rebuildPersistedBindings,
  type PersistedBinding, type PersistedBindingSource,
} from './persisted-bindings';
import { removeConnectionDirection, removeConnectionDirections } from './connection-grants-store';
import { formatAgentAddress, parseAgentAddress, routeOf } from '../../shared/agent-address';
import * as annexIdentity from './annex-identity';
import { isNetworkComputer, remoteAgentName, rememberRemoteAgentName } from './annex-agent-calls';

export const USER_CONNECTION_SOURCE_ID = 'user-connections';
/** The user's links to agents on other machines (#3064). */
export const NETWORK_CONNECTION_SOURCE_ID = 'network-connections';

const local = (agentId: string): AgentAddress => ({ agentId });

/**
 * A binding end as a store address: a bare id is this machine's, and so is an
 * address naming this machine; another machine's keeps its machine (#3064).
 */
export function connectionEnd(id: string): AgentAddress {
  const address = parseAgentAddress(id);
  const route = routeOf(address, address.machine ? annexIdentity.getIdentity()?.fingerprint : undefined);
  return 'machine' in route ? { agentId: address.agentId, machineId: route.machine } : { agentId: address.agentId };
}

/** The binding target id for a store address: the bare id here, `agentId@machine` elsewhere. */
export function bindingTargetOf(end: AgentAddress): string {
  return end.machineId ? formatAgentAddress({ agentId: end.agentId, machine: end.machineId }) : end.agentId;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let newerFileLogged = false;

/**
 * Whether connection-grants.json was saved by a newer Clubhouse, so this one
 * won't change it. Said once per process, not on every rebuild.
 */
export function connectionFileIsNewer(): boolean {
  if (connectionGrantsWritable()) return false;
  if (!newerFileLogged) {
    newerFileLogged = true;
    appLog('core:mcp', 'warn', 'Connection permissions were saved by a newer Clubhouse, so this one won’t change them; new connections keep their starting tools only while running');
  }
  return true;
}

/** For tests: say the newer-file warning again. */
export function _resetConnectionFileWarningForTesting(): void {
  newerFileLogged = false;
}

const sameTools = (a: readonly string[] | undefined, b: readonly string[]) => (a ?? []).length === b.length && b.every((t) => a!.includes(t));

/** The live binding of one agent-to-agent direction. */
const liveAgentBinding = (agentId: string, targetId: string) => bindingManager.getBindingsForAgent(agentId).find((b) => b.targetKind === 'agent' && b.targetId === targetId);

/**
 * Restore: the store wins; a list it doesn't have moves in. `starting`: the
 * lists a connection Clubhouse made starts with (#3214), its switches turned
 * on (wake) included, whichever source bound the pair. A saved direction (an
 * explicit everything-on included) is left as it is; otherwise the lists
 * apply, and they're saved once the one-time pass has run (it decides for
 * connections made before it), never over a choice saved meanwhile. A start
 * with every connection tool on is never saved: with no entry, the live
 * binding says that, wake included.
 */
function restoreTools(agentId: string, targetId: string, targetKind: BindingTargetKind, legacy: string[], options: Partial<RestoreOptions> = {}): void {
  if (targetKind !== 'agent') {
    bindingManager.setDisabledTools(agentId, targetId, legacy);
    return;
  }
  const saved = deniedConnectionTools(local(agentId), connectionEnd(targetId));
  if (options.starting) {
    // Bind and every store write keep the live list in step with a saved one.
    if (saved) return;
    const enabled = options.enabledTools ?? [];
    const live = bindingManager.getBindingsForAgent(agentId).find((b) => b.targetId === targetId);
    if (!sameTools(live?.disabledTools, legacy) || !sameTools(live?.enabledTools, enabled)) bindingManager.setDisabledTools(agentId, targetId, legacy, enabled);
    if (legacy.length === 0 || !connectionMigrationDone(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION) || connectionFileIsNewer()) return;
    void fillConnectionTools(local(agentId), connectionEnd(targetId), legacy, enabled).catch((err) => {
      // telemetry-exempt: logged; the live binding already has the list, and the next rebuild tries again
      appLog('core:mcp', 'warn', 'Could not save the tools a new connection starts with', { meta: { agentId, targetId, error: errorText(err) } });
    });
    return;
  }
  if (saved) {
    bindingManager.setDisabledTools(agentId, targetId, saved);
    return;
  }
  bindingManager.setDisabledTools(agentId, targetId, legacy);
  if (connectionFileIsNewer()) return;
  void setConnectionTools(local(agentId), connectionEnd(targetId), legacy).then(() => {
    recordConnectionChange({ fromAgentId: agentId, toAgentId: targetId, disabledTools: legacy, migrated: true });
  }, (err) => {
    // telemetry-exempt: logged; the live binding already has the list, and the next restore tries again
    appLog('core:mcp', 'warn', 'Could not move a wire’s disabled tools into the connection store', { meta: { agentId, targetId, error: errorText(err) } });
  });
}

/**
 * Set one direction's disabled tools: the store for an agent-to-agent
 * direction (an edit from the canvas popover or the Connections card), the
 * binding alone for any other target. `restore`: a canvas wire bound again,
 * whose list only fills a store that has none. `start`: a wire the user just
 * drew, which starts with wake on too (the maintainer's default, 2026-11-09).
 */
export async function applyConnectionTools(agentId: string, targetId: string, disabledTools: string[], options: { restore?: boolean; start?: boolean } = {}): Promise<string[]> {
  const binding = bindingManager.getBindingsForAgent(agentId).find((b) => b.targetId === targetId);
  const targetKind = binding?.targetKind;
  if (targetKind && targetKind !== 'agent') {
    bindingManager.setDisabledTools(agentId, targetId, disabledTools);
    return disabledTools;
  }
  if (options.restore) {
    // A canvas wire bound again only fills a store that has nothing, live binding or not.
    const saved = deniedConnectionTools(local(agentId), connectionEnd(targetId));
    if (saved) {
      if (binding) bindingManager.setDisabledTools(agentId, targetId, saved);
      return saved;
    }
    if (!binding) return disabledTools; // kind unknown: nothing is written
    restoreTools(agentId, targetId, 'agent', disabledTools);
    return disabledTools;
  }
  // An edit (the canvas popover, the Connections card), or a sleeping agent's wire: the store, then the binding follows.
  const before = deniedConnectionTools(local(agentId), connectionEnd(targetId));
  // A new wire turns wake on. A first edit on a direction with nothing saved keeps the wake its source started it with.
  const enabled = options.start
    ? [...NEW_CONNECTION_ENABLED_TOOLS]
    : before === undefined && !connectionEnd(targetId).machineId ? [...(liveAgentBinding(agentId, targetId)?.enabledTools ?? [])] : undefined;
  await setConnectionTools(local(agentId), connectionEnd(targetId), disabledTools, enabled);
  // Recorded only when it changed something: the popover saving the same list again isn't a change.
  const same = before !== undefined && before.length === new Set(disabledTools).size && disabledTools.every((t) => before.includes(t));
  if (!same) recordConnectionChange({ fromAgentId: agentId, toAgentId: targetId, disabledTools });
  return disabledTools;
}

/**
 * Turn Wake it on or off for one direction between two agents on this
 * computer (#3215), the user's switch on the Connections card. The other
 * tools stay as they are; a direction with no entry yet starts from its live
 * binding's list.
 */
export async function setLocalWake(fromAgentId: string, toAgentId: string, on: boolean): Promise<void> {
  const from = local(fromAgentId);
  const to = connectionEnd(toAgentId);
  if (to.machineId) throw new Error('That agent is on another computer.');
  const current = getConnectionDirection(from, to);
  const live = liveAgentBinding(fromAgentId, toAgentId);
  const disabledTools = (current?.disabledTools ?? live?.disabledTools ?? []).filter((t) => t !== WAKE_TOOL);
  const enabled = ((current ? current.enabledTools : live?.enabledTools) ?? []).filter((t) => t !== WAKE_TOOL);
  await setConnectionTools(from, to, disabledTools, on ? [...enabled, WAKE_TOOL] : enabled);
  recordConnectionChange({ fromAgentId, toAgentId, disabledTools: on ? disabledTools : [...disabledTools, WAKE_TOOL] });
}

/**
 * One direction's switches read back (#3215): its saved entry, else the live
 * binding's lists (its source's start, #3214).
 */
export function readLocalDirectionTools(fromAgentId: string, toAgentId: string): DirectionTools {
  const live = liveAgentBinding(fromAgentId, toAgentId);
  return localDirectionTools(getConnectionDirection(local(fromAgentId), local(toAgentId)), live?.disabledTools ?? [], live?.enabledTools ?? []);
}

/**
 * A link the Dispatcher made is gone (#3215), so the tools it set on that
 * direction aren't its any more. Nothing binds the pair: they go, so a wire
 * the user draws later starts like any new one. Another source still binds it
 * (a canvas wire, a helper link): the direction goes back to a new
 * connection's defaults, clear and compact off and wake on (2026-11-09), the
 * user's from now on. Tools the user set are left alone.
 */
export async function forgetDispatcherDirection(fromAgentId: string, toAgentId: string): Promise<void> {
  const entry = getConnectionDirection(local(fromAgentId), local(toAgentId));
  if (entry?.setBy !== 'dispatcher' || entry.link) return;
  if (!bindingManager.getBindingsForAgent(fromAgentId).some((b) => b.targetId === toAgentId)) {
    await removeConnectionDirection(local(fromAgentId), local(toAgentId));
    return;
  }
  // setConnectionTools is the user's write: the Dispatcher's mark goes.
  await setConnectionTools(local(fromAgentId), local(toAgentId), [...NEW_CONNECTION_SWITCHES.disabledTools], [...NEW_CONNECTION_SWITCHES.enabledTools]);
}

/**
 * The done marker of the one-time pass below, in connection-grants.json. Named
 * for the maintainer's defaults (2026-11-09), so a build that ran an earlier
 * draft of this pass runs it again: it only fills directions with nothing saved.
 */
export const AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION = 'connection-defaults-3214-2026-11-09';

let automaticDeferralLogged = false;

/**
 * Once, after a rebuild, the maintainer's defaults (2026-11-09) for
 * connections made before them, only where nothing is saved:
 * - Each direction a source Clubhouse connects with (helper and Dispatcher
 *   links, an orchestrator's connections; `sourceIds`) lists gets the
 *   starting lists that source gave at its last collect, whichever source
 *   bound the pair (a canvas wire with no list included). One that starts
 *   with every connection tool on gets no entry: its binding says so.
 * - A wire the user drew (`drawnSourceIds`, the canvas) with no list of its
 *   own, that none of those lists, starts like a new connection: clear and
 *   compact off, wake on.
 * Every saved direction is left exactly as it is, including the old
 * new-connection defaults with wake off (#3333).
 * Waits while a source can't be read, or the file is a newer build's. Until
 * this has run, a new connection's lists are live only; from then on they're
 * kept (restoreTools).
 */
export async function migrateAutomaticConnectionTools(sourceIds: readonly string[], drawnSourceIds: readonly string[] = []): Promise<'done' | 'already' | 'deferred'> {
  if (connectionMigrationDone(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION)) return 'already';
  if (connectionFileIsNewer()) return 'deferred';
  const { failed } = await collectSourcesByPair();
  if (failed.length > 0) {
    if (!automaticDeferralLogged) {
      automaticDeferralLogged = true;
      appLog('core:mcp', 'info', 'Connection defaults for helper and Dispatcher links wait: a connection source could not be read', { meta: { failed } });
    }
    return 'deferred';
  }
  const now = new Date().toISOString();
  const directions: ConnectionDirection[] = [];
  const seen = new Set<string>();
  const fill = (agentId: string, targetId: string, disabledTools: readonly string[], enabledTools: readonly string[]) => {
    const key = directionKey(local(agentId), local(targetId));
    if (seen.has(key)) return;
    seen.add(key);
    if (disabledTools.length === 0 || connectionEnd(targetId).machineId || isBindingRemovedByUser(agentId, targetId)) return;
    if (getConnectionDirection(local(agentId), local(targetId))) return;
    directions.push({
      from: local(agentId), to: local(targetId), disabledTools: [...disabledTools], ...(enabledTools.length > 0 && { enabledTools: [...enabledTools] }), updatedAt: now,
    });
  };
  for (const id of sourceIds) {
    for (const t of listStartingTools(id)) fill(t.agentId, t.targetId, t.disabledTools, t.enabledTools);
  }
  for (const id of drawnSourceIds) {
    for (const p of listPairsWithoutTools(id)) fill(p.agentId, p.targetId, NEW_CONNECTION_SWITCHES.disabledTools, NEW_CONNECTION_SWITCHES.enabledTools);
  }
  const written = await runConnectionMigration(
    AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION,
    directions,
  );
  if (written === null) return 'already';
  appLog('core:mcp', 'info', 'Connections made before the 2026-11-09 defaults now keep the tools they start with', {
    meta: { directions: written.length, pairs: written.map((d) => `${d.from.agentId}>${d.to.agentId}`) },
  });
  return 'done';
}

/** The user's links: one binding per direction with a link. */
const userConnectionSource: PersistedBindingSource = {
  id: USER_CONNECTION_SOURCE_ID,
  prune: true,
  async collect() {
    const linked = allLinked();
    if (linked.length === 0) return [];
    const names = await agentNames();
    // Only between agents that still exist: a deleted agent's link isn't bound again.
    return linked.filter((d) => names.has(d.from.agentId) && names.has(d.to.agentId)).map((d): PersistedBinding => ({
      agentId: d.from.agentId,
      targetId: d.to.agentId,
      targetKind: 'agent',
      label: names.get(d.to.agentId) ?? d.to.agentId,
      ...(names.get(d.from.agentId) && { agentName: names.get(d.from.agentId) }),
      ...(names.get(d.to.agentId) && { targetName: names.get(d.to.agentId) }),
      ...(d.disabledTools.length > 0 && { disabledTools: d.disabledTools }),
    }));
  },
};

/**
 * The user's links from an agent here to one on another machine (#3064). The
 * target's name is the one its machine gave; the binding's id is its address.
 */
const networkConnectionSource: PersistedBindingSource = {
  id: NETWORK_CONNECTION_SOURCE_ID,
  prune: true,
  async collect() {
    const linked = listLinkedDirections().filter((d) => !d.from.machineId && !!d.to.machineId);
    if (linked.length === 0) return [];
    const names = await agentNames();
    return linked.filter((d) => names.has(d.from.agentId)).map((d): PersistedBinding => {
      const targetId = bindingTargetOf(d.to);
      const targetName = remoteAgentName(targetId) ?? d.to.agentId;
      return {
        agentId: d.from.agentId,
        targetId,
        targetKind: 'agent',
        label: targetName,
        targetName,
        ...(names.get(d.from.agentId) && { agentName: names.get(d.from.agentId) }),
        ...(d.disabledTools.length > 0 && { disabledTools: d.disabledTools }),
      };
    });
  },
};

/**
 * Connect an agent here with an agent on another machine (#3064): the user's
 * link from here to there, and with `twoWay` the one back, each starting like
 * a new connection. The other machine gets both when it's next connected.
 */
export async function connectAcrossMachines(agentId: string, address: string, options: { twoWay?: boolean; name?: string } = {}): Promise<void> {
  const other = connectionEnd(address);
  if (!other.machineId) throw new Error('That agent is on this computer.');
  if (!isNetworkComputer(other.machineId)) throw new Error('Agents connect only with computers in this Annex Network.');
  if (options.name) await rememberRemoteAgentName(bindingTargetOf(other), options.name);
  await linkConnectionDirections([
    { from: local(agentId), to: other },
    ...(options.twoWay ? [{ from: other, to: local(agentId) }] : []),
  ]);
  clearBindingRemovedByUser(agentId, bindingTargetOf(other));
  await rebuildPersistedBindings();
}

/**
 * Set the tools turned off on one direction between an agent here and one on
 * another machine (#3064): `outgoing` from here to there, else from there to
 * here. The other machine gets the change when connected.
 */
export async function setToolsAcrossMachines(agentId: string, address: string, outgoing: boolean, disabledTools: string[]): Promise<void> {
  const other = connectionEnd(address);
  if (!other.machineId) throw new Error('That agent is on this computer.');
  const [from, to] = outgoing ? [local(agentId), other] : [other, local(agentId)];
  if (!getConnectionDirection(from, to)?.link) throw new Error('Those agents are not connected that way.');
  await setConnectionTools(from, to, disabledTools);
}

/** Remove the user's links between an agent here and one on another machine, both ways. */
export async function disconnectAcrossMachines(agentId: string, address: string): Promise<void> {
  const other = connectionEnd(address);
  if (!other.machineId) throw new Error('That agent is on this computer.');
  for (const [from, to] of [[local(agentId), other], [other, local(agentId)]] as const) {
    if (getConnectionDirection(from, to)?.link) await setConnectionLink(from, to, false);
  }
  await rebuildPersistedBindings();
}

/** Every direction with the user's link, on this machine. */
function allLinked(): ConnectionDirection[] {
  return listLinkedDirections().filter((d) => !d.from.machineId && !d.to.machineId);
}

async function agentNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const projects = await Promise.resolve().then(() => projectStore.peekProjects()).catch((): Array<{ path: string }> => []);
  for (const p of projects) {
    const agents = await Promise.resolve().then(() => agentConfig.peekDurableConfigs(p.path)).catch((): ReadonlyArray<{ id: string; name: string; disposedAt?: string }> => []);
    for (const a of agents) if (!(a as { disposedAt?: string }).disposedAt) names.set(a.id, a.name);
  }
  return names;
}

/**
 * Make a one-way connection two-way (#2972): the user's own link for the
 * other direction. Only a direction with nothing saved gets the new defaults.
 */
export async function makeTwoWay(fromAgentId: string, toAgentId: string): Promise<void> {
  await linkConnectionDirections([{ from: local(fromAgentId), to: local(toAgentId) }]);
  // Only a saved user link may override a previous removal.
  clearBindingRemovedByUser(fromAgentId, toAgentId);
  recordConnectionChange({ fromAgentId, toAgentId, disabledTools: getConnectionDirection(local(fromAgentId), local(toAgentId))?.disabledTools ?? [], link: true });
  await rebuildPersistedBindings();
}

/** Remove the user's own link for one direction. */
export async function removeUserLink(fromAgentId: string, toAgentId: string): Promise<void> {
  const hadLink = !!getConnectionDirection(local(fromAgentId), local(toAgentId))?.link;
  await setConnectionLink(local(fromAgentId), local(toAgentId), false);
  if (hadLink) recordConnectionChange({ fromAgentId, toAgentId, disabledTools: getConnectionDirection(local(fromAgentId), local(toAgentId))?.disabledTools ?? [], link: false });
  await rebuildPersistedBindings();
}

/** Wire the store into the live bindings. Returns the undo, for tests. */
/** Listeners in the renderer: a canvas updates its own copy of a wire's list (older builds read it). */
let notifyRenderer: ((from: string, to: string, disabledTools: string[]) => void) | null = null;

/** An agent was deleted: its directions go, and nothing binds them again. */
export async function forgetConnectionAgent(agentId: string): Promise<void> {
  // A link with an agent on another machine is turned off, not dropped, so that machine hears of it (#3064).
  for (const d of listConnectionDirections(agentId)) {
    if ((d.from.machineId || d.to.machineId) && d.link) {
      await setConnectionLink(d.from, d.to, false).catch((err) => {
        // telemetry-exempt: logged; the entry goes below either way
        appLog('core:mcp', 'warn', 'Could not turn off a deleted agent\u2019s link with another machine', { meta: { agentId, error: errorText(err) } });
      });
    }
  }
  await removeConnectionDirections(agentId, { keepOtherMachines: true }).catch((err) => {
    appLog('core:mcp', 'warn', 'Could not drop a deleted agent\u2019s connection permissions', { meta: { agentId, error: errorText(err) } });
  });
}

export function startConnectionGrants(options: { notify?: (from: string, to: string, disabledTools: string[]) => void } = {}): () => void {
  notifyRenderer = options.notify ?? null;
  bindingManager.setConnectionToolsSource(
    (agentId, targetId, targetKind) => (targetKind === 'agent' ? deniedConnectionTools(local(agentId), connectionEnd(targetId)) : undefined),
    restoreTools,
  );
  const unregister = registerPersistedBindingSource(userConnectionSource);
  // The user removed a pair, whatever held it (#3215): what the Dispatcher set on it goes once nothing binds it.
  const unwatchRemovals = onBindingRemovedByUser((agentId, targetId) => {
    void forgetDispatcherDirection(agentId, targetId).catch((err) => {
      // telemetry-exempt: logged; the pair is removed either way, and its entry holds only what the Dispatcher set
      appLog('core:mcp', 'warn', 'Could not drop the tools the Dispatcher set on a removed connection', { meta: { agentId, targetId, error: errorText(err) } });
    });
  });
  const unregisterNetwork = registerPersistedBindingSource(networkConnectionSource);
  const unsubscribe = onConnectionGrantsChanged((from, to) => {
    // A direction from another machine has no binding here: that machine's agent holds it (#3064).
    if (from.machineId) {
      notifyRenderer?.(bindingTargetOf(from), to.agentId, getConnectionDirection(from, to)?.disabledTools ?? []);
      return;
    }
    const entry = getConnectionDirection(from, to);
    const targetId = bindingTargetOf(to);
    bindingManager.setDisabledTools(from.agentId, targetId, entry?.disabledTools ?? []);
    notifyRenderer?.(from.agentId, targetId, entry?.disabledTools ?? []);
    // A link to or from another machine comes and goes with the store, which another machine may write.
    if (to.machineId) void rebuildPersistedBindings().catch(() => {});
  });
  // Names and deletions: the user's links follow agents and projects, as the other sources do.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (listLinkedDirections().length === 0) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = null; void rebuildPersistedBindings().catch(() => {}); }, 100);
  };
  const unwatch = [agentConfig.onAgentConfigChanged(changed), projectStore.onProjectsChanged(changed)];
  return () => {
    bindingManager.setConnectionToolsSource(null, null);
    unregister();
    unregisterNetwork();
    unwatchRemovals();
    unsubscribe();
    for (const u of unwatch) u();
    if (pending) clearTimeout(pending);
    notifyRenderer = null;
  };
}
