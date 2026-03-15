import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import picomatch from 'picomatch';
import { IPC } from '../../shared/ipc-channels';

type FileEventType = 'created' | 'modified' | 'deleted';

interface WatchEntry {
  watchId: string;
  glob: string;
  watcher: fs.FSWatcher;
  webContentsId: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  pendingEvents: Map<string, FileEventType>;
  sender: Electron.WebContents;
  destroyedListener: (() => void) | null;
}

const activeWatches = new Map<string, WatchEntry>();

/** Debounce interval for batching file events (ms). */
const DEBOUNCE_MS = 200;

/** Maximum pending events before an immediate flush (prevents unbounded growth). */
const MAX_PENDING_EVENTS = 1000;

/**
 * Flush pending events for a watch entry, sending them to the renderer.
 * Clears the debounce timer and the pending events map.
 */
function flushPendingEvents(entry: WatchEntry): void {
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
  }
  if (entry.sender.isDestroyed()) {
    stopWatch(entry.watchId);
    return;
  }
  if (entry.pendingEvents.size > 0) {
    const events = Array.from(entry.pendingEvents, ([filePath, type]) => ({ type, path: filePath }));
    entry.pendingEvents.clear();
    try {
      entry.sender.send(IPC.FILE.WATCH_EVENT, { watchId: entry.watchId, events });
    } catch {
      stopWatch(entry.watchId);
    }
  }
}

/**
 * Start watching a directory for changes matching a glob pattern.
 * Events are batched and sent to the renderer via IPC.
 */
export function startWatch(watchId: string, glob: string, sender: Electron.WebContents): void {
  // Clean up existing watch with same ID
  if (activeWatches.has(watchId)) {
    stopWatch(watchId);
  }

  // Extract the base directory from the glob (everything before the first wildcard)
  const baseDir = extractBaseDir(glob);
  if (!fs.existsSync(baseDir)) {
    throw new Error(`Watch directory does not exist: ${baseDir}`);
  }

  const entry: WatchEntry = {
    watchId,
    glob,
    watcher: null as unknown as fs.FSWatcher,
    webContentsId: sender.id,
    debounceTimer: null,
    pendingEvents: new Map(),
    sender,
    destroyedListener: null,
  };

  const isMatch = picomatch(glob);

  try {
    const watcher = fs.watch(baseDir, { recursive: true }, async (eventType, filename) => {
      if (!filename) return;

      const fullPath = path.join(baseDir, filename);

      // Filter: only forward events for paths matching the original glob
      if (!isMatch(fullPath)) return;

      // Map fs.watch event types to our FileEvent types
      let type: 'created' | 'modified' | 'deleted';
      if (eventType === 'rename') {
        try {
          await fs.promises.access(fullPath);
          type = 'created';
        } catch {
          type = 'deleted';
        }
        // Guard: watch may have been stopped while we awaited
        if (!activeWatches.has(watchId)) return;
      } else {
        type = 'modified';
      }

      entry.pendingEvents.set(fullPath, type);

      // Flush immediately if cap reached (prevents unbounded growth)
      if (entry.pendingEvents.size >= MAX_PENDING_EVENTS) {
        flushPendingEvents(entry);
        return;
      }

      // Debounce — batch events
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
      }
      entry.debounceTimer = setTimeout(() => flushPendingEvents(entry), DEBOUNCE_MS);
    });

    entry.watcher = watcher;
    activeWatches.set(watchId, entry);

    // Automatically clean up when the sender webContents is destroyed
    const destroyedListener = () => {
      stopWatch(watchId);
    };
    entry.destroyedListener = destroyedListener;
    sender.once('destroyed', destroyedListener);
  } catch (err) {
    throw new Error(`Failed to start file watcher: ${(err as Error).message}`);
  }
}

/** Stop a file watch by ID. */
export function stopWatch(watchId: string): void {
  const entry = activeWatches.get(watchId);
  if (!entry) return;

  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer);
  }
  if (entry.destroyedListener) {
    entry.sender.removeListener('destroyed', entry.destroyedListener);
    entry.destroyedListener = null;
  }
  try {
    entry.watcher.close();
  } catch {
    // Already closed
  }
  activeWatches.delete(watchId);
}

/** Stop all watches (cleanup on window close). */
export function stopAllWatches(): void {
  const watchIds = [...activeWatches.keys()];
  for (const watchId of watchIds) {
    stopWatch(watchId);
  }
}

/** Clean up watches when a window is closed. */
export function cleanupWatchesForWindow(win: BrowserWindow): void {
  const webContentsId = win.webContents.id;
  const toStop = [...activeWatches.entries()]
    .filter(([, entry]) => entry.webContentsId === webContentsId)
    .map(([watchId]) => watchId);
  for (const watchId of toStop) {
    stopWatch(watchId);
  }
}

/** @internal Exported for tests only. */
export { activeWatches as _activeWatches, MAX_PENDING_EVENTS };

/** Return the number of currently active watches (for testing). */
export function getActiveWatchCount(): number {
  return activeWatches.size;
}

/**
 * Extract the base directory from a glob pattern.
 * Handles both POSIX and Windows path separators.
 * e.g., "/home/user/project/src/**\/*.ts" → "/home/user/project/src"
 *      "C:\Users\project\src\**\*.ts"    → "C:/Users/project/src"
 */
export function extractBaseDir(glob: string): string {
  // Normalize backslashes to forward slashes for consistent splitting.
  // Windows fs APIs accept forward slashes, so we can safely keep them.
  const normalized = glob.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const baseParts: string[] = [];
  for (const part of parts) {
    if (part.includes('*') || part.includes('?') || part.includes('{') || part.includes('[')) {
      break;
    }
    baseParts.push(part);
  }
  const base = baseParts.join('/');
  if (!base && !glob.startsWith('*') && !glob.startsWith('?') && !glob.startsWith('{') && !glob.startsWith('[')) {
    console.warn(`extractBaseDir: Could not extract base from glob "${glob}", falling back to '.'`);
  }
  return base || '.';
}
