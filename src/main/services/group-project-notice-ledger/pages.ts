/** Immutable lazy notice index. Orphan pages confer no baseline/dispatch authority. */
import * as fs from 'fs/promises';
import * as path from 'path';
import { constants } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { NoticeDirectoryFlusher } from './durability';

export type NoticeJson = null | boolean | number | string | NoticeJson[] | { [key: string]: NoticeJson };
export interface NoticePageEntry { key: string; value: NoticeJson }
export interface NoticePageRoot { digest: string; first: string; last: string; count: number; depth: number }
interface LeafPage { schemaVersion: 1; minWriterVersion: 1; kind: 'leaf'; entries: NoticePageEntry[] }
interface IndexPage { schemaVersion: 1; minWriterVersion: 1; kind: 'index'; children: NoticePageRoot[] }
type Page = LeafPage | IndexPage;
export const NOTICE_INDEX_PAGE_BYTES = 256 * 1024;
export const NOTICE_INDEX_FANOUT = 64;
const MAX_LEAF_CACHE = 4; // at most256 detailed rows; index cache contains references only
const MAX_INDEX_CACHE = 16;
// At most20 decoded pages per index, each encoded <=256KiB (~5MiB encoded).
// Parsed-object expansion, input values and call transients are additional;
// this is not a whole-index heap or whole-process memory budget.
/** Only absence at the initial lookup permits creation; later IO never does. */
class NoticePageAbsentError extends Error { readonly code = 'ENOENT'; }
export type NoticePageFailurePoint = 'beforePageOpen' | 'pageTempOpened' | 'beforePageWrite' | 'beforePageSync' | 'beforePageRename' | 'beforeTempCleanup' | 'beforeReusedSync' | 'reusedPageSynced' | 'beforeDirectoryFlush' | 'afterDirectoryFlush';
export interface NoticePageOptions {
  /** Deterministic fixture seam only. Production callers omit this. */
  testFailure?: (point: NoticePageFailurePoint, location: string) => void | Promise<void>;
  /** Branch/descriptor controls only; not application configuration. */
  testPlatform?: NodeJS.Platform;
  testOpenPage?: (location: string, flags: number) => Promise<import('fs/promises').FileHandle>;
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function keyValid(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 512 || [...key].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('Invalid notice index key');
}
function json(value: unknown): NoticeJson {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, json(value[key])]));
  }
  throw new Error('Notice index requires finite JSON values');
}
function rootValid(root: unknown): asserts root is NoticePageRoot {
  if (!isObject(root) || !exactKeys(root, ['digest', 'first', 'last', 'count', 'depth']) || typeof root.digest !== 'string' || !/^[a-f0-9]{64}$/.test(root.digest)
    || !Number.isSafeInteger(root.count) || (root.count as number) < 1 || !Number.isSafeInteger(root.depth) || (root.depth as number) < 0 || (root.depth as number) > 32) throw new Error('Invalid notice page reference');
  keyValid(root.first); keyValid(root.last);
  if (root.first > root.last) throw new Error('Reversed notice page bounds');
}
function reference(page: Page, hash: string): NoticePageRoot {
  if (page.kind === 'leaf') return { digest: hash, first: page.entries[0].key, last: page.entries[page.entries.length - 1].key, count: page.entries.length, depth: 0 };
  const count = page.children.reduce((sum, child) => sum + child.count, 0);
  if (!Number.isSafeInteger(count)) throw new Error('Notice page count overflow');
  return { digest: hash, first: page.children[0].first, last: page.children[page.children.length - 1].last, count, depth: Math.max(...page.children.map((child) => child.depth)) + 1 };
}
function decode(body: Buffer): Page {
  if (body.length > NOTICE_INDEX_PAGE_BYTES) throw new Error('Notice index page exceeds byte bound');
  const value: unknown = JSON.parse(body.toString('utf8'));
  if (!isObject(value) || value.schemaVersion !== 1 || value.minWriterVersion !== 1) throw new Error('Unsupported notice index page writer version');
  const keys = value.kind === 'leaf' ? ['schemaVersion', 'minWriterVersion', 'kind', 'entries']
    : value.kind === 'index' ? ['schemaVersion', 'minWriterVersion', 'kind', 'children'] : undefined;
  if (!keys || !exactKeys(value, keys)) throw new Error('Unsupported notice index page fields');
  if (value.kind === 'leaf' && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= NOTICE_INDEX_FANOUT) {
    let previous: string | undefined;
    for (const entry of value.entries) {
      if (!isObject(entry) || !exactKeys(entry, ['key', 'value'])) throw new Error('Invalid notice index entry fields');
      keyValid(entry.key); json(entry.value);
      if (previous !== undefined && previous >= entry.key) throw new Error('Noncanonical notice index keys');
      previous = entry.key;
    }
  } else if (value.kind === 'index' && Array.isArray(value.children) && value.children.length > 0 && value.children.length <= NOTICE_INDEX_FANOUT) {
    let previous: string | undefined;
    for (const child of value.children) {
      rootValid(child);
      if (previous !== undefined && previous >= child.first) throw new Error('Overlapping notice page references');
      previous = child.last;
    }
  } else throw new Error('Invalid notice index page');
  return value as unknown as Page;
}

export class NoticePageIndex {
  private readonly leaves = new Map<string, LeafPage>();
  private readonly branches = new Map<string, IndexPage>();
  private readonly dirtyDirectories = new Map<string, symbol>();
  private reads = 0;
  private pageReadBytes = 0;
  private maxPageReadBytes = 0;
  private peakLeafEntries = 0;
  private readonly directoryFlusher = new NoticeDirectoryFlusher();
  private constructor(private readonly directory: string, private readonly options: NoticePageOptions) {}
  static async open(directory: string, options: NoticePageOptions = {}): Promise<NoticePageIndex> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const index = new NoticePageIndex(directory, options);
    index.dirtyDirectories.set(directory, Symbol()); index.dirtyDirectories.set(path.dirname(directory), Symbol());
    return index;
  }
  /** Fixed-shape diagnostics for bounded-memory tests; no IDs/content. */
  get cacheStats() {
    return { leafPages: this.leaves.size, indexPages: this.branches.size,
      leafEntries: [...this.leaves.values()].reduce((sum, p) => sum + p.entries.length, 0), peakLeafEntries: this.peakLeafEntries, diskReads: this.reads,
      pageReadBytes: this.pageReadBytes, maxPageReadBytes: this.maxPageReadBytes, pendingDirectoryCount: this.dirtyDirectories.size };
  }
  get directoryDurability() { return this.directoryFlusher.observation; }
  clearCache(): void { this.leaves.clear(); this.branches.clear(); }
  private cache(hash: string, page: Page): void {
    if (page.kind === 'leaf') {
      this.leaves.delete(hash); this.leaves.set(hash, page);
      while (this.leaves.size > MAX_LEAF_CACHE) this.leaves.delete(this.leaves.keys().next().value!);
    } else {
      this.branches.delete(hash); this.branches.set(hash, page);
      while (this.branches.size > MAX_INDEX_CACHE) this.branches.delete(this.branches.keys().next().value!);
    }
    this.peakLeafEntries = Math.max(this.peakLeafEntries, this.cacheStats.leafEntries);
  }
  private location(hash: string): string { return path.join(this.directory, hash.slice(0, 2), `${hash}.json`); }
  /** Bound allocation and reads before decoding even damaged on-disk content. */
  private async readPage(location: string, expectedDigest: string, syncValidated = false): Promise<Buffer> {
    let initial: import('fs').Stats;
    try { initial = await fs.lstat(location); }
    catch (error) {
      // telemetry-exempt: only initial absence is new-page permission; all other IO propagates
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoticePageAbsentError('Notice index page is missing');
      throw error;
    }
    if (!initial.isFile() || initial.size > NOTICE_INDEX_PAGE_BYTES) throw new Error('Notice index page type or byte bound invalid');
    await this.options.testFailure?.('beforePageOpen', location);
    // A regular file may be replaced after lstat. Never block on a swapped FIFO.
    // Windows FlushFileBuffers needs write access. Open non-truncating BEFORE
    // validating, so digest/identity checks and sync use one exact descriptor.
    // Ordinary reads and all POSIX reuse keep the read-only path unchanged.
    const writableSync = syncValidated && (this.options.testPlatform ?? process.platform) === 'win32';
    const flags = (writableSync ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
    const handle = await (this.options.testOpenPage ?? fs.open)(location, flags);
    try {
      const opened = await handle.stat();
      const same = (stat: typeof opened) => stat.isFile() && stat.dev === initial.dev && stat.ino === initial.ino
        && stat.size === initial.size && stat.mtimeMs === initial.mtimeMs && stat.ctimeMs === initial.ctimeMs;
      if (!same(opened)) throw new Error('Notice index page changed while opening');
      const buffer = Buffer.alloc(NOTICE_INDEX_PAGE_BYTES + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
        used += bytesRead; this.pageReadBytes += bytesRead;
        this.maxPageReadBytes = Math.max(this.maxPageReadBytes, used);
        if (!bytesRead) break;
      }
      if (used > NOTICE_INDEX_PAGE_BYTES) throw new Error('Notice index page exceeds byte bound');
      if (used !== initial.size || !same(await handle.stat()) || !same(await fs.lstat(location))) throw new Error('Notice index page changed while reading');
      const body = buffer.subarray(0, used);
      if (digest(body) !== expectedDigest) throw new Error('Notice index page checksum mismatch');
      if (syncValidated) {
        await this.options.testFailure?.('beforeReusedSync', location);
        await handle.sync();
        await this.options.testFailure?.('reusedPageSynced', location);
        if (!same(await handle.stat()) || !same(await fs.lstat(location))) throw new Error('Reused notice page changed while syncing');
      }
      return body;
    } finally { await handle.close(); }
  }
  private async load(root: NoticePageRoot): Promise<Page> {
    rootValid(root);
    let page: Page | undefined = this.leaves.get(root.digest) ?? this.branches.get(root.digest);
    if (!page) {
      const body = await this.readPage(this.location(root.digest), root.digest); this.reads++;
      page = decode(body);
    }
    const actual = reference(page, root.digest);
    if (actual.first !== root.first || actual.last !== root.last || actual.count !== root.count || actual.depth !== root.depth) throw new Error('Notice page reference metadata mismatch');
    this.cache(root.digest, page);
    return page;
  }
  private async put(page: Page, retainInCache = true): Promise<NoticePageRoot> {
    const body = Buffer.from(JSON.stringify(page));
    decode(body); // byte/fanout/order/version checks before any filesystem publication
    const hash = digest(body);
    const location = this.location(hash);
    let existing: Buffer | undefined;
    try { existing = await this.readPage(location, hash, true); }
    catch (error) { if (!(error instanceof NoticePageAbsentError)) throw error; } // telemetry-exempt: later IO/sync failures never authorize replacement
    if (existing) {
      this.markPageDirectories(location); // Reused page barrier: must survive process reopen.
    } else {
      const directory = path.dirname(location);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await this.writePage(location, body, hash);
      this.markPageDirectories(location);
    }
    const root = reference(page, hash); rootValid(root);
    if (retainInCache) this.cache(hash, page);
    return root;
  }
  private markPageDirectories(location: string): void {
    // Only the 256 fixed hash prefixes plus index/parent: never per-page growth.
    this.dirtyDirectories.set(path.dirname(location), Symbol()); this.dirtyDirectories.set(this.directory, Symbol());
  }
  private async writePage(location: string, body: Buffer, hash: string): Promise<void> {
    const temporary = path.join(path.dirname(location), `${hash}-${randomUUID()}.tmp`);
    let handle: import('fs/promises').FileHandle | undefined;
    let created = false; let identity: import('fs').BigIntStats | undefined;
    let failed = false; let original: unknown;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); created = true;
      identity = await handle.stat({ bigint: true });
      await this.options.testFailure?.('pageTempOpened', temporary);
      await this.options.testFailure?.('beforePageWrite', temporary);
      await handle.writeFile(body);
      await this.options.testFailure?.('beforePageSync', temporary);
      await handle.sync();
      await handle.close(); handle = undefined;
      await this.options.testFailure?.('beforePageRename', temporary);
      await fs.rename(temporary, location);
    } catch (error) {
      // telemetry-exempt: propagated below after current-own-temp cleanup
      failed = true; original = error;
    } finally {
      if (handle) {
        try { await handle.close(); }
        catch (error) {
          // telemetry-exempt: preserve first failure over a secondary close error
          if (!failed) { failed = true; original = error; }
        }
      }
      if (created) {
        try {
          await this.options.testFailure?.('beforeTempCleanup', temporary);
          const named = await fs.lstat(temporary, { bigint: true });
          if (identity && named.isFile() && named.dev === identity.dev && named.ino === identity.ino) await fs.unlink(temporary);
        } catch { /* telemetry-exempt: best effort only; preserve original failure and ambiguous/prior-process residue */ }
      }
    }
    if (failed) throw original;
  }
  async validateRoot(root: NoticePageRoot): Promise<void> { await this.load(root); }
  /** Full verification streams pages through bounded caches; never returns all rows. */
  async verify(root: NoticePageRoot | undefined): Promise<{ rows: number; pages: number }> {
    if (!root) return { rows: 0, pages: 0 };
    const page = await this.load(root);
    if (page.kind === 'leaf') return { rows: page.entries.length, pages: 1 };
    let rows = 0; let pages = 1;
    for (const child of page.children) {
      const result = await this.verify(child); rows += result.rows; pages += result.pages;
    }
    if (rows !== root.count) throw new Error('Notice index descendant count mismatch');
    return { rows, pages };
  }
  /** Sorted streaming baseline preparation; no generation, nonce or root activation. */
  async build(entries: Iterable<NoticePageEntry> | AsyncIterable<NoticePageEntry>): Promise<NoticePageRoot | undefined> {
    const levels: NoticePageRoot[][] = [];
    let batch: NoticePageEntry[] = [];
    let previous: string | undefined;
    const push = async (root: NoticePageRoot, level = 0): Promise<void> => {
      if (level > 32) throw new Error('Notice baseline index is too deep');
      (levels[level] ??= []).push(root);
      if (levels[level].length === NOTICE_INDEX_FANOUT) {
        const children = levels[level]; levels[level] = [];
        await push(await this.put({ schemaVersion: 1, minWriterVersion: 1, kind: 'index', children }, false), level + 1);
      }
    };
    for await (const entry of entries) {
      keyValid(entry.key);
      if (previous !== undefined && previous >= entry.key) throw new Error('Notice baseline keys must be strictly sorted');
      previous = entry.key;
      const row = { key: entry.key, value: json(entry.value) };
      const page = { schemaVersion: 1 as const, minWriterVersion: 1 as const, kind: 'leaf' as const, entries: [...batch, row] };
      if (batch.length && (page.entries.length > NOTICE_INDEX_FANOUT || Buffer.byteLength(JSON.stringify(page)) > NOTICE_INDEX_PAGE_BYTES)) {
        await push(await this.put({ ...page, entries: batch }, false)); batch = [];
      }
      batch.push(row);
    }
    if (batch.length) await push(await this.put({ schemaVersion: 1, minWriterVersion: 1, kind: 'leaf', entries: batch }, false));
    let frontier = levels.flat().sort((a, b) => a.first < b.first ? -1 : a.first > b.first ? 1 : 0);
    while (frontier.length > 1) {
      const parents: NoticePageRoot[] = [];
      for (let offset = 0; offset < frontier.length; offset += NOTICE_INDEX_FANOUT) {
        const children = frontier.slice(offset, offset + NOTICE_INDEX_FANOUT);
        parents.push(children.length === 1 ? children[0] : await this.put({ schemaVersion: 1, minWriterVersion: 1, kind: 'index', children }, false));
      }
      frontier = parents;
    }
    return frontier[0];
  }
  /** Must succeed before an activating journal/root record; no root is activated here. */
  async flush(): Promise<void> {
    for (const [directory, version] of [...this.dirtyDirectories].sort(([a], [b]) => b.length - a.length)) {
      await this.options.testFailure?.('beforeDirectoryFlush', directory);
      await this.directoryFlusher.flush(directory);
      if (this.dirtyDirectories.get(directory) === version) this.dirtyDirectories.delete(directory);
      await this.options.testFailure?.('afterDirectoryFlush', directory);
    }
    if (this.dirtyDirectories.size) throw new Error('Notice page preparation changed during flush; retry the barrier');
  }
  async get(root: NoticePageRoot | undefined, key: string): Promise<NoticeJson | undefined> {
    keyValid(key);
    if (!root) return undefined;
    const page = await this.load(root);
    if (page.kind === 'leaf') {
      const entry = page.entries.find((e) => e.key === key);
      return entry ? copy(entry.value) : undefined;
    }
    const child = page.children.find((c) => key >= c.first && key <= c.last);
    return child ? this.get(child, key) : undefined;
  }
  /** Range-neighbour lookup for terminal intervals; lexical key ordering only. */
  async atOrBefore(root: NoticePageRoot | undefined, key: string): Promise<NoticePageEntry | undefined> {
    keyValid(key);
    if (!root) return undefined;
    const page = await this.load(root);
    if (page.kind === 'leaf') {
      for (let index = page.entries.length - 1; index >= 0; index--) if (page.entries[index].key <= key) return copy(page.entries[index]);
    } else {
      for (let index = page.children.length - 1; index >= 0; index--) {
        if (page.children[index].first > key) continue;
        const entry = await this.atOrBefore(page.children[index], key);
        if (entry) return entry;
      }
    }
    return undefined;
  }
  async list(root: NoticePageRoot | undefined, options: { after?: string; limit: number }): Promise<{ entries: NoticePageEntry[]; nextAfter?: string }> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 256) throw new Error('Invalid notice page limit');
    if (options.after !== undefined) keyValid(options.after);
    const entries: NoticePageEntry[] = [];
    const visit = async (ref: NoticePageRoot): Promise<void> => {
      const page = await this.load(ref);
      if (page.kind === 'leaf') {
        for (const entry of page.entries) if (options.after === undefined || entry.key > options.after) {
          entries.push(copy(entry)); if (entries.length === options.limit) return;
        }
      } else for (const child of page.children) {
        if (options.after !== undefined && child.last <= options.after) continue;
        await visit(child); if (entries.length === options.limit) return;
      }
    };
    if (root) await visit(root);
    return { entries, ...(entries.length === options.limit ? { nextAfter: entries[entries.length - 1].key } : {}) };
  }
  async set(root: NoticePageRoot | undefined, key: string, value: NoticeJson): Promise<NoticePageRoot> {
    keyValid(key);
    const entry = { key, value: json(value) };
    if (!root) return this.put({ schemaVersion: 1, minWriterVersion: 1, kind: 'leaf', entries: [entry] });
    const changed = await this.insert(root, entry);
    return changed.length === 1 ? changed[0] : this.put({ schemaVersion: 1, minWriterVersion: 1, kind: 'index', children: changed });
  }
  private async insert(root: NoticePageRoot, entry: NoticePageEntry): Promise<NoticePageRoot[]> {
    const page = await this.load(root);
    if (page.kind === 'leaf') {
      const entries = page.entries.filter((e) => e.key !== entry.key);
      entries.push(entry); entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const candidate = { ...page, entries };
      if (entries.length <= NOTICE_INDEX_FANOUT && Buffer.byteLength(JSON.stringify(candidate)) <= NOTICE_INDEX_PAGE_BYTES) return [await this.put(candidate)];
      const roots: NoticePageRoot[] = [];
      let batch: NoticePageEntry[] = [];
      // Fanout64 limits this split to at most65 rows. Repeated JSON sizing
      // copies bounded batches (quadratic row work per split), not a whole
      // build/heap/latency guarantee for caller-supplied values.
      for (const item of entries) {
        if (batch.length && (batch.length === NOTICE_INDEX_FANOUT || Buffer.byteLength(JSON.stringify({ ...page, entries: [...batch, item] })) > NOTICE_INDEX_PAGE_BYTES)) {
          roots.push(await this.put({ ...page, entries: batch })); batch = [];
        }
        batch.push(item);
      }
      if (batch.length) roots.push(await this.put({ ...page, entries: batch }));
      return roots;
    }
    const slot = Math.max(0, page.children.findIndex((c) => entry.key <= c.last));
    const index = entry.key > page.children[page.children.length - 1].last ? page.children.length - 1 : slot;
    const replacement = await this.insert(page.children[index], entry);
    const children = [...page.children.slice(0, index), ...replacement, ...page.children.slice(index + 1)];
    if (children.length <= NOTICE_INDEX_FANOUT) return [await this.put({ ...page, children })];
    const mid = Math.floor(children.length / 2);
    return [await this.put({ ...page, children: children.slice(0, mid) }), await this.put({ ...page, children: children.slice(mid) })];
  }
  async delete(root: NoticePageRoot | undefined, key: string): Promise<NoticePageRoot | undefined> {
    keyValid(key);
    if (!root) return undefined;
    const page = await this.load(root);
    if (page.kind === 'leaf') {
      const entries = page.entries.filter((e) => e.key !== key);
      if (entries.length === page.entries.length) return root;
      return entries.length ? this.put({ ...page, entries }) : undefined;
    }
    const slot = page.children.findIndex((child) => key >= child.first && key <= child.last);
    if (slot < 0) return root;
    const replacement = await this.delete(page.children[slot], key);
    if (replacement?.digest === page.children[slot].digest) return root;
    const children = [...page.children.slice(0, slot), ...(replacement ? [replacement] : []), ...page.children.slice(slot + 1)];
    if (children.length < 2) return children[0];
    return this.put({ ...page, children });
  }
}
