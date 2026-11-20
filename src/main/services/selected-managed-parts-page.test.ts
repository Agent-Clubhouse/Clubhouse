import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentConfigTarget } from './agent-config-reader';
import { ASSET_CATALOG_VERSION } from '../../shared/asset-catalog-types';
import { GRANT_GATED_SKILL_IDS } from '../../shared/managed-agents-types';
import { isRemoteInventoryPage, type RemoteInventoryQuery } from '../../shared/remote-inventory-page';
import { CATALOG_DISPLAY_MAX_BYTES, openCatalogMetadataForDisplay } from './asset-catalog/display-metadata';
const m = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ openSetupMetadataForDisplay: m.open }) }));
import { readSelectedManagedPartsPage } from './selected-managed-parts-page';
let root: string;
const entry = (id: string, kind = 'skill') => ({ id, kind, name: `Safe ${id}`, source: { kind: 'user' }, headRevision: 1,
  revisions: [{ revision: 1, contentHash: 'a'.repeat(64), projection: { kind, ...(kind === 'skill' && { skillName: id }) } }] });
const put = (assets: Record<string, unknown>, extra = {}) => fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ version: ASSET_CATALOG_VERSION, assets, ...extra }));
const target = (skills: string[]): AgentConfigTarget => ({ agent: { id: 'selected', name: 'Selected', color: '', createdAt: '', managed: { version: 1, blocks: [], skills, mcps: [] } }, project: { id: 'project', name: 'Project', path: root } });
const query = (offset = 0, selection?: string): RemoteInventoryQuery => ({ card: 'skills-mcp', source: 'selected-managed-skills', offset, ...(selection && { selection }) });
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-selected-parts-'))); m.open.mockImplementation(() => openCatalogMetadataForDisplay(root)); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it('reaches the final selected row beyond100 with <=25 metadata heads per page, unchanged real catalog and no payload reads', async () => {
  const ids = Array.from({ length: 126 }, (_, i) => `part-${i}`); put(Object.fromEntries(ids.map((id) => [id, entry(id)])), { PRIVATE_UNRELATED: 'PRIVATE_OTHER' });
  fs.mkdirSync(path.join(root, 'revisions')); fs.writeFileSync(path.join(root, 'revisions', 'PRIVATE_PAYLOAD'), 'PRIVATE_INSTRUCTIONS');
  const before = fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'), stat = fs.statSync(path.join(root, 'catalog.json'));
  const heads: string[][] = []; m.open.mockImplementation(async () => { const reader = await openCatalogMetadataForDisplay(root), calls: string[] = []; heads.push(calls); return { ...reader, head: async (id: string) => { calls.push(id); return reader.head(id); } }; });
  const t = target(ids), seen: string[] = []; let offset = 0, selection: string | undefined;
  for (;;) {
    const page = await readSelectedManagedPartsPage(t, query(offset, selection), { authorized: () => true, target: { current: () => true }, receipts: [] });
    expect(isRemoteInventoryPage(page)).toBe(true); if (page.state !== 'recorded') throw new Error('Expected recorded metadata');
    selection ??= page.selection; expect(page.selection).toBe(selection); seen.push(...page.rows.map((r) => r.name ?? 'missing'));
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|assetId|payload|instructions/);
    if (page.next === null) break; offset = page.next;
  }
  expect(seen).toEqual(ids.map((id) => `Safe ${id}`)); expect(heads.every((page) => page.length <= 25)).toBe(true); expect(heads.flat()).toEqual(ids);
  expect(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8')).toBe(before); expect(fs.statSync(path.join(root, 'catalog.json')).mtimeMs).toBe(stat.mtimeMs);
});
it('withholds grant-gated saved skill choices, preserves missing heads, and never resolves grants or payloads', async () => {
  put({ visible: entry('visible'), [GRANT_GATED_SKILL_IDS[0]]: entry(GRANT_GATED_SKILL_IDS[0]) });
  const page = await readSelectedManagedPartsPage(target(['visible', GRANT_GATED_SKILL_IDS[0], 'missing']), query(), { authorized: () => true, target: { current: () => true }, receipts: [] });
  expect(page).toMatchObject({ state: 'recorded', total: 2, rows: [{ name: 'Safe visible' }, { name: null, state: 'missing' }] });
  expect(JSON.stringify(page)).not.toContain(GRANT_GATED_SKILL_IDS[0]);
});
it.each(['revoked', 'target', 'catalog'] as const)('withholds selected metadata after a late %s change', async (mode) => {
  put({ chosen: entry('chosen') }); let allowed = true, current = true;
  m.open.mockImplementation(async () => { const reader = await openCatalogMetadataForDisplay(root); return { ...reader, head: async (id: string) => { const value = await reader.head(id); if (mode === 'revoked') allowed = false; if (mode === 'target') current = false; if (mode === 'catalog') put({ chosen: { ...entry('chosen'), name: 'Changed' } }); return value; } }; });
  const page = await readSelectedManagedPartsPage(target(['chosen']), query(), { authorized: () => allowed, target: { current: () => current }, receipts: [] });
  expect(page).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect(page).not.toHaveProperty('rows');
});
it('refuses stale ordered selection and oversized sources before metadata reads', async () => {
  put({ chosen: entry('chosen') }); const t = target(['chosen']);
  expect(await readSelectedManagedPartsPage(t, query(25, 'a'.repeat(64)), { authorized: () => true, target: { current: () => true }, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'changed' });
  expect(await readSelectedManagedPartsPage(target(Array(4097).fill('chosen')), query(), { authorized: () => true, target: { current: () => true }, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'limit' });
  expect(m.open).not.toHaveBeenCalled();
});
it('keeps the existing4MiB catalog bound unavailable without recovery or claiming empty metadata', async () => {
  put({ chosen: entry('chosen') }, { padding: 'x'.repeat(CATALOG_DISPLAY_MAX_BYTES) }); const before = fs.readFileSync(path.join(root, 'catalog.json'));
  expect(await readSelectedManagedPartsPage(target(['chosen']), query(), { authorized: () => true, target: { current: () => true }, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'unreadable' });
  expect(fs.readFileSync(path.join(root, 'catalog.json'))).toEqual(before); expect(fs.readdirSync(root)).toEqual(['catalog.json']);
});
