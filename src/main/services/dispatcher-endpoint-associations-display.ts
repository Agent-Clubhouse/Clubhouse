/** UNWIRED selected saved Dispatcher relationships -> safe project-qualified metadata. */
import * as path from 'path';
import { getBaseDirPath } from './base-dir';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import type { AgentConnectionCacheDisplay } from './agent-config';
import { createReadOnlyMetadataBudget, readReadOnlyPrimaryMetadata, ReadOnlyMetadataLimitError } from './read-only-agent-target-witness';
import { readConnectionEndpointMetadataForDisplay, type AdmittedConnectionEndpoint, type ConnectionEndpointMetadata } from './connection-endpoint-metadata-display';

interface Pair { agentId: string; targetId: string }
export interface SavedDispatcherEndpointMetadataRow extends Pair {
  /** Exact selected-project association in this saved source, not a live wire. */
  relationship: 'recorded' | 'not-recorded' | 'different-selected-project';
  endpoint?: DisplayValue<ConnectionEndpointMetadata>;
  /** Optional exact-project host-memory evidence, independent of saved fields. */
  hostCache?: DisplayValue<AgentConnectionCacheDisplay>;
}
export interface SavedDispatcherEndpointMetadata {
  scope: 'saved-dispatcher-endpoint-metadata';
  rows: SavedDispatcherEndpointMetadataRow[];
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
const folder = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 4096 && path.isAbsolute(v) && !v.includes('\0');
const date = (v: unknown): boolean => typeof v === 'string' && !!v && v.length <= 128 && Number.isFinite(Date.parse(v));
const key = (p: Pair) => `${p.agentId}\0${p.targetId}`;
const current = (r: DisplayReceipt) => { try { return r.current(); } catch { return false; } };
/** Factories do not retain the raw source inventory or private endpoint-path map. */
function combine(receipts: readonly DisplayReceipt[]): DisplayReceipt {
  const captured = [...new Set(receipts)];
  return { current: () => captured.every(current) };
}
function profile(base: string): DisplayReceipt { return { current: () => getBaseDirPath() === base }; }

/**
 * Caller supplies a strictly admitted TOP-LEVEL NORMAL DURABLE target and
 * relevant selected pairs. No Quick/helper/Dispatcher-role discovery here.
 * target must bind that selected target/role; caller separately keeps existing
 * transport/pin/auth/run receipts. No paths come from a route parameter.
 * Saved fields and optional host-memory fields remain distinct; neither
 * establishes current eligibility/effective authority.
 */
export function readSavedDispatcherEndpointMetadataForDisplay(selected: { agentId: string; projectPath: string; target: DisplayReceipt }, pairs: readonly Pair[], options: { receipts: DisplayReceipt[];
  /** Trusted internal synchronous passive getter only; never a route-supplied callback or loader. */
  readLoadedCache?: (projectPath: string, agentId: string, options: { receipts: DisplayReceipt[] }) => AgentConnectionCacheDisplay;
}): DisplayValue<SavedDispatcherEndpointMetadata> {
  const inputs = [{ field: 'Selected saved Dispatcher endpoint associations', source: 'primary' as const, observedAt: Date.now() }];
  const unknown = (reason: 'invalid' | 'unreadable' | 'limit' | 'changed'): DisplayValue<SavedDispatcherEndpointMetadata> => ({ state: 'unavailable', reason, inputs });
  if (!selected || !identifier(selected.agentId) || !folder(selected.projectPath) || typeof selected.target?.current !== 'function' || !Array.isArray(options?.receipts)) return unknown('invalid');
  const selectedId = selected.agentId, selectedProject = selected.projectPath, selectedTarget = selected.target, readLoadedCache = options.readLoadedCache;
  if (readLoadedCache !== undefined && typeof readLoadedCache !== 'function') return unknown('invalid');
  if (!Array.isArray(pairs) || pairs.length > 50) return unknown('limit');
  const admitted: Pair[] = [], seen = new Set<string>();
  for (const pair of pairs) {
    if (!pair || !identifier(pair.agentId) || !identifier(pair.targetId) || pair.agentId === pair.targetId || pair.agentId !== selectedId && pair.targetId !== selectedId || seen.has(key(pair))) return unknown('invalid');
    admitted.push({ agentId: pair.agentId, targetId: pair.targetId }); seen.add(key(pair));
  }
  if (!current(selectedTarget)) return unknown('changed');
  const known = (rows: SavedDispatcherEndpointMetadataRow[]): DisplayValue<SavedDispatcherEndpointMetadata> => ({ state: 'ok', value: { scope: 'saved-dispatcher-endpoint-metadata', rows }, inputs });
  if (!admitted.length) return known([]); // No source file/inventory access.
  const base = getBaseDirPath(); if (!folder(base)) return unknown('invalid');
  try {
    // Fixed already-supported source only; a separate initial1MiB/4096-row
    // source bound precedes the metadata query's8MiB/4096 traversal bound.
    // Missing/corrupt/backup-only source is unavailable, never adopted empty.
    const snapshot = readReadOnlyPrimaryMetadata(base, 'dispatcher-connections.json', { maxBytes: 1024 * 1024, budget: createReadOnlyMetadataBudget() });
    if (!record(snapshot.raw) || snapshot.raw.version !== 1 || !Array.isArray(snapshot.raw.connections)) return unknown('unreadable');
    const sourceRows = snapshot.raw.connections;
    if (sourceRows.length > 4096) return unknown('limit');
    const requested = new Map(admitted.map((pair) => [key(pair), pair])), matches = new Map<string, { otherId: string; otherProject: string }>(), different = new Set<string>();
    for (const row of sourceRows) {
      if (!record(row) || !identifier(row.agentId) || !identifier(row.targetId)) return unknown('unreadable');
      const k = key({ agentId: row.agentId, targetId: row.targetId });
      if (!requested.has(k)) continue;
      if (!folder(row.agentProjectPath) || !folder(row.targetProjectPath) || !identifier(row.createdBy) || !date(row.createdAt)) return unknown('unreadable');
      const outgoing = row.agentId === selectedId;
      if ((outgoing ? row.agentProjectPath : row.targetProjectPath) !== selectedProject) { different.add(k); continue; }
      if (matches.has(k)) return unknown('unreadable');
      matches.set(k, { otherId: outgoing ? row.targetId : row.agentId, otherProject: outgoing ? row.targetProjectPath : row.agentProjectPath });
    }
    // A whole-file descriptor witness binds all captured other-project paths,
    // including edits invisible to the path-free saved card page receipt.
    const evidenceStart = options.receipts.length;
    const association = combine([selectedTarget, profile(base), snapshot.receipt]);
    options.receipts.push(association);
    if (!association.current()) return unknown('changed');
    const queries: AdmittedConnectionEndpoint[] = [], positions: number[] = [];
    const rows: SavedDispatcherEndpointMetadataRow[] = admitted.map((pair) => ({ ...pair, relationship: matches.has(key(pair)) ? 'recorded' : different.has(key(pair)) ? 'different-selected-project' : 'not-recorded' }));
    for (let index = 0; index < admitted.length; index++) {
      const match = matches.get(key(admitted[index])); if (!match) continue;
      queries.push({ agentId: match.otherId, projectPath: match.otherProject, association }); positions.push(index);
    }
    const metadata = readConnectionEndpointMetadataForDisplay(queries, { receipts: options.receipts });
    if (!association.current()) return unknown('changed');
    if (metadata.state !== 'ok') {
      for (const index of positions) rows[index].endpoint = { state: 'unavailable', reason: metadata.reason, inputs: metadata.inputs };
    } else {
      for (let index = 0; index < positions.length; index++) rows[positions[index]].endpoint = metadata.value[index];
    }
    if (readLoadedCache) {
      // A cache is not a substitute for registration or the saved relationship.
      // Only exact registered primary identities may reach the injected passive
      // getter. A failed/absent/limited primary remains independent unknown;
      // it cannot authorize borrowing a globally indexed native ID.
      const metadataEvidence = options.receipts.slice(evidenceStart);
      if (!combine(metadataEvidence).current()) return unknown('changed');
      const groups = new Map<string, Array<{ row: SavedDispatcherEndpointMetadataRow; query: AdmittedConnectionEndpoint }>>();
      for (let index = 0; index < positions.length; index++) {
        const row = rows[positions[index]];
        if (row.endpoint?.state !== 'ok' || row.endpoint.value.record !== 'registered-primary') continue;
        const query = queries[index], group = groups.get(query.projectPath);
        if (group) group.push({ row, query }); else groups.set(query.projectPath, [{ row, query }]);
      }
      // At most16 admitted metadata roots/50 selected identities. Check the
      // source freshly per project, not once per repeated identity, and never
      // carry a previous phase's truth across registry/cache work.
      for (const [projectPath, group] of groups) {
        if (!association.current()) return unknown('changed');
        for (const { row, query } of group) {
          const cacheInputs = [{ field: 'Related agent host-session fields', source: 'host-cache' as const, observedAt: Date.now() }];
          try { row.hostCache = { state: 'ok', value: readLoadedCache(projectPath, query.agentId, { receipts: options.receipts }), inputs: cacheInputs }; }
          catch { row.hostCache = { state: 'unavailable', reason: 'unreadable', inputs: cacheInputs }; }
        }
      }
      // Cache callbacks are synchronous and passive by contract, but their
      // selected evidence still must survive later rows and final assembly.
      if (!combine(options.receipts.slice(evidenceStart)).current()) return unknown('changed');
    }
    return known(rows);
  } catch (error) { return unknown(error instanceof ReadOnlyMetadataLimitError ? 'limit' : 'unreadable'); }
}
