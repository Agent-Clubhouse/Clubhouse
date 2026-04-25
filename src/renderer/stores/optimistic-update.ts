/**
 * Shared optimistic-update-with-rollback utility for Zustand stores.
 *
 * Pattern: snapshot the fields being updated, apply the update optimistically,
 * run the async IPC call, and revert on failure.
 *
 * Callers should capture any additional pre-update state (for the IPC payload)
 * before calling this function.
 *
 * Rollback uses per-store version tokens keyed on the `get` function reference
 * to avoid reference-equality failures that occur when Zustand state is
 * serialized and deserialized (e.g. during Electron IPC round-trips).
 * Only the most-recent writer of each key is allowed to roll it back, so
 * concurrent optimistic updates to the same key are handled correctly.
 */

type GetFn = () => unknown;

// WeakMap keyed on the store's `get` function for per-store version isolation.
const _storeKeyVersions = new WeakMap<GetFn, Map<string, number>>();
let _globalVersion = 0;

function getVersionMap(get: GetFn): Map<string, number> {
  let map = _storeKeyVersions.get(get);
  if (!map) {
    map = new Map();
    _storeKeyVersions.set(get, map);
  }
  return map;
}

export async function optimisticUpdate<State>(
  set: (partial: Partial<State>) => void,
  get: () => State,
  update: Partial<State>,
  ipcCall: () => Promise<unknown>,
): Promise<void> {
  const versionMap = getVersionMap(get);
  const current = get();
  const snapshot: Partial<State> = {};
  const myVersions = new Map<string, number>();

  for (const key of Object.keys(update) as (keyof State)[]) {
    snapshot[key] = current[key];
    const ver = ++_globalVersion;
    versionMap.set(key as string, ver);
    myVersions.set(key as string, ver);
  }

  set(update);

  try {
    await ipcCall();
  } catch {
    // Only rollback keys whose version token still matches ours — i.e. no
    // concurrent optimistic write has claimed ownership of that key since
    // our update was applied.
    const safeRollback: Partial<State> = {};
    for (const key of Object.keys(snapshot) as (keyof State)[]) {
      if (versionMap.get(key as string) === myVersions.get(key as string)) {
        safeRollback[key] = snapshot[key];
        versionMap.delete(key as string);
      }
    }
    if (Object.keys(safeRollback).length > 0) {
      set(safeRollback);
    }
  }
}
