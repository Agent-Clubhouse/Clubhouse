/** Private saved metadata for already admitted selected relationships; never a discovery route. */
import * as path from 'path';
import { getBaseDirPath } from './base-dir';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import { projectConnectionEndpointFieldsForDisplay, type ConnectionEndpointFields } from './connection-endpoint-fields-display';
import { createReadOnlyMetadataBudget, readReadOnlyPrimaryMetadata, ReadOnlyMetadataLimitError } from './read-only-agent-target-witness';
import { hasAsciiControl } from '../../shared/ascii-control';

export const CONNECTION_METADATA_REQUESTS = 50;
export const CONNECTION_METADATA_ROOTS = 16;
export const CONNECTION_METADATA_ROWS = 4096;

export interface AdmittedConnectionEndpoint {
  agentId: string;
  projectPath: string;
  /** Must bind this exact other-end project association, not just a path-free card page. */
  association: DisplayReceipt;
}
/** Private observed-directory tuple access; no path/tuple/receipt is a DTO or authority. */
export interface ConnectionEndpointProjectReceipt extends DisplayReceipt {
  cacheNamespace(): string | undefined;
}
function projectReceipt(receipts: readonly DisplayReceipt[], namespace: string | undefined): ConnectionEndpointProjectReceipt {
  const evidence = combinedReceipt(receipts);
  return { current: () => evidence.current(), cacheNamespace: () => namespace };
}

export type ConnectionEndpointMetadata =
  | { record: 'registered-primary'; fields: ConnectionEndpointFields }
  | { record: 'absent-from-primary' | 'project-not-registered' };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200 && !hasAsciiControl(v);
const folder = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 4096 && path.isAbsolute(v) && !v.includes('\0');
const current = (receipt: DisplayReceipt): boolean => { try { return receipt.current(); } catch { return false; } };
function profileReceipt(base: string): DisplayReceipt {
  return { current: () => getBaseDirPath() === base };
}
/** Separate factory: no raw metadata, input collection or filesystem budget is retained. */
function combinedReceipt(receipts: readonly DisplayReceipt[]): DisplayReceipt {
  const captured = [...new Set(receipts)];
  return { current: () => captured.every(current) };
}

/**
 * Results retain input order; callers keep their private pair association.
 * Inputs must come from the applicable selected relationship owner, never HTTP
 * root parameters or arbitrary inventory discovery. All results are SAVED
 * primary evidence, not the loaded agent namespace, liveness or permissions.
 * Caller retains these receipts alongside its target/role/run/auth receipts.
 */
export function readConnectionEndpointMetadataForDisplay(requests: readonly AdmittedConnectionEndpoint[], options: { receipts: DisplayReceipt[];
  /** Private per-query output for later root admission; never DTOs or route input. Must start empty. */
  projectReceipts?: Map<string, ConnectionEndpointProjectReceipt>;
}): DisplayValue<DisplayValue<ConnectionEndpointMetadata>[]> {
  const observedAt = Date.now();
  const inputs = [{ field: 'Related registered-project saved metadata', source: 'primary' as const, observedAt }];
  const unknown = <T>(reason: 'invalid' | 'unreadable' | 'limit' | 'changed'): DisplayValue<T> => ({ state: 'unavailable', reason, inputs });
  const known = <T>(value: T): DisplayValue<T> => ({ state: 'ok', value, inputs });
  if (!Array.isArray(requests) || requests.length > CONNECTION_METADATA_REQUESTS || !Array.isArray(options?.receipts)) return unknown('limit');
  const projectReceipts = options.projectReceipts;
  if (projectReceipts !== undefined && (!(projectReceipts instanceof Map) || projectReceipts.size !== 0)) return unknown('invalid');
  // Per-entry unavailable states are retained as metadata records below, rather
  // than making one malformed/unreadable endpoint erase other useful fields.
  const results: DisplayValue<ConnectionEndpointMetadata>[] = requests.map(() => unknown('invalid'));
  const admitted: Array<{ index: number; agentId: string; projectPath: string; association: DisplayReceipt }> = [];
  const evidence: DisplayReceipt[] = [];
  const initialAssociations = new Map<DisplayReceipt, boolean>();
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    if (!request || !identifier(request.agentId) || !folder(request.projectPath) || typeof request.association?.current !== 'function') continue;
    // One passive source may bind the complete selected page. Check it once
    // in this admission phase, then freshly before each project and at finish.
    if (!initialAssociations.has(request.association)) initialAssociations.set(request.association, current(request.association));
    if (!initialAssociations.get(request.association)) { results[index] = unknown('changed'); continue; }
    admitted.push({ index, agentId: request.agentId, projectPath: request.projectPath, association: request.association });
    evidence.push(request.association);
  }
  // No admitted relationship means no registry or project access.
  if (!admitted.length) return known(results);
  const base = getBaseDirPath(), budget = createReadOnlyMetadataBudget();
  if (!folder(base)) return unknown('invalid');
  const profile = profileReceipt(base);
  evidence.push(profile);
  let rowsLeft = CONNECTION_METADATA_ROWS;
  const charge = (length: number) => {
    if (length > rowsLeft) throw new ReadOnlyMetadataLimitError('Related metadata row limit reached.');
    rowsLeft -= length;
  };
  let registered: Set<string>;
  let registryReceipt: DisplayReceipt | undefined;
  try {
    const snapshot = readReadOnlyPrimaryMetadata(base, 'projects.json', { budget });
    registryReceipt = snapshot.receipt;
    evidence.push(snapshot.receipt);
    const rows = Array.isArray(snapshot.raw) ? snapshot.raw : record(snapshot.raw) && snapshot.raw.version === 1 ? snapshot.raw.projects : undefined;
    if (!Array.isArray(rows)) throw new Error('Invalid registered-project primary.');
    charge(rows.length); // All entries/nonmatches count, before any traversal.
    const ids = new Set<string>(), normalized = new Set<string>();
    registered = new Set();
    for (const row of rows) {
      if (!record(row) || !identifier(row.id) || typeof row.name !== 'string' || !folder(row.path) || ids.has(row.id) || normalized.has(path.resolve(row.path))) throw new Error('Ambiguous registered-project primary.');
      ids.add(row.id); normalized.add(path.resolve(row.path)); registered.add(row.path);
    }
  } catch (error) {
    const reason = error instanceof ReadOnlyMetadataLimitError ? 'limit' : 'unreadable';
    for (const request of admitted) results[request.index] = unknown(reason);
    return finish();
  }
  const grouped = new Map<string, typeof admitted>();
  for (const request of admitted) {
    if (!registered.has(request.projectPath)) { results[request.index] = known({ record: 'project-not-registered' }); continue; }
    const group = grouped.get(request.projectPath);
    if (group) group.push(request); else grouped.set(request.projectPath, [request]);
  }
  let roots = 0;
  for (const [projectPath, group] of grouped) {
    // A later file read must not proceed solely on a relationship which has
    // already become invalid while the registry/earlier endpoints were read.
    // Deduplicate only within this candidate project's phase. False shared
    // receipts must not reread their source once per pair; later projects and
    // final assembly still check freshly, and distinct receipts remain distinct.
    if (![...new Set(group.map((request) => request.association))].some(current)) { for (const request of group) results[request.index] = unknown('changed'); continue; }
    if (++roots > CONNECTION_METADATA_ROOTS) { for (const request of group) results[request.index] = unknown('limit'); continue; }
    try {
      const snapshot = readReadOnlyPrimaryMetadata(projectPath, '.clubhouse/agents.json', { budget });
      evidence.push(snapshot.receipt);
      if (!Array.isArray(snapshot.raw)) throw new Error('Invalid agent primary.');
      charge(snapshot.raw.length);
      const wanted = new Set(group.map((request) => request.agentId)), selected = new Map<string, Record<string, unknown>>(), ids = new Set<string>();
      for (const row of snapshot.raw) {
        if (!record(row) || !identifier(row.id) || ids.has(row.id)) throw new Error('Ambiguous agent primary.');
        ids.add(row.id);
        if (wanted.has(row.id)) selected.set(row.id, row);
      }
      for (const request of group) {
        const raw = selected.get(request.agentId);
        if (!raw) { results[request.index] = known({ record: 'absent-from-primary' }); continue; }
        const projected = projectConnectionEndpointFieldsForDisplay(request.agentId, raw);
        // Field origin is this admitted primary, not a current runtime/cache.
        if (projected.state !== 'ok') { results[request.index] = unknown('invalid'); continue; }
        const fields = projected.value;
        const primary = <T>(value: DisplayValue<T>): DisplayValue<T> => ({ ...value, inputs });
        results[request.index] = known({ record: 'registered-primary', fields: { ...fields,
          name: primary(fields.name), helper: primary(fields.helper), disposed: primary(fields.disposed), connectToDispatcher: primary(fields.connectToDispatcher) } });
      }
      if (projectReceipts && registryReceipt) {
        // No other root's primary is captured here. Each check re-reads the
        // bounded registry (<=4MiB), THIS primary (<=4MiB), profile and distinct
        // selected association callbacks. At most16 root receipts are created;
        // checks do not reuse a previous phase's currentness result.
        projectReceipts.set(projectPath, projectReceipt([profile, registryReceipt, snapshot.receipt, ...group.map((request) => request.association)], snapshot.rootNamespace));
      }
    } catch (error) {
      const reason = error instanceof ReadOnlyMetadataLimitError ? 'limit' : 'unreadable';
      for (const request of group) results[request.index] = unknown(reason);
    }
  }
  return finish();

  function finish(): DisplayValue<DisplayValue<ConnectionEndpointMetadata>[]> {
    // All admitted primary/absence/association evidence is checked after the
    // last read. Later endpoint work must check the retained private receipt.
    const receipt = combinedReceipt(evidence);
    options.receipts.push(receipt);
    if (!receipt.current()) for (const request of admitted) results[request.index] = unknown('changed');
    return known(results);
  }
}
