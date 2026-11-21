import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
vi.mock('fs', async (original) => { const actual = await original<typeof import('fs')>(); return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync) }; });
import { createReadOnlyMetadataBudget, readReadOnlyConnectionSourceMetadata as read, ReadOnlyMetadataLimitError } from './read-only-agent-target-witness';
let root: string;
const relative = '.clubhouse/.local/orchestrator-connections.json';
const put = async (name: string, text: string) => { const file = path.join(root, name); await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, text); };
const disk = async (dir = root): Promise<unknown> => Object.fromEntries(await Promise.all((await fsp.readdir(dir)).sort().map(async (name) => { const file = path.join(dir, name), stat = await fsp.lstat(file); return [name, stat.isDirectory() ? { ino: stat.ino, contents: await disk(file) } : stat.isSymbolicLink() ? { link: await fsp.readlink(file), ino: stat.ino } : { bytes: (await fsp.readFile(file)).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; })));
beforeEach(async () => { root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-source-primary-'))); vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readSync).mockClear(); });
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });
it('verifies missing fixed sources without materializing directories, with a receipt invalidated by later creation', async () => {
  const before = await disk(), result = read(root, relative, { budget: createReadOnlyMetadataBudget() });
  expect(result).toMatchObject({ missing: true }); expect(result.raw).toBeUndefined(); expect(result.receipt.current()).toBe(true); expect(await disk()).toEqual(before);
  await put(relative, '{"version":1,"connections":[]}'); expect(result.receipt.current()).toBe(false);
});
it.each(['backup-only', 'corrupt-primary'] as const)('refuses %s with real bytes/inodes/temps unchanged and no backup/recovery adoption', async (mode) => {
  await put(relative + '.bak', '{"version":1,"connections":[]}'); await put('.clubhouse/.local/keep.tmp', 'do not sweep');
  if (mode === 'corrupt-primary') await put(relative, '{broken');
  const before = await disk(); expect(() => read(root, relative, { budget: createReadOnlyMetadataBudget() })).toThrow(); expect(await disk()).toEqual(before);
});
it('binds an admitted primary body without keeping it in the currentness receipt', async () => {
  await put(relative, '{"version":1,"connections":[]}'); const before = await disk(), result = read(root, relative, { budget: createReadOnlyMetadataBudget() });
  expect(result).toMatchObject({ missing: false, raw: { version: 1, connections: [] } }); expect(result.receipt.current()).toBe(true); expect(await disk()).toEqual(before);
  await put(relative, '{"version":1,"connections":[{"agentId":"changed"}]}'); expect(result.receipt.current()).toBe(false);
});
it('rejects descendant symlinks and invalid source names before opening any content', async () => {
  const outside = path.join(root, 'outside'); await fsp.mkdir(path.join(outside, '.local'), { recursive: true }); await fsp.writeFile(path.join(outside, '.local', 'orchestrator-connections.json'), '{"PRIVATE":"must not open"}'); await fsp.symlink(outside, path.join(root, '.clubhouse'), 'dir');
  const before = await disk(); expect(() => read(root, relative, { budget: createReadOnlyMetadataBudget() })).toThrow();
  expect(() => read(root, '../private.json' as never, { budget: createReadOnlyMetadataBudget() })).toThrow(); expect(fs.openSync).not.toHaveBeenCalled(); expect(await disk()).toEqual(before);
});
it('admits file and aggregate byte bounds before reading the body, with distinct deferrable reasons', async () => {
  await put(relative, JSON.stringify({ body: 'x'.repeat(1000) }));
  let fileError: unknown; try { read(root, relative, { budget: createReadOnlyMetadataBudget(), maxBytes: 64 }); } catch (error) { fileError = error; }
  expect(fileError).toBeInstanceOf(ReadOnlyMetadataLimitError); expect(fileError).toMatchObject({ reason: 'file' }); expect(fs.openSync).not.toHaveBeenCalled(); expect(fs.readSync).not.toHaveBeenCalled();
  const budget = createReadOnlyMetadataBudget(); budget.remainingBytes = 64;
  let aggregate: unknown; try { read(root, relative, { budget }); } catch (error) { aggregate = error; }
  expect(aggregate).toMatchObject({ reason: 'aggregate' }); expect(fs.readSync).not.toHaveBeenCalled();
});
