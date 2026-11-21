/** Snapshot values crossed the JSON transport; comparison never depends on IPC clone identity. */
export function sameSnapshotValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameSnapshotValue(left[key], right[key]));
}

const absent = Symbol('absent snapshot field');
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Apply only a cached source delta to the current renderer projection. Unchanged
 * fields and independently added/removed rows retain their current value. This
 * infers no freshness from seq: accepted live snapshots use the full apply path.
 */
export function applySnapshotDelta<T>(current: T, previous: unknown, next: unknown, onConflict?: () => void): T {
  const merge = (value: unknown, before: unknown, after: unknown): unknown => {
    if (sameSnapshotValue(before, after) || sameSnapshotValue(value, after)) return value;
    if (after === absent) {
      if (value !== absent && !sameSnapshotValue(value, before)) {
        onConflict?.();
        return value;
      }
      return absent;
    }
    if (before === absent && value === absent) return structuredClone(after);
    // A live deletion/settlement is not undone by a cached edit to that old row.
    if (value === absent) { onConflict?.(); return absent; }
    if (before === absent && record(value) && record(after)) before = {};
    if (Array.isArray(before) && Array.isArray(after) && Array.isArray(value)) {
      const indexed = (rows: unknown[]) => {
        if (!rows.every((row) => record(row) && typeof row.id === 'string')) return null;
        const entries = rows.map((row) => [(row as Record<string, unknown>).id as string, row] as const);
        return new Set(entries.map(([id]) => id)).size === rows.length ? Object.fromEntries(entries) : null;
      };
      const oldRows = indexed(before);
      const newRows = indexed(after);
      const liveRows = indexed(value);
      if (oldRows && newRows && liveRows) {
        const rows = merge(liveRows, oldRows, newRows) as Record<string, unknown>;
        const ids = (rows: unknown[]) => rows.map((row) => (row as Record<string, unknown>).id as string);
        const oldOrder = ids(before);
        const newOrder = ids(after);
        const liveOrder = ids(value);
        const common = new Set(oldOrder.filter((id) => Object.prototype.hasOwnProperty.call(newRows, id) && Object.prototype.hasOwnProperty.call(liveRows, id)));
        const shared = (order: string[]) => order.filter((id) => common.has(id));
        const sourceReordered = !sameSnapshotValue(shared(oldOrder), shared(newOrder));
        const liveReordered = !sameSnapshotValue(shared(oldOrder), shared(liveOrder));
        const conflicting = sourceReordered && liveReordered && !sameSnapshotValue(shared(newOrder), shared(liveOrder));
        // Membership changes cannot prove placement relative to an independently
        // reordered/added live row. Keep the live order and defer that ambiguity.
        const ambiguousPlacement = (liveReordered && newOrder.some((id) => !Object.prototype.hasOwnProperty.call(oldRows, id)))
          || (sourceReordered && liveOrder.some((id) => !Object.prototype.hasOwnProperty.call(oldRows, id)));
        if (conflicting || ambiguousPlacement) onConflict?.();
        const keepLiveOrder = conflicting || ambiguousPlacement || liveReordered;
        const order = keepLiveOrder ? [...liveOrder, ...newOrder] : [...newOrder, ...liveOrder];
        return [...new Set(order)].filter((id) => Object.prototype.hasOwnProperty.call(rows, id)).map((id) => rows[id]);
      }
      // Arrays without stable row identities are indivisible source values.
      if (!sameSnapshotValue(value, before) && !sameSnapshotValue(value, after)) {
        onConflict?.();
        return value;
      }
      return structuredClone(after);
    }
    if (record(before) && record(after) && record(value)) {
      const result = { ...value };
      const read = (object: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(object, key) ? object[key] : absent;
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const updated = merge(read(value, key), read(before, key), read(after, key));
        if (updated === absent) delete result[key];
        else Object.defineProperty(result, key, { value: updated, enumerable: true, configurable: true, writable: true });
      }
      return result;
    }
    if (!sameSnapshotValue(value, before) && !sameSnapshotValue(value, after)) {
      onConflict?.();
      return value;
    }
    return structuredClone(after);
  };
  return merge(current, previous, next) as T;
}

/** Finite uncertainty domains, owned by renderer satellite records, never socket epochs. */
export enum CachedDomain {
  Projects = 1, Agents = 2, Details = 4, ProjectIcons = 8, AgentIcons = 16,
  Plugins = 32, Canvas = 64, AppCanvas = 128, Groups = 256, Digests = 512,
  Members = 1024, Permissions = 2048, Pause = 4096,
}
export const ALL_CACHED_DOMAINS = 8191;

/** An observed change/gap can hide ABA even when the current value equals before. */
export function reconcileCachedValue<T>(current: T, previous: unknown, next: unknown, uncertain: boolean) {
  let deferred = false;
  const value = applySnapshotDelta(current, previous, next, () => { deferred = true; });
  if (uncertain && (deferred || !sameSnapshotValue(value, current))) return { value: current, deferred: true };
  return { value, deferred };
}

// Mutation notifications carry only a domain bitmask, not payloads or ID history.
const projectionListeners = new Set<(satelliteId: string, domains: number) => void>();
export function onRemoteProjectionMutation(listener: (satelliteId: string, domains: number) => void): () => void {
  projectionListeners.add(listener);
  return () => { projectionListeners.delete(listener); };
}
export function remoteProjectionMutated(satelliteId: string, domains: number): void {
  for (const listener of projectionListeners) listener(satelliteId, domains);
}
