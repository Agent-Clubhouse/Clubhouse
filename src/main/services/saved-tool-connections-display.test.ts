import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const m = vi.hoisted(() => ({ home: '', allowed: true }));
vi.mock('electron', () => ({ app: { getPath: () => m.home } }));
vi.mock('./project-store', () => { throw new Error('Ordinary project owner must not load'); });
vi.mock('./agent-config', () => { throw new Error('Ordinary agent owner must not load'); });
vi.mock('./orchestrator-connections', () => { throw new Error('Operational tool source must not load'); });
import { getBaseDirPath } from './base-dir';
import { readSavedToolConnectionsForDisplay as read } from './saved-tool-connections-display';
let root: string, a: string, b: string;
const file = (p: string) => path.join(p, '.clubhouse', '.local', 'orchestrator-connections.json');
const put = async (p: string, rows: unknown[]) => { await fs.mkdir(path.dirname(file(p)), { recursive: true }); await fs.writeFile(file(p), JSON.stringify({ version: 1, connections: rows })); };
const link = (extra = {}) => ({ ownerId: 'parent', agentId: 'parent', targetId: 'other', targetKind: 'agent', agentProjectPath: a, targetProjectPath: b, createdAt: '2026-11-20T00:00:00Z', ...extra });
const selected = () => ({ agentId: 'parent', projectId: 'a', projectPath: a, receipt: { current: () => m.allowed } });
const query = (options = {}) => read(selected(), { authorized: () => m.allowed, receipts: [], ...options });
const disk = async (folder = root): Promise<unknown> => Object.fromEntries(await Promise.all((await fs.readdir(folder)).sort().map(async (name) => { const p = path.join(folder, name), s = await fs.lstat(p); return [name, s.isDirectory() ? { ino: s.ino, contents: await disk(p) } : { ino: s.ino, mtimeMs: s.mtimeMs, bytes: (await fs.readFile(p)).toString('base64') }]; })));
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-tool-source-'))); m.home = root; m.allowed = true; a = path.join(root, 'a'); b = path.join(root, 'b');
  for (const p of [a, b]) await fs.mkdir(path.join(p, '.clubhouse'), { recursive: true }); await fs.mkdir(getBaseDirPath(), { recursive: true });
  await fs.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'a', name: 'Source custom project', path: a }, { id: 'b', name: 'Target custom project', path: b }] }));
  await fs.writeFile(path.join(a, '.clubhouse', 'agents.json'), JSON.stringify([{ id: 'parent', name: 'Selected' }])); await fs.writeFile(path.join(b, '.clubhouse', 'agents.json'), JSON.stringify([{ id: 'other', name: 'Qualified other', env: { key: 'PRIVATE_ENDPOINT_ENV' } }]));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('projects only selected exact-project saved relationships and safely qualified endpoint fields, without owner initialization/writes', async () => {
  await put(b, [link({ rawArgs: 'PRIVATE_ARGS', instructions: 'PRIVATE_INSTRUCTIONS', env: { key: 'PRIVATE_ENV' } }), link({ agentProjectPath: b, targetId: 'PRIVATE_OTHER_PROJECT_TARGET' }), link({ agentId: 'PRIVATE_UNRELATED', targetId: 'PRIVATE_UNRELATED_TARGET' })]);
  const before = await disk(), receipts: Array<{ current(): boolean }> = [], result = query({ receipts });
  expect(result).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 1, next: null, rows: [{ sourceProjectId: 'b', sourceProjectName: { value: 'Target custom project' }, direction: 'outgoing', declaredScope: 'helper-family', endpoint: { state: 'ok', value: { record: 'registered-primary', fields: { name: { value: 'Qualified other' } } } } }] } });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|ProjectPath|projectPath|ownerId|rawArgs|instructions|"env"/); expect(JSON.stringify(result)).not.toContain(root); expect(receipts.every((r) => r.current())).toBe(true); expect(await disk()).toEqual(before);
});
it('continues the final selected record instead of permanently clipping after eight matches', async () => {
  await put(a, Array.from({ length: 9 }, (_, i) => link({ targetId: 'other-' + i })));
  const first = query(); expect(first).toMatchObject({ state: 'ok', value: { knownMatches: 9, next: { projectOffset: 0, offset: 8 } } });
  expect(query({ offset: 8 })).toMatchObject({ state: 'ok', value: { knownMatches: 9, rows: [{ targetId: 'other-8' }], next: null } });
});
it('keeps incoming agents, outgoing group targets and declared unknown scope distinct from widget ID collisions', async () => {
  await put(a, [link({ agentId: 'other', targetId: 'parent', agentProjectPath: b, targetProjectPath: a, scope: 'granted' }), link({ agentId: 'PRIVATE_WIDGET_OWNER', targetId: 'parent', targetKind: 'browser' }), link({ targetId: 'group', targetKind: 'group-project', scope: 'future' })]);
  const result = query(); expect(result).toMatchObject({ state: 'ok', value: { knownMatches: 2, rows: [{ direction: 'incoming', declaredScope: 'granted' }, { direction: 'outgoing', targetKind: 'group-project', declaredScope: 'unknown' }] } }); expect(JSON.stringify(result)).not.toContain('PRIVATE_WIDGET');
});
it('preserves verified missing versus corrupt/backup-only and never sweeps source temps', async () => {
  const empty = query(); expect(empty).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 0, rows: [] } });
  await put(b, []); await fs.rename(file(b), file(b) + '.bak'); await fs.writeFile(path.join(path.dirname(file(b)), 'keep.tmp'), 'keep');
  const before = await disk(); expect(query()).toMatchObject({ state: 'ok', value: { complete: false, unavailableProjects: 1, knownMatches: 0 } }); expect(await disk()).toEqual(before);
});
it('keeps private selected source/primary receipts current through caller assembly and invalidates real later edits', async () => {
  await put(a, [link()]); const receipts: Array<{ current(): boolean }> = [], result = query({ receipts }); expect(result.state).toBe('ok'); expect(receipts.every((r) => r.current())).toBe(true);
  await fs.writeFile(path.join(b, '.clubhouse', 'agents.json'), '[]'); expect(receipts.some((r) => !r.current())).toBe(true);
  const sourceReceipts: Array<{ current(): boolean }> = []; expect(query({ receipts: sourceReceipts }).state).toBe('ok'); expect(sourceReceipts.every((r) => r.current())).toBe(true);
  await put(a, []); expect(sourceReceipts.some((r) => !r.current())).toBe(true);
});
it('does not open a source for a revoked or retargeted selected project and reports malformed candidate records as unknown', async () => {
  await put(a, [link({ agentProjectPath: {} }), link({ ownerId: {} }), link({ targetId: 'good', createdAt: 'PRIVATE_BAD_DATE' })]);
  const result = query(); expect(result).toMatchObject({ state: 'ok', value: { complete: false, unknownRows: 2, knownMatches: 1, rows: [{ targetId: 'good' }] } }); expect(JSON.stringify(result)).not.toContain('PRIVATE_BAD_DATE');
  m.allowed = false; expect(query()).toMatchObject({ state: 'unavailable', reason: 'changed' });
  m.allowed = true; expect(read({ ...selected(), projectPath: b }, { authorized: () => true, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'changed' });
});
