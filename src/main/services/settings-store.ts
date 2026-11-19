import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { persist } from '../telemetry/persist';

export interface LoadedSettingsSnapshot<T> {
  readonly value: Readonly<T>;
  /** The source before default merging/migration; unreadable must not become verified defaults. */
  readonly primary: PeekedSettings;
  readonly origin: 'loaded' | 'accepted-save';
  readonly observedAt: number;
}

export interface SettingsStore<T> {
  get(): T;
  /** Cache state only: no IO, initialization, value access or extra raw snapshot retention. */
  hasLoaded?(): boolean;
  /** Inspect an already established, explicitly opted-in metadata cache only. Never load, migrate, recover or write. */
  peekLoaded?(): LoadedSettingsSnapshot<T> | undefined;
  save(settings: T, precondition?: SettingsCommitPrecondition): Promise<void>;
  /** Sequential read-modify-write: reads the current value, applies `fn`, saves, and returns the updated value. */
  update(fn: (current: T) => T, precondition?: SettingsCommitPrecondition): Promise<T>;
}

export interface SettingsCommitPrecondition {
  prepare(): Promise<void>;
  check(): void;
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

/** Opt-in bound for passive display readers; ordinary startup callers retain their existing read. */
export interface SettingsPeekOptions { maxBytes: number }
const MAX_SETTINGS_PEEK_BYTES = 1024 * 1024;
const validPeekLimit = (limit: number, maximum = MAX_SETTINGS_PEEK_BYTES) => Number.isSafeInteger(limit) && limit > 0 && limit <= maximum;
const samePeekFile = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const decodePeek = (bytes: Buffer): PeekedSettings => parsePeeked(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

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
export async function peekStoredSettings(filename: string, options?: SettingsPeekOptions): Promise<PeekedSettings> {
  if (options) return boundedSettingsPeek(filename, options.maxBytes);
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
export function peekStoredSettingsSync(filename: string, options?: SettingsPeekOptions): PeekedSettings {
  if (options) return boundedSettingsPeekSync(filename, options.maxBytes);
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(app.getPath('userData'), filename), 'utf-8');
  } catch (err) {
    // telemetry-exempt: the caller reports the source as uncertain
    return readErrorKind(err);
  }
  return parsePeeked(raw);
}

/** Trusted fixed host metadata path only, never a caller-supplied remote path. Same bounded passive reader. */
export async function peekMetadataFileForDisplay(admittedPath: string, maxBytes: number): Promise<PeekedSettings> {
  return boundedSettingsPeek('', maxBytes, admittedPath, 4 * 1024 * 1024);
}

/** Synchronous final-assembly check for the same trusted fixed metadata path. */
export function peekMetadataFileForDisplaySync(admittedPath: string, maxBytes: number): PeekedSettings {
  return boundedSettingsPeekSync('', maxBytes, admittedPath, 4 * 1024 * 1024);
}

/** No SettingsStore load, migration, backup, temp sweep, cache warming, or write. */
async function boundedSettingsPeek(filename: string, maxBytes: number, admittedPath?: string, maximum = MAX_SETTINGS_PEEK_BYTES): Promise<PeekedSettings> {
  if (!validPeekLimit(maxBytes, maximum)) return 'unreadable';
  const file = admittedPath ?? path.join(app.getPath('userData'), filename);
  let handle: Awaited<ReturnType<typeof fs.promises.open>>;
  try { handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); }
  catch (error) { return readErrorKind(error); } // telemetry-exempt: caller reports uncertainty
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) return 'unreadable';
    const bytes = Buffer.alloc(Number(before.size));
    let read = 0;
    while (read < bytes.length) {
      const next = await handle.read(bytes, read, bytes.length - read, read);
      if (!next.bytesRead) return 'unreadable';
      read += next.bytesRead;
    }
    if (!samePeekFile(before, await handle.stat({ bigint: true }))
      || !samePeekFile(before, await fs.promises.stat(file, { bigint: true }))) return 'unreadable';
    return decodePeek(bytes);
  } catch { return 'unreadable'; } // telemetry-exempt: caller reports uncertainty
  finally { await handle.close(); }
}

function boundedSettingsPeekSync(filename: string, maxBytes: number, admittedPath?: string, maximum = MAX_SETTINGS_PEEK_BYTES): PeekedSettings {
  if (!validPeekLimit(maxBytes, maximum)) return 'unreadable';
  const file = admittedPath ?? path.join(app.getPath('userData'), filename);
  let handle: number;
  try { handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); }
  catch (error) { return readErrorKind(error); } // telemetry-exempt: caller reports uncertainty
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) return 'unreadable';
    const bytes = Buffer.alloc(Number(before.size));
    let read = 0;
    while (read < bytes.length) {
      const next = fs.readSync(handle, bytes, read, bytes.length - read, read);
      if (!next) return 'unreadable';
      read += next;
    }
    if (!samePeekFile(before, fs.fstatSync(handle, { bigint: true }))
      || !samePeekFile(before, fs.statSync(file, { bigint: true }))) return 'unreadable';
    return decodePeek(bytes);
  } catch { return 'unreadable'; } // telemetry-exempt: caller reports uncertainty
  finally { fs.closeSync(handle); }
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
  backupUnreadableFile(path.join(app.getPath('userData'), filename));
}

/** The same bounded, durable recovery copies for project-local settings. */
export function backupUnreadableFile(source: string): void {
  const bytes = fs.readFileSync(source);
  const mode = fs.statSync(source).mode & 0o777;
  for (let n = 0; n < MAX_RECOVERY_COPIES; n++) {
    const target = recoveryCopyPath(source, n);
    if (fs.existsSync(target)) {
      if (!fs.readFileSync(target).equals(bytes)) continue;
      // A prior attempt may have written the bytes but failed to flush them.
      const handle = fs.openSync(target, process.platform === 'win32' ? 'r+' : 'r');
      try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    } else {
      const handle = fs.openSync(target, 'wx', mode);
      try {
        fs.writeFileSync(handle, bytes);
        // Creation is subject to umask; carry over the original permissions too.
        if (process.platform !== 'win32') fs.fchmodSync(handle, mode);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    }
    syncRecoveryDirectory(path.dirname(source));
    return;
  }
  throw new Error('Too many recovery copies');
}

/** Persist the new directory entry where directory fsync is supported. */
function syncRecoveryDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  let handle: number | undefined;
  try {
    handle = fs.openSync(dir, 'r');
    fs.fsyncSync(handle);
  } catch (err) {
    // telemetry-exempt: these filesystems do not implement directory fsync.
    if (!['EINVAL', 'ENOTSUP', 'ENOSYS', 'EBADF'].includes((err as NodeJS.ErrnoException)?.code ?? '')) throw err;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/** The newest recovery copy of a settings file, if there is one. */
export function latestRecoveryCopy(filename: string): string | undefined {
  const source = path.join(app.getPath('userData'), filename);
  let latest: string | undefined;
  for (let n = 0; n < MAX_RECOVERY_COPIES && fs.existsSync(recoveryCopyPath(source, n)); n++) latest = recoveryCopyPath(source, n);
  return latest;
}

let tempFileCounter = 0;

// Dot-prefixed siblings stay on the same filesystem and out of ordinary file listings.
const tempPrefix = (filePath: string): string => path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-`);

/**
 * Windows can refuse a rename while another process (often a virus scanner or
 * the search indexer) has the file open. Retry with backoff for about 3 seconds.
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1500];

async function renameOver(from: string, to: string, precondition?: SettingsCommitPrecondition): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (precondition) { await precondition.prepare(); precondition.check(); }
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
export async function replaceFile(
  filePath: string, body: string, mode: number | undefined, precondition?: SettingsCommitPrecondition,
): Promise<void> {
  const tmp = `${tempPrefix(filePath)}${process.pid}-${++tempFileCounter}`;
  const keep = mode ?? (process.platform === 'win32' ? undefined : await existingMode(filePath));
  try {
    if (precondition) { await precondition.prepare(); precondition.check(); }
    const handle = await fs.promises.open(tmp, 'w', keep ?? 0o666);
    try {
      await handle.writeFile(body, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The create mode is subject to the umask. No-op on Windows, where POSIX modes don't apply.
    if (keep != null && process.platform !== 'win32') await fs.promises.chmod(tmp, keep);
    await renameOver(tmp, filePath, precondition);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch((): void => undefined);
    throw err;
  }
}

/**
 * Remove temp files a crash left beside `filePath`, from other processes only:
 * this one's own may still be in flight. Only exact generated names at least
 * a day old are eligible; similarly named user recovery files stay untouched.
 */
function sweepTempFiles(filePath: string): void {
  const dir = path.dirname(filePath);
  const prefixes = [path.basename(tempPrefix(filePath)), `${path.basename(filePath)}.tmp-`];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // telemetry-exempt: nothing to sweep when the folder can't be listed
    return;
  }
  const oldest = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of names) {
    const prefix = prefixes.find((candidate) => name.startsWith(candidate));
    if (!prefix) continue;
    const generated = /^([1-9]\d*)-([1-9]\d*)$/.exec(name.slice(prefix.length));
    if (!generated || Number(generated[1]) === process.pid) continue;
    try {
      const stat = fs.lstatSync(path.join(dir, name));
      if (!stat.isFile() || stat.mtimeMs > oldest) continue;
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
    /** Retain passive display provenance for this metadata-only store. Never opt credentials into display. */
    displaySnapshot?: true;
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
     * Skip persistence and audit when update returns its exact current object.
     * Opt-in only: callbacks must leave that object (including nested values)
     * untouched to signal a no-op. save() always writes.
     */
    skipUnchangedUpdates?: boolean;
    /**
     * Write a temp file next to the target, flush it, then rename it over the
     * target, so a crash or power loss mid-write leaves the old file whole
     * instead of a torn one that loads as defaults. Temp files left by a crash
     * are removed at the next load. A symlinked file is replaced by a regular
     * one. Always enabled; retained for callers that previously opted in.
     */
    atomic?: true;
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
  let displaySnapshot: LoadedSettingsSnapshot<T> | undefined;
  let needsRecoveryCopy = false;
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
    sweepTempFiles(filePath);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      cachedSettings = parseSettings(raw);
      displaySnapshot = options?.displaySnapshot ? { value: cachedSettings as Readonly<T>, primary: parsePeeked(raw), origin: 'loaded', observedAt: Date.now() } : undefined;
      cacheLoaded = true;
      notifyLoad({ raw });
    } catch (err) {
      notifyLoad({ error: err });
      if (fs.existsSync(filePath)) {
        needsRecoveryCopy = true;
        try {
          backupUnreadableSettings(filename);
          needsRecoveryCopy = false;
        } catch (backupError) {
          // Defaults remain readable, but a save must not destroy the only copy.
          console.warn(`[settings-store] Could not preserve unreadable ${filename}:`, backupError instanceof Error ? backupError.message : backupError);
        }
        persist.recovery('settings', 'reset_to_default');
        // A parser's message quotes the file, which stays out of the log.
        console.warn(
          `[settings-store] Failed to parse ${filename}, using defaults:`,
          err instanceof SyntaxError ? 'invalid JSON' : err instanceof Error ? err.message : err,
        );
      }
      cachedSettings = cloneSettings(defaults);
      displaySnapshot = options?.displaySnapshot ? { value: cachedSettings as Readonly<T>, primary: readErrorKind(err), origin: 'loaded', observedAt: Date.now() } : undefined;
      cacheLoaded = true;
    }
  }

  function queueWrite(settings: T, precondition?: SettingsCommitPrecondition): Promise<void> {
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
        if (precondition) { await precondition.prepare(); precondition.check(); }
        if (needsRecoveryCopy) {
          backupUnreadableSettings(filename);
          needsRecoveryCopy = false;
        }
        await replaceFile(filePath, serialized, options?.mode, precondition);
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
    hasLoaded() { return cacheLoaded && cachedSettings !== null; },
    peekLoaded() {
      if (!displaySnapshot) return undefined;
      // Detach every exposed level. Freezing a live cache (or returning nested
      // provenance aliases) would let display callers affect ordinary settings.
      const primary = typeof displaySnapshot.primary === 'object' ? Object.freeze(cloneSettings(displaySnapshot.primary)) : displaySnapshot.primary;
      const value = Object.freeze(cloneSettings(cachedSettings!)) as Readonly<T>;
      return Object.freeze({ ...displaySnapshot, primary, value });
    },
    get() {
      if (!cacheLoaded || cachedSettings === null) {
        loadSettings();
      }
      return Object.freeze(cachedSettings!) as T;
    },
    save(settings: T, precondition?: SettingsCommitPrecondition) {
      precondition?.check();
      // Even save-before-get must preserve an unreadable existing file.
      if (!cacheLoaded) loadSettings();
      const before = auditSnapshot();
      const previous = options?.rollBackFailedSaves || precondition ? store.get() : undefined;
      const previousDisplaySnapshot = displaySnapshot;
      const attempted = cloneSettings(settings);
      cachedSettings = attempted;
      displaySnapshot = options?.displaySnapshot ? { value: attempted as Readonly<T>, primary: attempted !== null && typeof attempted === 'object' && !Array.isArray(attempted) ? cloneSettings(attempted) as Record<string, unknown> : 'unreadable', origin: 'accepted-save', observedAt: Date.now() } : undefined;
      cacheLoaded = true;
      const queued = queueWrite(attempted, precondition);
      const written = previous === undefined ? queued : queued.catch((err) => {
        // Unless something newer has replaced it since.
        if (cachedSettings === attempted) { cachedSettings = previous; displaySnapshot = previousDisplaySnapshot; }
        throw err;
      });
      if (before === undefined) return written;
      const after = cloneSettings(settings);
      // A failed write stays this promise's failure, and records nothing. The audit's own failure stays out of it.
      void written.then(() => reportAudit(before, after), (): void => undefined);
      return written;
    },
    update(fn: (current: T) => T, precondition?: SettingsCommitPrecondition): Promise<T> {
      const result = updateLock.catch(() => {}).then(async (): Promise<T> => {
        if (precondition) { await precondition.prepare(); precondition.check(); }
        const current = store.get();
        const updated = fn(current);
        if (options?.skipUnchangedUpdates && updated === current) return cloneSettings(current);
        return store.save(updated, precondition).then(() => cloneSettings(updated));
      });
      updateLock = result;
      return result;
    },
  };

  settingsStoreResetters.add(() => {
    cachedSettings = null;
    cacheLoaded = false;
    displaySnapshot = undefined;
    needsRecoveryCopy = false;
    pendingWrite = Promise.resolve();
    updateLock = Promise.resolve();
  });

  return store;
}
