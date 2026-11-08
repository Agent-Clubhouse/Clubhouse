/**
 * Says the Annex device list may have changed (#3057). Peers, the client's
 * satellite connections and the server's sockets each call `devicesChanged`;
 * listeners hear once per burst, so a reconnect storm sends one update.
 */

const DEBOUNCE_MS = 50;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function devicesChanged(): void {
  if (timer || listeners.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* telemetry-exempt: one listener failing must not stop the others */ }
    }
  }, DEBOUNCE_MS);
  timer.unref?.();
}

export function onDevicesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test helper: forget listeners and any pending update. */
export function resetDeviceSignalForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  listeners.clear();
}
