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
import { NEW_CONNECTION_DISABLED_TOOLS, WAKE_TOOL, localDirectionTools } from '../../shared/connection-grants';
import type { BindingTargetKind } from './clubhouse-mcp/types';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  connectionMigrationDone, deniedConnectionTools, fillConnectionTools, getConnectionDirection, listLinkedDirections, onConnectionGrantsChanged,
  listConnectionDirections, runConnectionMigration, setConnectionLink, setConnectionTools,
} from './connection-grants-store';
import { appLog } from './log-service';
import { recordConnectionChange } from './grant-telemetry';
import * as agentConfig from './agent-config';
import * as projectStore from './project-store';
import {
  clearBindingRemovedByUser, collectSourcesByPair, onBindingRemovedByUser, persistedPairKey, registerPersistedBindingSource, rebuildPersistedBindings,
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

/**
 * Restore: the store wins; a list it doesn't have moves in. `starting`: the
 * list a connection Clubhouse made starts with (#3214), kept once the one-time
 * pass has run (it decides for the connections made before it), and never
 * over a choice saved meanwhile.
 */
function restoreTools(agentId: string, targetId: string, targetKind: BindingTargetKind, legacy: string[], options: { starting?: boolean } = {}): void {
  if (targetKind !== 'agent') {
    bindingManager.setDisabledTools(agentId, targetId, legacy);
    return;
  }
  const saved = deniedConnectionTools(local(agentId), connectionEnd(targetId));
  if (saved) {
    bindingManager.setDisabledTools(agentId, targetId, saved);
    return;
  }
  bindingManager.setDisabledTools(agentId, targetId, legacy);
  if (options.starting) {
    if (!connectionMigrationDone(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION)) return;
    void fillConnectionTools(local(agentId), connectionEnd(targetId), legacy).catch((err) => {
      // telemetry-exempt: logged; the live binding already has the list, and the next restore tries again
      appLog('core:mcp', 'warn', 'Could not save the tools a new connection starts with', { meta: { agentId, targetId, error: errorText(err) } });
    });
    return;
  }
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
 * whose list only fills a store that has none.
 */
export async function applyConnectionTools(agentId: string, targetId: string, disabledTools: string[], options: { restore?: boolean } = {}): Promise<string[]> {
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
  await setConnectionTools(local(agentId), connectionEnd(targetId), disabledTools);
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
  const live = bindingManager.getBindingsForAgent(fromAgentId).find((b) => b.targetKind === 'agent' && b.targetId === toAgentId);
  const disabledTools = (current?.disabledTools ?? live?.disabledTools ?? []).filter((t) => t !== WAKE_TOOL);
  const enabled = (current?.enabledTools ?? []).filter((t) => t !== WAKE_TOOL);
  await setConnectionTools(from, to, disabledTools, on ? [...enabled, WAKE_TOOL] : enabled);
  recordConnectionChange({ fromAgentId, toAgentId, disabledTools: on ? disabledTools : [...disabledTools, WAKE_TOOL] });
}

/**
 * One direction's switches read back (#3215): its saved entry, else the live
 * binding's list, with wake as {@link localDirectionTools} reads it.
 */
export function readLocalDirectionTools(fromAgentId: string, toAgentId: string): DirectionTools {
  const live = bindingManager.getBindingsForAgent(fromAgentId).find((b) => b.targetKind === 'agent' && b.targetId === toAgentId);
  return localDirectionTools(getConnectionDirection(local(fromAgentId), local(toAgentId)), live?.disabledTools ?? []);
}

/**
 * A link the Dispatcher made is gone (#3215), so the tools it set on that
 * direction aren't its any more. Nothing binds the pair: they go, so a wire
 * the user draws later starts like any new one. Another source still binds it
 * (a canvas wire, a helper link): they stay as that wire's, the user's from
 * now on, with wake off, since the user never turned it on there. Tools the
 * user set are left alone.
 */
export async function forgetDispatcherDirection(fromAgentId: string, toAgentId: string): Promise<void> {
  const entry = getConnectionDirection(local(fromAgentId), local(toAgentId));
  if (entry?.setBy !== 'dispatcher' || entry.link) return;
  if (!bindingManager.getBindingsForAgent(fromAgentId).some((b) => b.targetId === toAgentId)) {
    await removeConnectionDirection(local(fromAgentId), local(toAgentId));
    return;
  }
  await setConnectionTools(local(fromAgentId), local(toAgentId), entry.disabledTools, (entry.enabledTools ?? []).filter((t) => t !== WAKE_TOOL));
}

/** The done marker of the one-time pass below, in connection-grants.json. */
export const AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION = 'automatic-connection-defaults-3214';

let automaticDeferralLogged = false;

/**
 * Once, after a rebuild: connections Clubhouse made before #3214 (helper and
 * Dispatcher links, an orchestrator's connections; `sourceIds`) had every
 * tool on. Each direction one of them lists, with nothing saved for it, keeps
 * the list it has live: its source's starting list, or none when a canvas wire
 * bound the pair first. A direction with saved tools (the user's, a canvas
 * wire's, a Make two-way link) is never touched, and one with everything on
 * gets no entry. Waits while a source can't be read: it may be the one that
 * binds the pair. Until this has run, a new connection's list is live only;
 * from then on it's kept (restoreTools).
 */
export async function migrateAutomaticConnectionTools(sourceIds: readonly string[]): Promise<'done' | 'already' | 'deferred'> {
  if (connectionMigrationDone(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION)) return 'already';
  const { bySource, failed } = await collectSourcesByPair();
  if (failed.length > 0) {
    if (!automaticDeferralLogged) {
      automaticDeferralLogged = true;
      appLog('core:mcp', 'info', 'Connection defaults for helper and Dispatcher links wait: a connection source could not be read', { meta: { failed } });
    }
    return 'deferred';
  }
  const listed = (agentId: string, targetId: string) => sourceIds.some((id) => bySource.get(id)?.has(persistedPairKey(agentId, targetId)));
  const now = new Date().toISOString();
  const directions: ConnectionDirection[] = [];
  for (const b of bindingManager.getAllBindings()) {
    if (b.targetKind !== 'agent' || !b.disabledTools?.length || connectionEnd(b.targetId).machineId) continue;
    if (!listed(b.agentId, b.targetId) || getConnectionDirection(local(b.agentId), local(b.targetId))) continue;
    directions.push({ from: local(b.agentId), to: local(b.targetId), disabledTools: [...b.disabledTools], updatedAt: now });
  }
  const written = await runConnectionMigration(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION, directions);
  if (written === null) return 'already';
  appLog('core:mcp', 'info', 'Helper and Dispatcher links made before #3214 now keep the tools they start with', {
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
  const link = async (from: AgentAddress, to: AgentAddress) => {
    // A direction already linked keeps its tools and its time, so the other machine's newer edits stand.
    if (getConnectionDirection(from, to)?.link) return;
    await setConnectionTools(from, to, [...NEW_CONNECTION_DISABLED_TOOLS]);
    await setConnectionLink(from, to, true);
  };
  await link(local(agentId), other);
  if (options.twoWay) await link(other, local(agentId));
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
 * other direction, starting like any new connection (read and message).
 */
export async function makeTwoWay(fromAgentId: string, toAgentId: string): Promise<void> {
  // The user's own act: a pair they removed this session may be connected again.
  clearBindingRemovedByUser(fromAgentId, toAgentId);
  const existing = getConnectionDirection(local(fromAgentId), local(toAgentId));
  // A new link starts like a new connection; only an existing link keeps its list.
  await setConnectionTools(local(fromAgentId), local(toAgentId), existing?.link ? existing.disabledTools : [...NEW_CONNECTION_DISABLED_TOOLS]);
  await setConnectionLink(local(fromAgentId), local(toAgentId), true);
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
