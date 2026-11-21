/** Immutable lazy notice index. Orphan pages confer no baseline/dispatch authority. */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { NoticeDirectoryFlusher } from './durability';

export type NoticeJson = null | boolean | number | string | NoticeJson[] | { [key: string]: NoticeJson };
export interface NoticePageEntry { key: string; value: NoticeJson }
export interface NoticePageRoot { digest: string; first: string; last: string; count: number; depth: number }
interface LeafPage { schemaVersion: 1; minWriterVersion: 1; kind: 'leaf'; entries: NoticePageEntry[]; [extra: string]: unknown }
interface IndexPage { schemaVersion: 1; minWriterVersion: 1; kind: 'index'; children: NoticePageRoot[]; [extra: string]: unknown }
type Page = LeafPage | IndexPage;
export const NOTICE_INDEX_PAGE_BYTES = 256 * 1024;
export const NOTICE_INDEX_FANOUT = 64;
const MAX_LEAF_CACHE = 4; // at most256 detailed rows; index cache contains references only
const MAX_INDEX_CACHE = 16;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
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
  if (!isObject(root) || typeof root.digest !== 'string' || !/^[a-f0-9]{64}$/.test(root.digest)
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
  if (value.kind === 'leaf' && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= NOTICE_INDEX_FANOUT) {
    let previous: string | undefined;
    for (const entry of value.entries) {
      if (!isObject(entry)) throw new Error('Invalid notice index entry');
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
  private readonly dirtyDirectories = new Set<string>();
  private reads = 0;
  private pageReadBytes = 0;
  private maxPageReadBytes = 0;
  private peakLeafEntries = 0;
  private readonly directoryFlusher = new NoticeDirectoryFlusher();
  private constructor(private readonly directory: string) {}
  static async open(directory: string): Promise<NoticePageIndex> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const index = new NoticePageIndex(directory);
    index.dirtyDirectories.add(directory); index.dirtyDirectories.add(path.dirname(directory));
    return index;
  }
  /** Fixed-shape diagnostics for bounded-memory tests; no IDs/content. */
  get cacheStats() {
    return { leafPages: this.leaves.size, indexPages: this.branches.size,
      leafEntries: [...this.leaves.values()].reduce((sum, p) => sum + p.entries.length, 0), peakLeafEntries: this.peakLeafEntries, diskReads: this.reads,
      pageReadBytes: this.pageReadBytes, maxPageReadBytes: this.maxPageReadBytes };
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
  private async readPage(location: string): Promise<Buffer> {
    const initial = await fs.lstat(location);
    if (!initial.isFile() || initial.size > NOTICE_INDEX_PAGE_BYTES) throw new Error('Notice index page type or byte bound invalid');
    const handle = await fs.open(location, 'r');
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
      return buffer.subarray(0, used);
    } finally { await handle.close(); }
  }
  private async load(root: NoticePageRoot): Promise<Page> {
    rootValid(root);
    let page: Page | undefined = this.leaves.get(root.digest) ?? this.branches.get(root.digest);
    if (!page) {
      const body = await this.readPage(this.location(root.digest)); this.reads++;
      if (digest(body) !== root.digest) throw new Error('Notice index page checksum mismatch');
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
    try { existing = await this.readPage(location); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } // telemetry-exempt: storage failures propagate
    if (existing) {
      if (digest(existing) !== hash) throw new Error('Existing immutable notice page is damaged');
    } else {
      const directory = path.dirname(location);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `${hash}-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, location);
      this.dirtyDirectories.add(directory); this.dirtyDirectories.add(this.directory);
    }
    const root = reference(page, hash); rootValid(root);
    if (retainInCache) this.cache(hash, page);
    return root;
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
    for (const directory of [...this.dirtyDirectories].sort((a, b) => b.length - a.length)) {
      await this.directoryFlusher.flush(directory);
      this.dirtyDirectories.delete(directory);
    }
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
