import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface SettingsStore<T> {
  get(): T;
  save(settings: T): Promise<void>;
  /** Sequential read-modify-write: reads the current value, applies `fn`, saves, and returns the updated value. */
  update(fn: (current: T) => T): Promise<T>;
  /** Returns true when the settings file exists on disk (i.e. settings have been persisted at least once). */
  fileExists(): boolean;
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
): SettingsStore<T> {
  const filePath = path.join(app.getPath('userData'), filename);
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

  function loadSettings(): T {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      cachedSettings = parseSettings(raw);
      cacheLoaded = true;
      return cloneSettings(cachedSettings);
    } catch (err) {
      if (fs.existsSync(filePath)) {
        console.warn(
          `[settings-store] Failed to parse ${filename}, using defaults:`,
          err instanceof Error ? err.message : err,
        );
      }
      cachedSettings = cloneSettings(defaults);
      cacheLoaded = true;
      return cloneSettings(cachedSettings);
    }
  }

  function queueWrite(settings: T): Promise<void> {
    const snapshot = cloneSettings(settings);
    const serialized = JSON.stringify(snapshot, null, 2);
    const writeTask = pendingWrite
      .catch((_err): void => {})
      .then(() => fs.promises.writeFile(filePath, serialized, 'utf-8'));
    pendingWrite = writeTask;
    return writeTask;
  }

  const store: SettingsStore<T> = {
    get() {
      if (!cacheLoaded || cachedSettings === null) {
        return loadSettings();
      }
      return cloneSettings(cachedSettings);
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
    fileExists() {
      return fs.existsSync(filePath);
    },
  };

  settingsStoreResetters.add(() => {
    cachedSettings = null;
    cacheLoaded = false;
    pendingWrite = Promise.resolve();
  });

  return store;
}
