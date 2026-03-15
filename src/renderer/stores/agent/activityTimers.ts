/**
 * Module-level singleton for tracking pending throttled activity update timers.
 * Shared between the crud and status slices so removeAgent can cancel pending timers.
 */
export const pendingActivityTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const clearPendingActivityTimer = (id: string): void => {
  const timer = pendingActivityTimers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  pendingActivityTimers.delete(id);
};

export const clearPendingActivityTimers = (ids: Iterable<string>): void => {
  for (const id of ids) {
    clearPendingActivityTimer(id);
  }
};
