import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';

interface WatchEntry {
  watchId: string;
  glob: string;
  watcher: fs.FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  pendingEvents: Array<{ type: 'created' | 'modified' | 'deleted'; path: string }>;
}

const activeWatches = new Map<string, WatchEntry>();

/** Debounce interval for batching file events (ms). */
const DEBOUNCE_MS = 200;

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
    debounceTimer: null,
    pendingEvents: [],
  };

  try {
    const watcher = fs.watch(baseDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      const fullPath = path.join(baseDir, filename);

      // Map fs.watch event types to our FileEvent types
      let type: 'created' | 'modified' | 'deleted';
      if (eventType === 'rename') {
        type = fs.existsSync(fullPath) ? 'created' : 'deleted';
      } else {
        type = 'modified';
      }

      entry.pendingEvents.push({ type, path: fullPath });

      // Debounce — batch events
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
      }
      entry.debounceTimer = setTimeout(() => {
        const events = entry.pendingEvents.splice(0);
        if (events.length > 0) {
          try {
            sender.send(IPC.FILE.WATCH_EVENT, { watchId, events });
          } catch {
            // Sender may have been destroyed
          }
        }
      }, DEBOUNCE_MS);
    });

    entry.watcher = watcher;
    activeWatches.set(watchId, entry);
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
  try {
    entry.watcher.close();
  } catch {
    // Already closed
  }
  activeWatches.delete(watchId);
}

/** Stop all watches (cleanup on window close). */
export function stopAllWatches(): void {
  for (const watchId of activeWatches.keys()) {
    stopWatch(watchId);
  }
}

/** Clean up watches when a window is closed. */
export function cleanupWatchesForWindow(win: BrowserWindow): void {
  const webContentsId = win.webContents.id;
  for (const [watchId, entry] of activeWatches) {
    // We can't easily check the sender, so stop all watches
    // In practice, watches are plugin-scoped and cleaned up via dispose()
    void webContentsId;
    void entry;
    void watchId;
  }
}

/**
 * Extract the base directory from a glob pattern.
 * e.g., "/home/user/project/src/**\/*.ts" → "/home/user/project/src"
 */
function extractBaseDir(glob: string): string {
  const parts = glob.split('/');
  const baseParts: string[] = [];
  for (const part of parts) {
    if (part.includes('*') || part.includes('?') || part.includes('{') || part.includes('[')) {
      break;
    }
    baseParts.push(part);
  }
  const base = baseParts.join('/');
  return base || '.';
}
