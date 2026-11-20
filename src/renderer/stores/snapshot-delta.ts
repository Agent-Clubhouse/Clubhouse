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
    if (sameSnapshotValue(before, after)) return value;
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
        const reordered = !sameSnapshotValue(oldOrder, newOrder);
        const order = reordered ? [...newOrder, ...liveOrder] : [...liveOrder, ...newOrder];
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
