import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { persist } from '../telemetry/persist';

export interface SettingsStore<T> {
  get(): T;
  save(settings: T): Promise<void>;
  /** Sequential read-modify-write: reads the current value, applies `fn`, saves, and returns the updated value. */
  update(fn: (current: T) => T): Promise<T>;
}

const settingsStoreResetters = new Set<() => void>();

/** What a store tells the audit: its top-level keys, for it to decide what to keep. */
export interface SettingsStoreAuditEvent {
  key: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Keys whose values are fit to keep, besides booleans. */
  keys?: readonly string[];
  /** Keys with a record of their own, or that aren't settings. */
  ignore?: readonly string[];
}

let storeAuditor: ((event: SettingsStoreAuditEvent) => Promise<void> | void) | null = null;

/** Set by settings-audit, not imported: this module is below the logger, which the audit needs. */
export function setSettingsStoreAuditor(auditor: typeof storeAuditor): void {
  storeAuditor = auditor;
}

/** For a settings file a person's choices live in: its audit key, and what else it may say. */
export interface SettingsStoreAudit {
  key: string;
  keys?: readonly string[];
  ignore?: readonly string[];
}

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

export type PeekedSettings = Record<string, unknown> | 'missing' | 'unreadable';

function readErrorKind(err: unknown): 'missing' | 'unreadable' {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable';
}

function parsePeeked(raw: string): Record<string, unknown> | 'unreadable' {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : 'unreadable';
  } catch {
    // telemetry-exempt: the caller reports the source as uncertain
    return 'unreadable';
  }
}

/**
 * What a settings file holds right now, before any defaults are merged in, for
 * telling a saved value from an absent one (#2653). Reads and nothing else: no
 * cache, no recovery. A save still queued shows on the next read.
 */
export async function peekStoredSettings(filename: string): Promise<PeekedSettings> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(path.join(app.getPath('userData'), filename), 'utf-8');
  } catch (err) {
    // telemetry-exempt: the caller reports the source as uncertain
    return readErrorKind(err);
  }
  return parsePeeked(raw);
}

/** `peekStoredSettings` for a decision that has to be made before anything else runs. */
export function peekStoredSettingsSync(filename: string): PeekedSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(app.getPath('userData'), filename), 'utf-8');
  } catch (err) {
    // telemetry-exempt: the caller reports the source as uncertain
    return readErrorKind(err);
  }
  return parsePeeked(raw);
}

const MAX_RECOVERY_COPIES = 100;

/**
 * Copy a file next to itself as `<name>.unreadable`, with its permissions, before
 * something overwrites it. An existing copy is never overwritten: different bytes
 * get the next number (`.unreadable.1`), and the same bytes need no second copy,
 * so a file that stays broken across launches is copied once. Throws if it can't.
 */
export function backupUnreadableSettings(filename: string): void {
  const source = path.join(app.getPath('userData'), filename);
  const bytes = fs.readFileSync(source);
  const mode = fs.statSync(source).mode & 0o777;
  for (let n = 0; n < MAX_RECOVERY_COPIES; n++) {
    const target = `${source}.unreadable${n === 0 ? '' : `.${n}`}`;
    if (fs.existsSync(target)) {
      if (fs.readFileSync(target).equals(bytes)) return;
      continue;
    }
    fs.writeFileSync(target, bytes, { flag: 'wx', mode });
    // The create mode is subject to the umask. No-op on Windows, where POSIX modes don't apply.
    if (process.platform !== 'win32') fs.chmodSync(target, mode);
    return;
  }
  throw new Error('Too many recovery copies');
}

export function createSettingsStore<T>(
  filename: string,
  defaults: T,
  migrate?: (raw: Record<string, unknown>) => T,
  options?: { mode?: number; audit?: SettingsStoreAudit },
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
  // Serializes concurrent update() calls so each read sees the prior write's result.
  let updateLock: Promise<unknown> = Promise.resolve();

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
        persist.recovery('settings', 'reset_to_default');
        // A parser's message quotes the file, which stays out of the log.
        console.warn(
          `[settings-store] Failed to parse ${filename}, using defaults:`,
          err instanceof SyntaxError ? 'invalid JSON' : err instanceof Error ? err.message : err,
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
        // Previous write in the queue failed — log but continue so the next write proceeds.
        // Note: appLog cannot be imported here (circular: settings-store → log-service → log-settings → settings-store).
        console.warn(`[settings-store] Previous write to ${filename} failed:`, err instanceof Error ? err.message : err);
      })
      .then(() => persist.timed('settings', async () => {
        if (options?.mode == null) {
          await fs.promises.writeFile(filePath, serialized, 'utf-8');
          return;
        }
        await fs.promises.writeFile(filePath, serialized, { encoding: 'utf-8', mode: options.mode });
        // writeFile's mode only applies when it creates the file; tighten a
        // pre-existing file (e.g. created 0644 by hand or an older version) too.
        // No-op on Windows, where POSIX modes don't apply.
        if (process.platform !== 'win32') await fs.promises.chmod(filePath, options.mode);
      }))
      .catch((err) => {
        console.error(`[settings-store] Write to ${filename} failed — cache may diverge from disk:`, err instanceof Error ? err.message : err);
        throw err;
      });
    pendingWrite = writeTask;
    return writeTask;
  }

  /** What a save is about to replace, if anyone is recording it. Never stops the save. */
  function auditSnapshot(): T | undefined {
    if (!options?.audit || !storeAuditor) return undefined;
    try {
      return cloneSettings(store.get());
    } catch (err) {
      console.warn(`[settings-store] Audit of ${filename} skipped:`, err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  async function reportAudit(before: T, after: T): Promise<void> {
    const audit = options?.audit;
    if (!audit || !storeAuditor) return;
    try {
      await storeAuditor({
        key: audit.key,
        before: before as Record<string, unknown>,
        after: after as Record<string, unknown>,
        ...(audit.keys && { keys: audit.keys }),
        ...(audit.ignore && { ignore: audit.ignore }),
      });
    } catch (err) {
      // Note: appLog cannot be imported here. The write itself succeeded.
      console.warn(`[settings-store] Audit of ${filename} failed:`, err instanceof Error ? err.message : err);
    }
  }

  const store: SettingsStore<T> = {
    get() {
      if (!cacheLoaded || cachedSettings === null) {
        loadSettings();
      }
      return Object.freeze(cachedSettings!) as T;
    },
    save(settings: T) {
      const before = auditSnapshot();
      cachedSettings = cloneSettings(settings);
      cacheLoaded = true;
      const written = queueWrite(cachedSettings);
      if (before === undefined) return written;
      const after = cloneSettings(settings);
      // A failed write stays this promise's failure, and records nothing. The audit's own failure stays out of it.
      void written.then(() => reportAudit(before, after), (): void => undefined);
      return written;
    },
    update(fn: (current: T) => T): Promise<T> {
      const result = updateLock.catch(() => {}).then((): Promise<T> => {
        const current = store.get();
        const updated = fn(current);
        return store.save(updated).then(() => cloneSettings(updated));
      });
      updateLock = result;
      return result;
    },
  };

  settingsStoreResetters.add(() => {
    cachedSettings = null;
    cacheLoaded = false;
    pendingWrite = Promise.resolve();
    updateLock = Promise.resolve();
  });

  return store;
}
