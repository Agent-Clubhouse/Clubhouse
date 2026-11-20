/**
 * Says the Annex device list may have changed (#3057). Peers, the client's
 * satellite connections and the server's sockets each call `devicesChanged`;
 * listeners hear once per burst, so a reconnect storm sends one update.
 */

const DEBOUNCE_MS = 50;

export type DeviceChange = 'topology' | 'last-seen';

const listeners = new Set<(change: DeviceChange) => void>();
const presenceListeners = new Set<() => void>();
let pendingChange: DeviceChange = 'last-seen';
let timer: ReturnType<typeof setTimeout> | null = null;

/** Timestamp refreshes still reach Settings and presence, but do not change topology. */
export function devicesChanged(change: DeviceChange = 'topology'): void {
  if (change === 'topology') pendingChange = 'topology';
  for (const listener of [...presenceListeners]) {
    try { listener(); } catch { /* telemetry-exempt: one listener failing must not stop the others */ }
  }
  if (listeners.size === 0) { pendingChange = 'last-seen'; return; }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const change = pendingChange;
    pendingChange = 'last-seen';
    for (const listener of [...listeners]) {
      try { listener(change); } catch { /* telemetry-exempt: one listener failing must not stop the others */ }
    }
  }, DEBOUNCE_MS);
  timer.unref?.();
}

/** Presence observes every transition, including ones within a Settings update burst. */
export function onDevicePresenceChanged(listener: () => void): () => void {
  presenceListeners.add(listener);
  return () => { presenceListeners.delete(listener); };
}

export function onDevicesChanged(listener: (change: DeviceChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test helper: forget listeners and any pending update. */
export function resetDeviceSignalForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pendingChange = 'last-seen';
  listeners.clear();
  presenceListeners.clear();
}
