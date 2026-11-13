import { activeAgentLinks } from '../../shared/connection-grants';
import { federationStatus } from './dispatcher-federation-policy';
/**
 * The sources behind an agent's connections, and removing one of them
 * (#2744). Sources are read from what each persisted source lists
 * (collectSourcesByPair), not from the live bindings, so a removal that only
 * changed a binding can't look like it worked.
 *
 * A removal changes only that source, the way that source's own controls do:
 * - an orchestrator's link: dropped from its store, the binding released;
 * - a Dispatcher link: dropped and tombstoned, as a user removal on the
 *   canvas does, so the Dispatcher can't redraw it;
 * - Connect to Dispatcher: turned off on the agent at the other end, through
 *   its orchestration policy (lock, audit);
 * - canvas wires and helper links aren't removed here: the canvas and the
 *   Helpers page own them.
 * Other sources holding the pair keep it connected, and the result says so.
 */

import {
  removalRoute, type AgentConnectionSources, type ConnectionPairSources, type ConnectionSource, type ConnectionSourceKind,
  type RemoveConnectionSourceResult,
} from '../../shared/connection-sources';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { getDispatcherAgentId } from './dispatcher/dispatcher-service';
import { isRemovalUnsaved, listDispatcherLinksForUser, recordUserRemoval } from './dispatcher-connections';
import { saveWireRemoval } from './dispatcher-wire-source';
import { appLog } from './log-service';
import { connectionEnd, forgetDispatcherDirection, removeUserLink } from './connection-grants';
import { getConnectionDirection, removeAgentNetworkSources } from './connection-grants-store';
import type { DispatcherLink } from '../../shared/types';
import { removeStoredPair } from './orchestrator-connections';
import { collectSourcesByPair, inspectPersistedBindingSource, isBindingRemovedByUser, markBindingRemovedByUser, markSourceRemovedByUser, persistedPairKey, rebuildPersistedBindings, releaseSourceBinding, type PersistedBinding } from './persisted-bindings';

// The persisted sources' ids (persisted-bindings registrations), stable across releases.
const ORCHESTRATOR_CONNECTION_SOURCE_ID = 'orchestrator-connections';
const DISPATCHER_CONNECTION_SOURCE_ID = 'dispatcher-connections';
const KIND_BY_SOURCE: Readonly<Record<string, ConnectionSourceKind>> = {
  'canvas-wires': 'canvas',
  'helper-wires': 'helper',
  'dispatcher-wires': 'dispatcher_auto',
  [ORCHESTRATOR_CONNECTION_SOURCE_ID]: 'tool_link',
  [DISPATCHER_CONNECTION_SOURCE_ID]: 'dispatcher_link',
  'user-connections': 'user_link',
  'network-connections': 'user_link',
  'network-agent-connections': 'tool_link',
  'dispatcher-federation': 'dispatcher_federation',
  'group-project-membership': 'group_member',
};

const SUSPENDED_WHY: Readonly<Record<string, string>> = {
  dispatcher_off: 'The Dispatcher is off.',
  store_unwritable: 'Clubhouse can’t save to its connections file.',
  not_connected_to_dispatcher: 'One of these agents is not connected to the Dispatcher.',
};

/** Every pair touching the agent, in both directions, with the sources holding each. */
export async function listConnectionSources(agentId: string): Promise<AgentConnectionSources> {
  const { bySource, failed } = await collectSourcesByPair({ cachedOnly: true });
  const unreadable = new Set(failed);
  const inspectedPairs = new Map<string, Map<string, PersistedBinding>>();
  for (const sourceId of ['canvas-wires', 'dispatcher-wires', DISPATCHER_CONNECTION_SOURCE_ID]) {
    try {
      const inspected = await inspectPersistedBindingSource(sourceId);
      if (!inspected) continue;
      const bindings = Array.isArray(inspected) ? inspected : inspected.bindings;
      if ((!Array.isArray(inspected) && inspected.unverified?.length)
        || bindings.some((b) => !b.agentId || !b.targetId || !b.label?.trim()
          || (sourceId !== 'canvas-wires' && (b.targetKind !== 'agent' || !b.agentName?.trim() || !b.targetName?.trim())))) {
        throw new Error('Saved connection source metadata is unknown.');
      }
      const saved = new Map(bindings.filter((binding) => !isBindingRemovedByUser(binding.agentId, binding.targetId))
        .map((binding) => [persistedPairKey(binding.agentId, binding.targetId), binding]));
      inspectedPairs.set(sourceId, saved);
      bySource.set(sourceId, new Set(saved.keys()));
      unreadable.delete(sourceId);
    } catch (error) {
      // telemetry-exempt: appLog reports the error and the returned unreadable marker reaches the UI
      bySource.delete(sourceId);
      unreadable.add(sourceId);
      appLog('core:mcp', 'warn', 'Could not inspect saved connections', { meta: { sourceId, error: String(error) } });
    }
  }
  const automatic = inspectedPairs.get('dispatcher-wires');
  let links: DispatcherLink[];
  try {
    links = await listDispatcherLinksForUser({ strict: true });
  } catch (error) {
    // telemetry-exempt: appLog reports the error and the Dispatcher unreadable marker reaches the UI
    links = [];
    bySource.delete(DISPATCHER_CONNECTION_SOURCE_ID);
    unreadable.add(DISPATCHER_CONNECTION_SOURCE_ID);
    appLog('core:mcp', 'warn', 'Could not inspect saved Dispatcher links', { meta: { error: String(error) } });
  }
  const linkStatus = new Map(links.map((l) => [persistedPairKey(l.agentId, l.targetId), l]));
  const liveBindings = bindingManager.getAllBindings();
  const boundPairs = new Set(liveBindings.map((binding) => persistedPairKey(binding.agentId, binding.targetId)));
  const pairs = new Map<string, { agentId: string; targetId: string }>();
  const touches = (a: string, t: string) => a === agentId || t === agentId;
  for (const b of liveBindings) {
    if (b.targetKind === 'agent' && touches(b.agentId, b.targetId)) pairs.set(persistedPairKey(b.agentId, b.targetId), { agentId: b.agentId, targetId: b.targetId });
  }
  // A suspended Dispatcher link has no binding and isn't collected, but it is saved.
  for (const l of links) if (touches(l.agentId, l.targetId)) pairs.set(persistedPairKey(l.agentId, l.targetId), { agentId: l.agentId, targetId: l.targetId });
  for (const keys of bySource.values()) {
    for (const key of keys) {
      const [a, t] = key.split('\u0000');
      if (a && t && touches(a, t)) pairs.set(key, { agentId: a, targetId: t });
    }
  }
  const out: ConnectionPairSources[] = [];
  for (const [key, pair] of pairs) {
    const sources: ConnectionSource[] = [];
    for (const [sourceId, keys] of bySource) {
      if (!keys.has(key)) continue;
      const kind = KIND_BY_SOURCE[sourceId] ?? 'other';
      const link = kind === 'dispatcher_link' ? linkStatus.get(key) : undefined;
      const savedOnly = kind === 'dispatcher_auto' && automatic?.has(key) && !boundPairs.has(key);
      const makers = sourceId === 'network-agent-connections' ? activeAgentLinks(getConnectionDirection(connectionEnd(pair.agentId), connectionEnd(pair.targetId))) : undefined;
            const federationReason = kind === 'dispatcher_federation' ? federationStatus(connectionEnd(pair.agentId), connectionEnd(pair.targetId))?.reason : undefined;
      sources.push({ kind, sourceId, ...(makers?.length && { makers }), ...(federationReason && { suspended: federationReason }), ...(savedOnly && { suspended: 'Configured, but not connected now.' }),
        ...(link && link.status === 'suspended' && { suspended: SUSPENDED_WHY[link.reason ?? ''] ?? 'Suspended.' }) });
    }
    // A suspended Dispatcher link isn't collected (no binding), but it is still saved.
    const link = linkStatus.get(key);
    if (link && !sources.some((s) => s.kind === 'dispatcher_link')) {
      sources.push({ kind: 'dispatcher_link', sourceId: DISPATCHER_CONNECTION_SOURCE_ID, ...(link.status === 'suspended' && { suspended: SUSPENDED_WHY[link.reason ?? ''] ?? 'Suspended.' }) });
    }
    const bound = boundPairs.has(key);
    const saved = automatic?.get(key);
    out.push({ ...pair, bound, sources, ...(bound && sources.length === 0 && { unresolved: true }),
      ...(!bound && saved?.agentName && saved.targetName && { inspection: { targetKind: 'agent' as const, agentName: saved.agentName, targetName: saved.targetName } }) });
  }
  return { pairs: out, unreadable: [...unreadable] };
}

/** The agent at the other end of a Dispatcher wire. */
function nonDispatcherEnd(agentId: string, targetId: string): string | null {
  const dispatcherId = getDispatcherAgentId();
  if (agentId === dispatcherId) return targetId;
  if (targetId === dispatcherId) return agentId;
  return null;
}

async function pairState(agentId: string, targetId: string): Promise<{ sources: ConnectionSource[]; unreadable: string[] }> {
  const { pairs, unreadable } = await listConnectionSources(agentId);
  return { sources: pairs.find((p) => p.agentId === agentId && p.targetId === targetId)?.sources ?? [], unreadable };
}

/**
 * Remove one source of one pair. Refused for sources the card doesn't
 * remove (canvas, helper) and for a source that doesn't hold the pair now.
 * The user's own surface: no grant check applies.
 */
export async function removeConnectionSource(agentId: string, targetId: string, kind: ConnectionSourceKind): Promise<RemoveConnectionSourceResult> {
  const route = removalRoute(kind);
  if (route === 'canvas') return { ok: false, error: 'Remove a canvas wire on its canvas.' };
  if (route === 'helpers') return { ok: false, error: 'A helper stays connected to its orchestrator while it exists. Dispose it from the Helpers card to end it.' };
  if (route === 'none') return { ok: false, error: 'This connection’s source can’t be removed here.' };
  const before = await pairState(agentId, targetId);
  if (!before.sources.some((s) => s.kind === kind)) return { ok: false, error: 'That source no longer holds this connection. Reload to see what does.' };
  let notSaved = false;
  try {
    if (kind === 'tool_link') {
      if (before.sources.some((source) => source.sourceId === 'network-agent-connections')) {
        await removeAgentNetworkSources(connectionEnd(agentId), connectionEnd(targetId));
        markSourceRemovedByUser('network-agent-connections', agentId, targetId);
      } else {
        await removeStoredPair(agentId, targetId);
        releaseSourceBinding(ORCHESTRATOR_CONNECTION_SOURCE_ID, agentId, targetId);
      }
    } else if (kind === 'dispatcher_link') {
      // Dropped and tombstoned, so the Dispatcher can't draw it again.
      await recordUserRemoval({ agentId, targetId });
      notSaved = await isRemovalUnsaved({ agentId, targetId }).catch(() => false);
      releaseSourceBinding(DISPATCHER_CONNECTION_SOURCE_ID, agentId, targetId);
    } else if (kind === 'user_link') {
      await removeUserLink(agentId, targetId);
    } else if (kind === 'dispatcher_auto') {
      const other = nonDispatcherEnd(agentId, targetId);
      if (!other) return { ok: false, error: 'This isn\u2019t a wire to the Dispatcher.' };
      if (!(await saveWireRemoval(other))) return { ok: false, error: 'Couldn\u2019t find that agent to turn off Connect to Dispatcher. Nothing changed.' };
    }
    // Every source's view and the bindings caught up, so what's left is what holds it now.
    await rebuildPersistedBindings();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  appLog('core:mcp', 'info', 'Removed one source of a connection', { meta: { agentId, targetId, kind } });
  const after = await pairState(agentId, targetId);
  const live = after.sources.filter((s) => !s.suspended);
  if (live.length === 0 && after.unreadable.length === 0) {
    // The last source gone: a user removal, as Disconnect always was (#2230), so the orchestrator or
    // the Dispatcher can't connect them again this session, and the wire goes now.
    if (kind !== 'dispatcher_auto') markBindingRemovedByUser(agentId, targetId);
    if (bindingManager.getBindingsForAgent(agentId).some((b) => b.targetId === targetId)) bindingManager.unbind(agentId, targetId);
  } else if (kind === 'tool_link') {
    // Another source holds it: the orchestrator just can't add its link back this session.
    markSourceRemovedByUser(ORCHESTRATOR_CONNECTION_SOURCE_ID, agentId, targetId);
  }
  // The tools the Dispatcher set on its link go with it, once nothing binds the pair (#3215).
  if (kind === 'dispatcher_link') {
    await forgetDispatcherDirection(agentId, targetId).catch((err) => {
      // telemetry-exempt: logged; the link is removed either way, and its entry holds only what the Dispatcher set
      appLog('core:mcp', 'warn', 'Could not drop the tools the Dispatcher set on a removed link', { meta: { agentId, targetId, error: err instanceof Error ? err.message : String(err) } });
    });
  }
  return {
    ok: true,
    remaining: after.sources,
    stillConnected: live.length > 0,
    ...(after.unreadable.length > 0 && { unreadable: after.unreadable }),
    ...(notSaved && { notSaved: true }),
  };
}
