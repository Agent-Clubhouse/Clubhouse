import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { syncBuiltinESMExports } from 'module';
import { ASSET_CATALOG_VERSION } from '../../../shared/asset-catalog-types';
import { CATALOG_DISPLAY_MAX_BYTES, CATALOG_DISPLAY_MAX_HEADS, openCatalogMetadataForDisplay } from './display-metadata';
let root: string;
const entry = (id: string, name = id) => ({ id, kind: 'block', name, source: { kind: 'user' }, owner: { kind: 'library' }, createdAt: '2026-11-19', headRevision: 1, revisions: [{ revision: 1, savedAt: '2026-11-19', contentHash: 'a'.repeat(64), projection: { kind: 'block', bytes: 10 } }] });
const put = (assets: Record<string, unknown>, extra: Record<string, unknown> = {}) => fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ version: ASSET_CATALOG_VERSION, assets, compositions: {}, runs: {}, ...extra }));
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-catalog-metadata-'))); });
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
it('reads only the bounded index and never opens or returns actual large revision payloads or unrelated metadata', async () => {
  put({ first: { ...entry('first'), PRIVATE_EXTRA: 'PRIVATE_ENTRY_METADATA' }, second: entry('second'), unrelated: { PRIVATE_OTHER: 'PRIVATE_OTHER_METADATA' } });
  fs.mkdirSync(path.join(root, 'revisions', 'first'), { recursive: true }); fs.writeFileSync(path.join(root, 'revisions', 'first', '1.json'), JSON.stringify({ payload: { content: 'PRIVATE_REVISION_PAYLOAD'.repeat(250000) } }));
  const opened: string[] = []; const open = fs.promises.open.bind(fs.promises), syncOpen = fs.openSync.bind(fs), readFile = fs.promises.readFile.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => { opened.push(String(args[0])); return open(...args); });
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => { opened.push(String(args[0])); return syncOpen(...args); });
  vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => { opened.push(String(args[0])); return Reflect.apply(readFile, fs.promises, args); }); syncBuiltinESMExports();
  const reader = await openCatalogMetadataForDisplay(root); const first = await reader.head('first'), second = await reader.head('second');
  expect(first).toMatchObject({ id: 'first', name: 'first', revision: 1 }); expect(second).toMatchObject({ id: 'second' }); expect(reader.receipt.current()).toBe(true);
  expect(opened).toHaveLength(2); expect(opened.every((file) => file === path.join(root, 'catalog.json'))).toBe(true);
  expect(JSON.stringify([first, second, reader.receipt])).not.toMatch(/PRIVATE_|payload|content|projection|revisions|source|owner/); expect(reader.payloadsVerified).toBe(false);
});
it('rejects an actual oversized index before reading payload bytes or parsing it', async () => {
  put({ first: entry('first') }, { runs: { unreferenced: 'x'.repeat(CATALOG_DISPLAY_MAX_BYTES) } });
  const open = fs.promises.open.bind(fs.promises); let bytes = 0, fullReadBytes = 0;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle);
    vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => { const result = await Reflect.apply(read, handle, readArgs); bytes += result.bytesRead; return result; }); return handle;
  });
  const full = fs.promises.readFile.bind(fs.promises);
  vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => { const value = await Reflect.apply(full, fs.promises, args); fullReadBytes += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value)); return value; });
  let error: unknown; try { await openCatalogMetadataForDisplay(root); } catch (caught) { error = caught; }
  expect.soft(error).toBeDefined(); expect.soft(bytes).toBe(0); expect.soft(fullReadBytes).toBe(0);
});
it('admits at most100 head requests and keeps returned metadata detached', async () => {
  put({ first: entry('first') }); const reader = await openCatalogMetadataForDisplay(root);
  const initial = await reader.head('first'); initial!.name = 'caller mutation';
  for (let index = 1; index < CATALOG_DISPLAY_MAX_HEADS; index++) expect((await reader.head('first'))?.name).toBe('first');
  await expect(reader.head('first')).rejects.toThrow('part limit'); expect(reader.receipt.current()).toBe(true);
});
it('binds exact selected metadata and verified missing identities while ignoring unrelated changes', async () => {
  put({ first: entry('first') }); const reader = await openCatalogMetadataForDisplay(root); await reader.head('first'); expect(await reader.head('missing')).toBeNull(); expect(reader.receipt.current()).toBe(true);
  put({ first: entry('first'), unrelated: entry('unrelated') }); expect(reader.receipt.current()).toBe(true);
  put({ first: entry('first'), missing: entry('missing') }); expect(reader.receipt.current()).toBe(false);
  const fresh = await openCatalogMetadataForDisplay(root); await fresh.head('first'); put({ first: { ...entry('first'), revisions: [{ ...entry('first').revisions[0], contentHash: 'b'.repeat(64) }] } }); expect(fresh.receipt.current()).toBe(false);
});
it.each(['wrong-id', 'duplicate-head', 'wrong-kind', 'wrong-source', 'wrong-projection'])('refuses selected %s metadata without adopting a fabricated empty part', async (kind) => {
  const value = entry('first'); const bad = kind === 'wrong-id' ? { ...value, id: 'unrelated' } : kind === 'duplicate-head' ? { ...value, revisions: [...value.revisions, ...value.revisions] } : kind === 'wrong-kind' ? { ...value, kind: 'unknown' } : kind === 'wrong-source' ? { ...value, source: null } : { ...value, revisions: [{ ...value.revisions[0], projection: { kind: 'skill' } }] };
  put({ first: bad }); const reader = await openCatalogMetadataForDisplay(root); await expect(reader.head('first')).rejects.toThrow('metadata');
});
