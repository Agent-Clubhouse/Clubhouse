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

/** `peekStoredSettings` for a decision that can't wait: the startup path, or a telemetry gate. */
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

const recoveryCopyPath = (source: string, n: number): string => `${source}.unreadable${n === 0 ? '' : `.${n}`}`;

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
    const target = recoveryCopyPath(source, n);
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

/** The newest recovery copy of a settings file, if there is one. */
export function latestRecoveryCopy(filename: string): string | undefined {
  const source = path.join(app.getPath('userData'), filename);
  let latest: string | undefined;
  for (let n = 0; n < MAX_RECOVERY_COPIES && fs.existsSync(recoveryCopyPath(source, n)); n++) latest = recoveryCopyPath(source, n);
  return latest;
}

let tempFileCounter = 0;

const tempPrefix = (filePath: string): string => `${filePath}.tmp-`;

/**
 * Windows can refuse a rename while another process (often a virus scanner or
 * the search indexer) has the file open. Retry with backoff for about 3 seconds.
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1500];

async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (process.platform !== 'win32' || delay === undefined || !code || !RENAME_RETRY_CODES.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** The target's permission bits, to carry over to its replacement. */
async function existingMode(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.promises.stat(filePath)).mode & 0o777;
  } catch {
    // telemetry-exempt: no file yet, so the new one gets the default permissions
    return undefined;
  }
}

/**
 * Write `body` to a temp file beside `filePath`, flush it to disk, then rename
 * it over `filePath`. The flush keeps a power loss from committing the rename
 * before the data. The replacement gets `mode`, or the old file's permissions.
 */
export async function replaceFile(filePath: string, body: string, mode: number | undefined): Promise<void> {
  const tmp = `${tempPrefix(filePath)}${process.pid}-${++tempFileCounter}`;
  const keep = mode ?? (process.platform === 'win32' ? undefined : await existingMode(filePath));
  try {
    const handle = await fs.promises.open(tmp, 'w', keep ?? 0o666);
    try {
      await handle.writeFile(body, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The create mode is subject to the umask. No-op on Windows, where POSIX modes don't apply.
    if (keep != null && process.platform !== 'win32') await fs.promises.chmod(tmp, keep);
    await renameOver(tmp, filePath);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch((): void => undefined);
    throw err;
  }
}

/**
 * Remove temp files a crash left beside `filePath`, from other processes only:
 * this one's own may still be in flight.
 */
function sweepTempFiles(filePath: string): void {
  const dir = path.dirname(filePath);
  const prefix = path.basename(tempPrefix(filePath));
  const own = `${prefix}${process.pid}-`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // telemetry-exempt: nothing to sweep when the folder can't be listed
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || name.startsWith(own)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // telemetry-exempt: a leftover temp file is harmless; the next launch tries again
    }
  }
}

export function createSettingsStore<T>(
  filename: string,
  defaults: T,
  migrate?: (raw: Record<string, unknown>) => T,
  options?: {
    mode?: number;
    /** Observe the actual initial load, including a fallback to defaults. */
    onLoad?: (result: { raw: string } | { error: unknown }) => void;
    audit?: SettingsStoreAudit;
    /**
     * After a failed write, go back to the value before it. Off by default: a
     * store's new value is in memory before it's written, and some rely on that
     * (telemetry's migration must hold for the run even if it can't be saved).
     */
    rollBackFailedSaves?: boolean;
    /**
     * Write a temp file next to the target, flush it, then rename it over the
     * target, so a crash or power loss mid-write leaves the old file whole
     * instead of a torn one that loads as defaults. Temp files left by a crash
     * are removed at the next load. A symlinked file is replaced by a regular
     * one. Off by default; turned on store by store.
     */
    atomic?: boolean;
  },
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

  function notifyLoad(result: { raw: string } | { error: unknown }): void {
    try { options?.onLoad?.(result); }
    catch (err) {
      // An observer must not turn a successful load into a reset to defaults.
      console.warn(`[settings-store] Load observer for ${filename} failed:`, err instanceof Error ? err.message : err);
    }
  }

  function loadSettings(): void {
    const filePath = getFilePath();
    if (options?.atomic) sweepTempFiles(filePath);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      cachedSettings = parseSettings(raw);
      cacheLoaded = true;
      notifyLoad({ raw });
    } catch (err) {
      notifyLoad({ error: err });
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
        if (options?.atomic) {
          await replaceFile(filePath, serialized, options.mode);
          return;
        }
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
      const previous = options?.rollBackFailedSaves ? store.get() : undefined;
      const attempted = cloneSettings(settings);
      cachedSettings = attempted;
      cacheLoaded = true;
      const queued = queueWrite(attempted);
      const written = previous === undefined ? queued : queued.catch((err) => {
        // Unless something newer has replaced it since.
        if (cachedSettings === attempted) cachedSettings = previous;
        throw err;
      });
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
