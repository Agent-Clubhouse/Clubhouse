import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { NOTICE_INDEX_PAGE_BYTES, NoticePageIndex, type NoticePageRoot } from './pages';

const homes: string[] = [];
async function home() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'q5-pages-')); homes.push(directory); return directory; }
afterEach(async () => { await Promise.all(homes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
const key = (index: number) => `synthetic-${String(index).padStart(8, '0')}`;

describe('lazy immutable notice index', () => {
  it('keeps >64KiB of exact ID data paged and bounds detail cache to256 rows on write and cold reads', async () => {
    const directory = await home();
    let index = await NoticePageIndex.open(directory);
    let root: NoticePageRoot | undefined;
    for (let n = 0; n < 1024; n++) root = await index.set(root, key(n), { postId: `${key(n)}-${'x'.repeat(180)}`, status: 'uncertain' });
    await index.flush();
    expect(root?.count).toBe(1024);
    expect(index.cacheStats.peakLeafEntries).toBeLessThanOrEqual(256);
    expect(index.cacheStats.leafPages).toBeLessThanOrEqual(4);
    expect(index.cacheStats.indexPages).toBeLessThanOrEqual(16);
    expect((await fs.readdir(directory)).some((name) => name === 'manifest.json')).toBe(false);
    index = await NoticePageIndex.open(directory);
    expect(index.cacheStats.leafEntries).toBe(0);
    expect(await index.get(root, key(700))).toMatchObject({ postId: `${key(700)}-${'x'.repeat(180)}` });
    expect(index.cacheStats.diskReads).toBeLessThanOrEqual(4);
    const page = await index.list(root, { after: key(699), limit: 200 });
    expect(page.entries).toHaveLength(200);
    expect(page.entries[0].key).toBe(key(700));
    expect(page.entries[199].key).toBe(key(899));
    expect(index.cacheStats.peakLeafEntries).toBeLessThanOrEqual(256);
    expect(index.cacheStats.diskReads).toBeLessThan(20);
    expect(await index.get(root, key(1024))).toBeUndefined();
    for (const prefix of await fs.readdir(directory)) for (const name of await fs.readdir(path.join(directory, prefix))) {
      if (name.endsWith('.json')) expect((await fs.stat(path.join(directory, prefix, name))).size).toBeLessThanOrEqual(NOTICE_INDEX_PAGE_BYTES);
    }
  }, 30000);

  it('preserves old roots through update/delete and returns no mutable cached details', async () => {
    const index = await NoticePageIndex.open(await home());
    let root: NoticePageRoot | undefined;
    for (let n = 0; n < 100; n++) root = await index.set(root, key(n), { value: n });
    const original = root!;
    const changed = await index.set(root, key(50), { value: 5000 });
    expect(await index.get(original, key(50))).toEqual({ value: 50 });
    expect(await index.get(changed, key(50))).toEqual({ value: 5000 });
    const result = await index.get(changed, key(50)) as { value: number };
    result.value = -1;
    expect(await index.get(changed, key(50))).toEqual({ value: 5000 });
    root = await index.delete(changed, key(50));
    expect(await index.get(root, key(50))).toBeUndefined();
    expect(await index.get(changed, key(50))).toEqual({ value: 5000 });
    expect(root?.count).toBe(99);
    for (let n = 0; n < 100; n++) root = await index.delete(root, key(n));
    expect(root).toBeUndefined();
    expect(await index.get(original, key(0))).toEqual({ value: 0 });
  }, 15000);

  it('splits by bytes for adjacent large values rather than rejecting valid later work', async () => {
    const index = await NoticePageIndex.open(await home());
    let root = await index.set(undefined, 'a', 'x'.repeat(180000));
    for (let n = 0; n < 20; n++) root = await index.set(root, `b${String(n).padStart(2, '0')}`, 'small');
    root = await index.set(root, 'a1', 'y'.repeat(180000));
    expect(root.count).toBe(22);
    expect(await index.get(root, 'a1')).toHaveLength(180000);
    expect(await index.get(root, 'a')).toHaveLength(180000);
    const prior = root;
    await expect(index.set(root, 'oversized', 'z'.repeat(NOTICE_INDEX_PAGE_BYTES))).rejects.toThrow('bound');
    expect(await index.get(prior, 'oversized')).toBeUndefined();
  }, 15000);

  it('refuses damaged referenced bytes and invalid reference metadata without replacement', async () => {
    const directory = await home();
    const index = await NoticePageIndex.open(directory);
    const root = await index.set(undefined, 'stable-id', { state: 'uncertain' });
    await index.flush();
    index.clearCache();
    await expect(index.get({ ...root, count: 2 }, 'stable-id')).rejects.toThrow('metadata mismatch');
    const file = path.join(directory, root.digest.slice(0, 2), `${root.digest}.json`);
    await fs.writeFile(file, 'damaged');
    index.clearCache();
    await expect(index.get(root, 'stable-id')).rejects.toThrow('checksum');
    expect(await fs.readFile(file, 'utf8')).toBe('damaged');
  });

  it('rejects a future page writer version even with a correct content hash', async () => {
    const directory = await home();
    const index = await NoticePageIndex.open(directory);
    const bytes = JSON.stringify({ schemaVersion: 1, minWriterVersion: 2, kind: 'leaf', entries: [{ key: 'id', value: true }] });
    const hash = createHash('sha256').update(bytes).digest('hex');
    await fs.mkdir(path.join(directory, hash.slice(0, 2)));
    await fs.writeFile(path.join(directory, hash.slice(0, 2), `${hash}.json`), bytes);
    await expect(index.get({ digest: hash, first: 'id', last: 'id', count: 1, depth: 0 }, 'id')).rejects.toThrow('writer');
  });

  it('pages lexically without treating keys as board ordering and refuses malformed limits/keys/JSON', async () => {
    const index = await NoticePageIndex.open(await home());
    let root: NoticePageRoot | undefined;
    for (const name of ['same-hash/id-b', 'same-hash/id-a', 'other/id']) root = await index.set(root, name, { id: name });
    const first = await index.list(root, { limit: 2 });
    const second = await index.list(root, { limit: 2, after: first.nextAfter });
    expect([...first.entries, ...second.entries].map((e) => e.key)).toEqual(['other/id', 'same-hash/id-a', 'same-hash/id-b']);
    await expect(index.list(root, { limit: 257 })).rejects.toThrow('limit');
    await expect(index.get(root, '../\u0000')).rejects.toThrow('key');
    await expect(index.set(root, 'bad-json', Number.NaN)).rejects.toThrow('finite JSON');
    await expect(index.get({ ...root!, digest: '../../outside' }, 'id')).rejects.toThrow('reference');
  });
});
