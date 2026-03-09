/**
 * Shared optimistic-update-with-rollback utility for Zustand stores.
 *
 * Pattern: snapshot the fields being updated, apply the update optimistically,
 * run the async IPC call, and revert on failure.
 *
 * Callers should capture any additional pre-update state (for the IPC payload)
 * before calling this function.
 */
export async function optimisticUpdate<State>(
  set: (partial: Partial<State>) => void,
  get: () => State,
  update: Partial<State>,
  ipcCall: () => Promise<unknown>,
): Promise<void> {
  const current = get();
  const snapshot: Partial<State> = {};
  for (const key of Object.keys(update) as (keyof State)[]) {
    snapshot[key] = current[key];
  }

  set(update);

  try {
    await ipcCall();
  } catch {
    set(snapshot);
  }
}
