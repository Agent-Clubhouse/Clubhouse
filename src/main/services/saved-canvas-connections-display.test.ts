import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const m = vi.hoisted(() => ({ home: '', allowed: true }));
vi.mock('electron', () => ({ app: { getPath: () => m.home } }));
vi.mock('./project-store', () => { throw new Error('Ordinary project owner must not load'); });
vi.mock('./agent-config', () => { throw new Error('Ordinary agent owner must not load'); });
vi.mock('./canvas-store-reader', () => { throw new Error('Unbounded Canvas owner must not load'); });
vi.mock('./canvas-wire-source', () => { throw new Error('Operational Canvas collection must not load'); });
import { getBaseDirPath } from './base-dir';
import { readSavedCanvasConnectionsForDisplay as read } from './saved-canvas-connections-display';
import { expandZoneWires } from '../../renderer/plugins/builtin/canvas/zone-wire-expansion';
import type { CanvasView } from '../../renderer/plugins/builtin/canvas/canvas-types';
import type { ZoneWireDefinition } from '../../renderer/plugins/builtin/canvas/zone-wire-store';
let root: string, a: string, b: string;
const file = (folder: string, name: string) => path.join(folder, '.clubhouse', folder === root ? 'plugin-data' : 'plugin-data-local', 'canvas', 'kv', name + '.json');
const put = async (folder: string, name: string, data: unknown) => { await fs.mkdir(path.dirname(file(folder, name)), { recursive: true }); await fs.writeFile(file(folder, name), JSON.stringify(data)); };
const av = (id: string, projectId = 'a', extra = {}) => ({ id: 'view-' + id, type: 'agent', agentId: id, projectId, displayName: 'Saved ' + id, ...extra });
const wire = (targetId = 'other', extra = {}) => ({ agentId: 'selected', targetId, targetKind: 'agent', label: 'Saved target ' + targetId, ...extra });
const selected = () => ({ agentId: 'selected', projectId: 'a', projectPath: a, receipt: { current: () => m.allowed } });
const query = (source: 'canvas' | 'zone' = 'canvas', options = {}) => read(selected(), source, { authorized: () => m.allowed, receipts: [], ...options });
const disk = async (folder = root): Promise<unknown> => Object.fromEntries(await Promise.all((await fs.readdir(folder)).sort().map(async (name) => { const p = path.join(folder, name), s = await fs.lstat(p); return [name, s.isDirectory() ? { ino: s.ino, contents: await disk(p) } : { ino: s.ino, mtimeMs: s.mtimeMs, bytes: (await fs.readFile(p)).toString('base64') }]; })));
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-saved-canvas-'))); m.home = root; m.allowed = true; a = path.join(root, 'a'); b = path.join(root, 'b');
  for (const p of [a, b]) await fs.mkdir(path.join(p, '.clubhouse'), { recursive: true }); await fs.mkdir(getBaseDirPath(), { recursive: true });
  await fs.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'a', name: 'Source custom project', path: a }, { id: 'b', name: 'Target custom project', path: b }] }));
  await fs.writeFile(path.join(a, '.clubhouse', 'agents.json'), JSON.stringify([{ id: 'selected', name: 'Selected' }])); await fs.writeFile(path.join(b, '.clubhouse', 'agents.json'), JSON.stringify([{ id: 'other', name: 'Qualified other', env: { key: 'PRIVATE_ENDPOINT_ENV' } }]));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('reads selected Home wires and qualified endpoint fields without unrelated metadata, owner loads or disk effects', async () => {
  await put(root, 'canvas-instances', [{ id: 'home', views: [av('selected'), av('other', 'b'), av('unrelated', 'b', { displayName: 'PRIVATE_UNRELATED_NAME', metadata: { prompt: 'PRIVATE_PROMPT' } })] }]);
  await put(root, 'canvas-wires', [wire('other', { instructions: { '*': 'PRIVATE_INSTRUCTIONS' }, disabledTools: ['send_message', 'PRIVATE_UNKNOWN_TOOL'] }), wire('unrelated', { agentId: 'other', label: 'PRIVATE_UNRELATED_WIRE' })]);
  const before = await disk(), receipts: Array<{ current(): boolean }> = [], result = query('canvas', { receipts });
  expect(result).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 1, next: null, rows: [{ sourceScope: 'app', sourceName: { value: 'Home' }, direction: 'outgoing', savedLabel: 'Saved target other', disabledTools: ['send_message'], unrecognizedTools: 1, endpoint: { state: 'ok', value: { record: 'registered-primary', fields: { name: { value: 'Qualified other' } } } } }] } });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|projectPath|ProjectPath|instructions|"metadata"|"env"/); expect(JSON.stringify(result)).not.toContain(root); expect(receipts.every((r) => r.current())).toBe(true); expect(await disk()).toEqual(before);
});
it.each(['other-project', 'ambiguous', 'home-unqualified'] as const)('does not infer selected identity from a reused native ID alone: %s', async (mode) => {
  const v = mode === 'ambiguous' ? [av('selected'), av('selected', 'b', { id: 'second-selected' }), av('other', 'b')] : [av('selected', mode === 'other-project' ? 'b' : 'a', { ...(mode === 'home-unqualified' && { projectId: undefined }) }), av('other', 'b')];
  await put(root, 'canvas-instances', [{ id: 'home', views: v }]); await put(root, 'canvas-wires', [wire('other', { label: 'PRIVATE_WRONG_ASSOCIATION' })]);
  expect(query()).toMatchObject({ state: 'ok', value: { complete: mode === 'other-project', knownMatches: 0, rows: [], unknownRows: mode === 'other-project' ? 0 : 1 } }); expect(JSON.stringify(query())).not.toContain('PRIVATE_');
});
it('keeps incoming agents, outgoing widget kinds and saved project context independent of widget-ID collisions', async () => {
  await put(a, 'canvas-instances', [{ id: 'project', views: [av('selected', 'a', { projectId: undefined }), av('other', 'b'), { id: 'selected', type: 'plugin', pluginWidgetType: 'plugin:browser:webview' }, { id: 'browser', type: 'plugin', pluginWidgetType: 'plugin:browser:webview' }, { id: 'group-view', type: 'plugin', metadata: { groupProjectId: 'group' } }] }]);
  await put(a, 'canvas-wires', [wire('selected', { agentId: 'other' }), wire('selected', { agentId: 'other', targetKind: 'browser', label: 'PRIVATE_WIDGET_COLLISION' }), wire('browser', { targetKind: 'browser' }), wire('group', { targetKind: 'group-project' })]);
  const result = query(); expect(result).toMatchObject({ state: 'ok', value: { knownMatches: 3, rows: [{ direction: 'incoming', sourceProjectId: 'a', endpoint: { state: 'ok' } }, { targetKind: 'browser' }, { targetKind: 'group-project' }] } }); expect(JSON.stringify(result)).not.toContain('PRIVATE_WIDGET');
});
it('continues later saved relationships without clipping the ninth record', async () => {
  await put(a, 'canvas-instances', [{ id: 'project', views: [av('selected'), ...Array.from({ length: 9 }, (_, i) => av('other-' + i, 'b'))] }]); await put(a, 'canvas-wires', Array.from({ length: 9 }, (_, i) => wire('other-' + i)));
  expect(query()).toMatchObject({ state: 'ok', value: { knownMatches: 9, next: { projectOffset: 0, offset: 8 } } }); expect(query('canvas', { offset: 8 })).toMatchObject({ state: 'ok', value: { rows: [{ targetId: 'other-8' }], next: null } });
});
it('continues beyond the first sixteen stores with fresh registered-root admission', async () => {
  const projects = [{ id: 'a', name: 'Selected', path: a }];
  for (let i = 0; i < 17; i++) { const folder = path.join(root, 'p' + i); await fs.mkdir(path.join(folder, '.clubhouse'), { recursive: true }); projects.push({ id: 'p' + i, name: 'Project ' + i, path: folder }); }
  await fs.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects })); const last = projects[projects.length - 1];
  await put(last.path, 'canvas-instances', [{ id: 'last', views: [av('selected'), av('other', 'a')] }]); await put(last.path, 'canvas-wires', [wire()]);
  expect(query()).toMatchObject({ state: 'ok', value: { knownMatches: 0, next: { projectOffset: 16, offset: 0 } } }); expect(query('canvas', { projectOffset: 16 })).toMatchObject({ state: 'ok', value: { knownMatches: 1, rows: [{ sourceProjectId: 'p16' }], next: null } });
});
it('distinguishes verified missing, recovery-only, corrupt and unsupported graph data without sweeping temps', async () => {
  expect(query()).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 0 } });
  await put(a, 'canvas-instances-backup', [{ id: 'recover', views: [] }]); await fs.writeFile(path.join(path.dirname(file(a, 'canvas-instances-backup')), 'keep.tmp'), 'keep'); await put(b, 'canvas-instances', []);
  const before = await disk(); expect(query()).toMatchObject({ state: 'ok', value: { complete: false, unavailableStores: 2, knownMatches: 0 } }); expect(await disk()).toEqual(before);
});
it('retains source, endpoint and registry evidence after helper return and rejects revoked or retargeted selections', async () => {
  await put(a, 'canvas-instances', [{ id: 'project', views: [av('selected'), av('other', 'b')] }]); await put(a, 'canvas-wires', [wire()]);
  const receipts: Array<{ current(): boolean }> = []; expect(query('canvas', { receipts }).state).toBe('ok'); expect(receipts.every((r) => r.current())).toBe(true); await fs.writeFile(path.join(b, '.clubhouse', 'agents.json'), '[]'); expect(receipts.some((r) => !r.current())).toBe(true);
  const source: Array<{ current(): boolean }> = []; expect(query('canvas', { receipts: source }).state).toBe('ok'); expect(source.every((r) => r.current())).toBe(true); await put(a, 'canvas-wires', []); expect(source.some((r) => !r.current())).toBe(true);
  m.allowed = false; expect(query()).toMatchObject({ state: 'unavailable', reason: 'changed' }); m.allowed = true; expect(read({ ...selected(), projectPath: b }, 'canvas', { authorized: () => true, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'changed' });
});
it.each(['agent', 'zone', 'group-project', 'browser'] as const)('matches the local selected zone expansion for saved target type %s, without unrelated cross products', async (targetType) => {
  const sourceZone = { id: 'z1', type: 'zone', containedViewIds: ['view-selected', 'view-first', 'browser-source'] }, targetZone = { id: 'z2', type: 'zone', containedViewIds: ['view-other', 'browser-target', 'group-view'] };
  const views = [av('selected'), av('first', 'b'), av('other', 'b'), sourceZone, targetZone, { id: 'browser-source', type: 'plugin', pluginWidgetType: 'plugin:browser:webview', displayName: 'Source browser' }, { id: 'browser-target', type: 'plugin', pluginWidgetType: 'plugin:browser:webview', displayName: 'Target browser' }, { id: 'group-view', type: 'plugin', pluginWidgetType: 'plugin:group-project:group-project', metadata: { groupProjectId: 'group' }, displayName: 'Group' }];
  const wires = [{ id: 'zone-wire', sourceZoneId: 'z1', targetId: targetType === 'agent' ? 'other' : targetType === 'zone' ? 'z2' : targetType === 'group-project' ? 'group' : 'browser-target', targetType }];
  await put(a, 'canvas-instances', [{ id: 'project', views }]); await put(a, 'canvas-zone-wires', wires);
  const before = await disk(), result = query('zone'); expect(result.state).toBe('ok'); if (result.state !== 'ok') throw new Error('fixture');
  const expected = expandZoneWires(wires as ZoneWireDefinition[], views as unknown as CanvasView[]).filter((p) => p.agentId === 'selected' || p.targetKind === 'agent' && p.targetId === 'selected').map(({ agentId, targetId, targetKind }) => ({ agentId, targetId, targetKind }));
  expect(result.value.complete).toBe(true); expect(result.value.rows.map(({ agentId, targetId, targetKind }) => ({ agentId, targetId, targetKind }))).toEqual(expected); expect(await disk()).toEqual(before);
});
it('uses the saved active zone canvas and withholds missing/invalid active identity instead of combining tabs', async () => {
  await put(a, 'canvas-instances', [{ id: 'first', views: [av('selected'), { id: 'z', type: 'zone', containedViewIds: [] }] }, { id: 'second', views: [av('selected', 'a', { id: 'selected-second' }), av('other', 'b'), { id: 'z-second', type: 'zone', containedViewIds: ['selected-second'] }] }]);
  await put(a, 'canvas-zone-wires', [{ id: 'w', sourceZoneId: 'z-second', targetId: 'other', targetType: 'agent' }]); await put(a, 'canvas-active-id', 'second'); expect(query('zone')).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 1 } });
  await put(a, 'canvas-active-id', 'missing'); expect(query('zone')).toMatchObject({ state: 'ok', value: { complete: false, unavailableStores: 1, rows: [] } });
});
it('reports bounded zone expansion exhaustion as partial, never verified empty or a complete global inventory', async () => {
  const others = Array.from({ length: 100 }, (_, i) => av('other-' + i, 'b'));
  await put(a, 'canvas-instances', [{ id: 'project', views: [av('selected'), ...others, { id: 'z', type: 'zone', containedViewIds: others.map((v) => v.id) }] }]); await put(a, 'canvas-zone-wires', Array.from({ length: 1000 }, (_, i) => ({ id: 'w' + i, sourceZoneId: 'z', targetId: 'selected', targetType: 'agent' })));
  expect(query('zone')).toMatchObject({ state: 'ok', value: { complete: false, knownMatches: 100, unknownRows: 1, next: { projectOffset: 0, offset: 8 } } });
});
