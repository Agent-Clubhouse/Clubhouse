import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { readSelectedCanvasMembershipPage } from './selected-canvas-membership-page';
import { fitSelectedCanvasBoardPage, readSelectedCanvasBoardPage } from './selected-canvas-board-page';
import { captureReadOnlyAgentTargetWitness } from './read-only-agent-target-witness';
import { isRemoteCanvasBoardPage, type RemoteCanvasBoardQuery } from '../../shared/remote-canvas-board-page';
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), readFileSync: vi.fn(actual.readFileSync) };
});
const m = vi.hoisted(() => ({ profile: '', role: false }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.profile }));
vi.mock('./dispatcher/dispatcher-service', () => ({ isDispatcherIdentityAgentId: () => m.role }));
let root: string, home: string, project: string, appFile: string, projectFile: string, allowed: boolean;
const config = { id: 'a1', name: 'Selected', color: 'blue', createdAt: '2026-01-01' } as const;
const target = () => ({ agent: config, project: { id: 'p1', name: 'Selected project', path: project } });
const geo = (i: number) => ({ position: { x: i * 10, y: i * 5 }, size: { width: 100, height: 60 }, zIndex: i });
const board = (id: string, extra: unknown[] = []) => ({ id, name: `Board ${id}`, views: [
  { id: `view-${id}`, type: 'agent', agentId: 'a1', projectId: 'p1', title: 'PRIVATE_MEMBER_TITLE', displayName: 'PRIVATE_MEMBER_DISPLAY', ...geo(0) },
  { id: `other-${id}`, type: 'agent', agentId: 'PRIVATE_OTHER_AGENT', projectId: 'p1', title: 'PRIVATE_OTHER_TITLE', displayName: 'PRIVATE_OTHER_NAME', ...geo(1) },
  { id: `note-${id}`, type: 'sticky-note', content: 'PRIVATE_NOTE_CONTENT', color: 'pink', displayName: 'Plan', metadata: { secret: 'PRIVATE_META' }, ...geo(2) },
  { id: `plugin-${id}`, type: 'plugin', pluginId: 'PRIVATE_PLUGIN_ID', pluginWidgetType: 'plugin:PRIVATE_PLUGIN_ID:w', displayName: 'Widget', ...geo(3) },
  { id: `zone-${id}`, type: 'zone', themeId: 'PRIVATE_THEME', containedViewIds: ['x'], displayName: 'Zone A', ...geo(4) },
  { id: `anchor-${id}`, type: 'anchor', label: 'Start here', displayName: 'Start here', ...geo(5) },
  ...extra] });
const options = () => ({ authorized: () => allowed, target: captureReadOnlyAgentTargetWitness(target()), receipts: [] as Array<{ current(): boolean }> });
async function membership() {
  const page = await readSelectedCanvasMembershipPage(target(), { card: 'canvases', source: 'selected-canvas-memberships' }, options());
  if (page.state !== 'recorded') throw new Error('Expected membership');
  return page;
}
const read = (q: RemoteCanvasBoardQuery, opts = options()) => readSelectedCanvasBoardPage(target(), q, opts);
beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-board-page-'));
  home = path.join(root, 'home'); project = path.join(root, 'selected'); m.profile = path.join(root, 'profile'); m.role = false; allowed = true;
  appFile = path.join(home, '.clubhouse/plugin-data/canvas/kv/canvas-instances.json');
  projectFile = path.join(project, '.clubhouse/plugin-data-local/canvas/kv/canvas-instances.json');
  await fsp.mkdir(path.dirname(appFile), { recursive: true }); await fsp.mkdir(path.dirname(projectFile), { recursive: true }); await fsp.mkdir(m.profile);
  await fsp.writeFile(path.join(m.profile, 'projects.json'), JSON.stringify({ version: 1, projects: [target().project] }));
  await fsp.writeFile(path.join(project, '.clubhouse/agents.json'), JSON.stringify([config]));
  await fsp.writeFile(appFile, JSON.stringify([board('home')])); await fsp.writeFile(projectFile, JSON.stringify([board('project'), board('other-board')]));
  vi.spyOn(app, 'getPath').mockImplementation((name) => name === 'home' ? home : m.profile);
});
afterEach(async () => { vi.restoreAllMocks(); await fsp.rm(root, { recursive: true, force: true }); });

it('projects only the member row’s board: member keyed by the row, other agents generic, no content, ids or other boards', async () => {
  const rows = await membership(), row = rows.rows.find((r) => r.canvasId === 'project')!;
  const page = await read({ card: 'canvases', source: 'selected-canvas-board', member: row.key, selection: rows.selection });
  expect(isRemoteCanvasBoardPage(page, { agentId: 'a1', projectId: 'p1', member: row.key, selection: rows.selection, scope: 'project', canvasId: 'project', viewId: 'view-project' })).toBe(true);
  if (page.state !== 'recorded') throw new Error('Expected board');
  expect(page).toMatchObject({ scope: 'project', canvasId: 'project', viewId: 'view-project', name: 'Board project', total: 6 });
  const member = page.views.filter((v) => v.member);
  expect(member).toEqual([expect.objectContaining({ key: row.key, type: 'agent', label: 'Selected', x: 0, y: 0, w: 100, h: 60, z: 0 })]);
  expect(page.views.map((v) => [v.type, v.label])).toEqual([['agent', 'Selected'], ['agent', 'Agent'], ['sticky-note', 'Plan'], ['plugin', 'Widget'], ['zone', 'Zone A'], ['anchor', 'Start here']]);
  // Non-member keys are opaque and never carry raw agent or view ids.
  expect(page.views.filter((v) => !v.member).every((v) => /^[a-f0-9]{64}$/.test(v.key) && v.key !== row.key)).toBe(true);
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|other-project|note-project|other-board|Board home/);
});

it.each([
  ['a stale selection', (s: string, k: string) => ({ member: k, selection: s.replace(/^./, s[0] === 'a' ? 'b' : 'a') })],
  ['an unknown member', (s: string) => ({ member: 'f'.repeat(64), selection: s })],
] as const)('is changed, not served, for %s', async (_label, make) => {
  const rows = await membership();
  const page = await read({ card: 'canvases', source: 'selected-canvas-board', ...make(rows.selection, rows.rows[0].key) });
  expect(page).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect(page).not.toHaveProperty('views');
});

it('is changed when the source is replaced between the membership read and the board read', async () => {
  const rows = await membership(), row = rows.rows.find((r) => r.canvasId === 'project')!;
  await fsp.writeFile(projectFile, JSON.stringify([board('project'), board('added-later')]));
  expect(await read({ card: 'canvases', source: 'selected-canvas-board', member: row.key, selection: rows.selection })).toMatchObject({ state: 'unavailable', reason: 'changed' });
});

it('refuses a board over 500 views as limit, without any partial layout', async () => {
  const many = Array.from({ length: 495 }, (_, i) => ({ id: `extra-${i}`, type: 'anchor', label: `A${i}`, ...geo(i) }));
  await fsp.writeFile(projectFile, JSON.stringify([board('project', many)]));
  const rows = await membership(), row = rows.rows.find((r) => r.canvasId === 'project')!;
  expect(await read({ card: 'canvases', source: 'selected-canvas-board', member: row.key, selection: rows.selection })).toMatchObject({ state: 'unavailable', reason: 'limit' });
});

it('never opens backup contents: a corrupt primary with a backup present is unavailable', async () => {
  const backup = path.join(path.dirname(projectFile), 'canvas-instances-backup.json');
  await fsp.writeFile(backup, JSON.stringify([board('project')])); await fsp.writeFile(projectFile, '{ not json');
  vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readFileSync).mockClear();
  const page = await read({ card: 'canvases', source: 'selected-canvas-board', member: 'a'.repeat(64), selection: 'b'.repeat(64) });
  expect(page.state).toBe('unavailable');
  const touched = [...vi.mocked(fs.openSync).mock.calls, ...vi.mocked(fs.readFileSync).mock.calls].map(([file]) => String(file));
  expect(touched.some((file) => file.includes('backup'))).toBe(false);
});

it('treats a missing primary with a recovery key as unreadable, not empty', async () => {
  await fsp.rm(projectFile); await fsp.writeFile(path.join(path.dirname(projectFile), 'canvas-instances-backup.json.bak'), '[]');
  expect(await read({ card: 'canvases', source: 'selected-canvas-board', member: 'a'.repeat(64), selection: 'b'.repeat(64) })).toMatchObject({ state: 'unavailable', reason: 'unreadable' });
});

it('is unsupported for the Dispatcher identity and changed after revocation', async () => {
  m.role = true;
  expect(await read({ card: 'canvases', source: 'selected-canvas-board', member: 'a'.repeat(64), selection: 'b'.repeat(64) })).toMatchObject({ state: 'unavailable', reason: 'unsupported' });
  m.role = false; allowed = false;
  expect(await read({ card: 'canvases', source: 'selected-canvas-board', member: 'a'.repeat(64), selection: 'b'.repeat(64) })).toMatchObject({ state: 'unavailable', reason: 'changed' });
});

it('refuses a malformed query before any read', async () => {
  const opts = options(); vi.mocked(fs.openSync).mockClear();
  await expect(read({ card: 'canvases', source: 'selected-canvas-board', member: 'a'.repeat(64), selection: 'b'.repeat(64), offset: 0 } as never, opts)).rejects.toThrow('Invalid selected board query.');
  expect(fs.openSync).not.toHaveBeenCalled();
});

it('premeasures: a page larger than the remaining budget becomes limit, keeping only identity fields', async () => {
  const rows = await membership(), row = rows.rows.find((r) => r.canvasId === 'project')!;
  const page = await read({ card: 'canvases', source: 'selected-canvas-board', member: row.key, selection: rows.selection });
  const size = Buffer.byteLength(JSON.stringify(page));
  expect(fitSelectedCanvasBoardPage(page, size)).toBe(page);
  const fitted = fitSelectedCanvasBoardPage(page, size - 1);
  expect(fitted).toMatchObject({ state: 'unavailable', reason: 'limit', member: row.key, selection: rows.selection }); expect(fitted).not.toHaveProperty('views');
  expect(isRemoteCanvasBoardPage(fitted)).toBe(true);
});
