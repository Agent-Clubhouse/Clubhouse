import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_MEMORY_PAGE_CHARS, MemoryReadError, readDispatcherMemory } from './dispatcher-memory-reader';

let base = '';
let root = '';

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-memory-read-'));
  root = path.join(base, 'memory');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.md'), '# Index\n- agents/webapp-lead.md\n');
  fs.writeFileSync(path.join(root, 'agents', 'webapp-lead.md'), 'Owns checkout.');
  fs.writeFileSync(path.join(base, 'secret.md'), 'outside');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('reading the Dispatcher\'s memory (#3036)', () => {
  it('returns the index and the list of pages with no page', async () => {
    const read = await readDispatcherMemory(undefined, root);
    expect(read).toMatchObject({ page: 'index.md', text: '# Index\n- agents/webapp-lead.md\n', pages: ['agents/webapp-lead.md', 'index.md'] });
  });

  it('reads one page', async () => {
    expect(await readDispatcherMemory('agents/webapp-lead.md', root)).toEqual({ page: 'agents/webapp-lead.md', text: 'Owns checkout.' });
  });

  it('says so when there is no memory yet', async () => {
    expect(await readDispatcherMemory(undefined, path.join(base, 'none'))).toEqual({ text: 'There is no memory yet.', pages: [] });
  });

  it('never reads outside the memory folder', async () => {
    for (const page of ['../secret.md', 'agents/../../secret.md', path.join(base, 'secret.md'), 'C:/secret.md']) {
      await expect(readDispatcherMemory(page, root), page).rejects.toBeInstanceOf(MemoryReadError);
    }
    await expect(readDispatcherMemory('agents/webapp-lead.txt', root)).rejects.toBeInstanceOf(MemoryReadError);
    await expect(readDispatcherMemory('agents/missing.md', root)).rejects.toBeInstanceOf(MemoryReadError);
  });

  it.skipIf(process.platform === 'win32')('doesn\'t follow a link out of the folder, or list one', async () => {
    fs.symlinkSync(path.join(base, 'secret.md'), path.join(root, 'leak.md'));
    await expect(readDispatcherMemory('leak.md', root)).rejects.toBeInstanceOf(MemoryReadError);
    expect((await readDispatcherMemory(undefined, root)).pages).not.toContain('leak.md');
  });

  it('reads the index cut to its cap, as a start loads it (#3038)', async () => {
    const { MEMORY_INDEX_CAP_BYTES } = await import('./dispatcher-memory');
    fs.writeFileSync(path.join(root, 'index.md'), 'y'.repeat(MEMORY_INDEX_CAP_BYTES * 2));
    expect(Buffer.byteLength((await readDispatcherMemory(undefined, root)).text)).toBeLessThanOrEqual(MEMORY_INDEX_CAP_BYTES);
  });

  it('lists pages across the layout\'s folders', async () => {
    for (const dir of ['timeline', 'topics']) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, 'timeline', '2026-11-07.md'), '- 09:00 checkout fixed');
    fs.writeFileSync(path.join(root, 'topics', 'release.md'), 'Status: confirmed');
    expect((await readDispatcherMemory(undefined, root)).pages).toEqual(['agents/webapp-lead.md', 'index.md', 'timeline/2026-11-07.md', 'topics/release.md']);
    expect((await readDispatcherMemory('timeline/2026-11-07.md', root)).text).toBe('- 09:00 checkout fixed');
  });

  it('cuts a long page and says so', async () => {
    fs.writeFileSync(path.join(root, 'long.md'), 'x'.repeat(MAX_MEMORY_PAGE_CHARS + 10));
    const read = await readDispatcherMemory('long.md', root);
    expect(read.text).toHaveLength(MAX_MEMORY_PAGE_CHARS);
    expect(read.truncated).toBe(true);
  });

  it('writes nothing', async () => {
    const before = fs.readdirSync(root, { recursive: true }).sort();
    await readDispatcherMemory(undefined, root);
    await readDispatcherMemory('agents/webapp-lead.md', root);
    expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });
});
