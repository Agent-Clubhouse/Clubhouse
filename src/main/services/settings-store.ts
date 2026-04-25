import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface SettingsStore<T> {
  get(): T;
  save(settings: T): Promise<void>;
  /** Sequential read-modify-write: reads the current value, applies `fn`, saves, and returns the updated value. */
  update(fn: (current: T) => T): Promise<T>;
}

const settingsStoreResetters = new Set<() => void>();

function cloneSettings<T>(settings: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(settings);
  }
  return JSON.parse(JSON.stringify(settings)) as T;
}

/**
 * Resets all in-memory settings caches.
 *
 * This is only intended for unit tests that exercise module-level singleton
 * stores across multiple test cases.
 */
export function resetAllSettingsStoresForTests(): void {
  for (const reset of settingsStoreResetters) {
    reset();
  }
}

export function createSettingsStore<T>(
  filename: string,
  defaults: T,
  migrate?: (raw: Record<string, unknown>) => T,
  options?: { mode?: number },
): SettingsStore<T> {
  // Resolve filePath lazily on each access. `createSettingsStore` runs at
  // module-load time (e.g. when ipc/app-handlers imports a settings module),
  // which is *before* main/index.ts gets to call `app.setPath('userData', …)`
  // for CLUBHOUSE_USER_DATA. Capturing the path eagerly would freeze it to
  // the default userData location and silently ignore the override, so any
  // pre-seeded settings file in the test's temp dir would never be read.
  const getFilePath = () => path.join(app.getPath('userData'), filename);
  let cachedSettings: T | null = null;
  let cacheLoaded = false;
  let pendingWrite: Promise<void> = Promise.resolve();

  function parseSettings(raw: string): T {
    const merged = {
      ...cloneSettings(defaults),
      ...JSON.parse(raw),
    } as Record<string, unknown>;
    const parsed = migrate ? migrate(merged) : (merged as T);
    return cloneSettings(parsed);
  }

  function loadSettings(): void {
    const filePath = getFilePath();
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      cachedSettings = parseSettings(raw);
      cacheLoaded = true;
    } catch (err) {
      if (fs.existsSync(filePath)) {
        console.warn(
          `[settings-store] Failed to parse ${filename}, using defaults:`,
          err instanceof Error ? err.message : err,
        );
      }
      cachedSettings = cloneSettings(defaults);
      cacheLoaded = true;
    }
  }

  function queueWrite(settings: T): Promise<void> {
    const snapshot = cloneSettings(settings);
    const serialized = JSON.stringify(snapshot, null, 2);
    const filePath = getFilePath();
    const writeTask = pendingWrite
      .catch((err): void => {
        console.warn(`[settings-store] Previous write to ${filename} failed:`, err instanceof Error ? err.message : err);
      })
      .then(() => fs.promises.writeFile(filePath, serialized, options?.mode != null ? { encoding: 'utf-8', mode: options.mode } : 'utf-8'));
    pendingWrite = writeTask;
    return writeTask;
  }

  const store: SettingsStore<T> = {
    get() {
      if (!cacheLoaded || cachedSettings === null) {
        loadSettings();
      }
      return Object.freeze(cachedSettings!) as T;
    },
    save(settings: T) {
      cachedSettings = cloneSettings(settings);
      cacheLoaded = true;
      return queueWrite(cachedSettings);
    },
    update(fn: (current: T) => T): Promise<T> {
      const current = store.get();
      const updated = fn(current);
      return store.save(updated).then(() => cloneSettings(updated));
    },
  };

  settingsStoreResetters.add(() => {
    cachedSettings = null;
    cacheLoaded = false;
    pendingWrite = Promise.resolve();
  });

  return store;
}
