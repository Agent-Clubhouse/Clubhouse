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
import { listDispatcherLinksForUser, recordUserRemoval } from './dispatcher-connections';
import { saveWireRemoval } from './dispatcher-wire-source';
import { appLog } from './log-service';
import type { DispatcherLink } from '../../shared/types';
import { removeStoredPair } from './orchestrator-connections';
import { collectSourcesByPair, markBindingRemovedByUser, persistedPairKey, rebuildPersistedBindings, releaseSourceBinding } from './persisted-bindings';

// The persisted sources' ids (persisted-bindings registrations), stable across releases.
const ORCHESTRATOR_CONNECTION_SOURCE_ID = 'orchestrator-connections';
const DISPATCHER_CONNECTION_SOURCE_ID = 'dispatcher-connections';
const KIND_BY_SOURCE: Readonly<Record<string, ConnectionSourceKind>> = {
  'canvas-wires': 'canvas',
  'helper-wires': 'helper',
  'dispatcher-wires': 'dispatcher_auto',
  [ORCHESTRATOR_CONNECTION_SOURCE_ID]: 'tool_link',
  [DISPATCHER_CONNECTION_SOURCE_ID]: 'dispatcher_link',
};

const SUSPENDED_WHY: Readonly<Record<string, string>> = {
  dispatcher_off: 'The Dispatcher is off.',
  store_unwritable: 'Clubhouse can’t save to its connections file.',
  orchestration_off: 'Orchestration is off for one of these agents.',
  not_connected_to_dispatcher: 'One of these agents is not connected to the Dispatcher.',
};

/** Every pair touching the agent, in both directions, with the sources holding each. */
export async function listConnectionSources(agentId: string): Promise<AgentConnectionSources> {
  const { bySource, failed } = await collectSourcesByPair();
  const links = await listDispatcherLinksForUser().catch((): DispatcherLink[] => []);
  const linkStatus = new Map(links.map((l) => [persistedPairKey(l.agentId, l.targetId), l]));
  const pairs = new Map<string, { agentId: string; targetId: string }>();
  const touches = (a: string, t: string) => a === agentId || t === agentId;
  for (const b of bindingManager.getAllBindings()) {
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
      sources.push({ kind, sourceId, ...(link && link.status === 'suspended' && { suspended: SUSPENDED_WHY[link.reason ?? ''] ?? 'Suspended.' }) });
    }
    // A suspended Dispatcher link isn't collected (no binding), but it is still saved.
    const link = linkStatus.get(key);
    if (link && !sources.some((s) => s.kind === 'dispatcher_link')) {
      sources.push({ kind: 'dispatcher_link', sourceId: DISPATCHER_CONNECTION_SOURCE_ID, ...(link.status === 'suspended' && { suspended: SUSPENDED_WHY[link.reason ?? ''] ?? 'Suspended.' }) });
    }
    const bound = bindingManager.getBindingsForAgent(pair.agentId).some((b) => b.targetId === pair.targetId);
    out.push({ ...pair, bound, sources, ...(bound && sources.length === 0 && { unresolved: true }) });
  }
  return { pairs: out, unreadable: failed };
}

/** The agent at the other end of a Dispatcher wire. */
function nonDispatcherEnd(agentId: string, targetId: string): string | null {
  const dispatcherId = getDispatcherAgentId();
  if (agentId === dispatcherId) return targetId;
  if (targetId === dispatcherId) return agentId;
  return null;
}

async function sourcesOfPair(agentId: string, targetId: string): Promise<ConnectionSource[]> {
  const { pairs } = await listConnectionSources(agentId);
  return pairs.find((p) => p.agentId === agentId && p.targetId === targetId)?.sources ?? [];
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
  const before = await sourcesOfPair(agentId, targetId);
  if (!before.some((s) => s.kind === kind)) return { ok: false, error: 'That source no longer holds this connection. Reload to see what does.' };
  try {
    if (kind === 'tool_link') {
      await removeStoredPair(agentId, targetId);
      releaseSourceBinding(ORCHESTRATOR_CONNECTION_SOURCE_ID, agentId, targetId);
    } else if (kind === 'dispatcher_link') {
      // Dropped and tombstoned, so the Dispatcher can't draw it again.
      await recordUserRemoval({ agentId, targetId });
      releaseSourceBinding(DISPATCHER_CONNECTION_SOURCE_ID, agentId, targetId);
    } else if (kind === 'dispatcher_auto') {
      const other = nonDispatcherEnd(agentId, targetId);
      if (!other) return { ok: false, error: 'This isn’t a wire to the Dispatcher.' };
      await saveWireRemoval(other);
      await rebuildPersistedBindings();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  appLog('core:mcp', 'info', 'Removed one source of a connection', { meta: { agentId, targetId, kind } });
  const remaining = await sourcesOfPair(agentId, targetId);
  // The last source gone: a user removal, as Disconnect always was (#2230), so the orchestrator or the
  // Dispatcher can't connect them again this session. While another source holds it, nothing else changes.
  if (remaining.length === 0 && kind !== 'dispatcher_auto') markBindingRemovedByUser(agentId, targetId);
  return { ok: true, remaining, stillConnected: remaining.length > 0 };
}
