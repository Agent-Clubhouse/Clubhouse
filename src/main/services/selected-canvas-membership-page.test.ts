import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { readSelectedCanvasMembershipPage } from './selected-canvas-membership-page';
import { captureReadOnlyAgentTargetWitness } from './read-only-agent-target-witness';
import { isRemoteCanvasMembershipPage, type RemoteCanvasMembershipQuery } from '../../shared/remote-canvas-membership-page';
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
const m = vi.hoisted(() => ({ profile: '', role: false }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.profile }));
vi.mock('./dispatcher/dispatcher-service', () => ({ isDispatcherIdentityAgentId: () => m.role }));
let root: string, home: string, project: string, appFile: string, projectFile: string, allowed: boolean;
const config = { id: 'a1', name: 'Selected', color: 'blue', createdAt: '2026-01-01' } as const;
const target = () => ({ agent: config, project: { id: 'p1', name: 'Selected project', path: project } });
const query: RemoteCanvasMembershipQuery = { card: 'canvases', source: 'selected-canvas-memberships' };
const board = (id: string, projectId: string | null = 'p1') => ({ id, name: `Board ${id}`, views: [{ id: `view-${id}`, type: 'agent', agentId: 'a1', ...(projectId && { projectId }) }, { id: `note-${id}`, type: 'sticky-note', content: 'PRIVATE_BOARD_PAYLOAD' }] });
const options = () => ({ authorized: () => allowed, target: captureReadOnlyAgentTargetWitness(target()), receipts: [] as Array<{ current(): boolean }> });
const read = (q = query, opts = options()) => readSelectedCanvasMembershipPage(target(), q, opts);
beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-membership-page-'));
  home = path.join(root, 'home'); project = path.join(root, 'selected'); m.profile = path.join(root, 'profile'); m.role = false; allowed = true;
  appFile = path.join(home, '.clubhouse/plugin-data/canvas/kv/canvas-instances.json');
  projectFile = path.join(project, '.clubhouse/plugin-data-local/canvas/kv/canvas-instances.json');
  await fsp.mkdir(path.dirname(appFile), { recursive: true }); await fsp.mkdir(path.dirname(projectFile), { recursive: true }); await fsp.mkdir(m.profile);
  await fsp.writeFile(path.join(m.profile, 'projects.json'), JSON.stringify({ version: 1, projects: [target().project, { id: 'other', path: path.join(root, 'OTHER_PROJECT_NEVER_READ') }] }));
  await fsp.writeFile(path.join(project, '.clubhouse/agents.json'), JSON.stringify([config]));
  await fsp.writeFile(appFile, JSON.stringify([board('home')])); await fsp.writeFile(projectFile, JSON.stringify([board('project', null)]));
  vi.spyOn(app, 'getPath').mockImplementation((name) => name === 'home' ? home : m.profile);
});
afterEach(async () => { vi.restoreAllMocks(); await fsp.rm(root, { recursive: true, force: true }); });
it('reaches every selected row beyond100 with stable keys, real source receipts and no board/foreign payload', async () => {
  await fsp.writeFile(appFile, JSON.stringify([board('home-0'), board('home-1'), { ...board('foreign', 'other'), name: 'FOREIGN_BOARD_NAME' }]));
  await fsp.writeFile(projectFile, JSON.stringify(Array.from({ length: 103 }, (_, i) => board(`p${String(i).padStart(3, '0')}`, null))));
  const before = await Promise.all([appFile, projectFile].map((file) => fsp.readFile(file)));
  const first = await read();
  expect(isRemoteCanvasMembershipPage(first)).toBe(true);
  if (first.state !== 'recorded') throw new Error('Expected recorded page');
  const rows = [...first.rows];
  let next = first.next;
  while (next !== null) {
    const page = await read({ ...query, offset: next, selection: first.selection });
    expect(page.state).toBe('recorded');
    if (page.state !== 'recorded') throw new Error('Expected continued page');
    rows.push(...page.rows); next = page.next;
  }
  expect(first.total).toBe(105); expect(rows).toHaveLength(105); expect(rows[104].name).toBe('Board p102');
  expect(new Set(rows.map((row) => row.key)).size).toBe(105);
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_BOARD_PAYLOAD|FOREIGN_BOARD_NAME|OTHER_PROJECT_NEVER_READ/);
  expect(await Promise.all([appFile, projectFile].map((file) => fsp.readFile(file)))).toEqual(before);
  expect(vi.mocked(fs.openSync).mock.calls.some(([file]) => /canvas-wires|canvas-active|backup|\.bak|OTHER_PROJECT_NEVER_READ/.test(String(file)))).toBe(false);
});
it('sorts projection identities independently of primary ordering and keeps receipts until publication', async () => {
  const boards = [board('b'), board('a')];
  await fsp.writeFile(projectFile, JSON.stringify(boards));
  const opts = options(), first = await read(query, opts);
  expect(opts.receipts.every((r) => r.current())).toBe(true);
  await fsp.writeFile(projectFile, JSON.stringify([...boards].reverse()));
  expect(opts.receipts.some((r) => !r.current())).toBe(true);
  const next = await read();
  expect(next.state === 'recorded' && first.state === 'recorded' && next.selection === first.selection).toBe(true);
});
it.each(['home source', 'project source', 'target', 'project registration', 'home namespace', 'revoked'] as const)('invalidates retained publication receipts after %s changes', async (change) => {
  const opts = options(); expect((await read(query, opts)).state).toBe('recorded');
  if (change === 'home source') await fsp.writeFile(appFile, JSON.stringify([board('replacement')]));
  if (change === 'project source') await fsp.writeFile(projectFile, JSON.stringify([board('replacement')]));
  if (change === 'target') await fsp.writeFile(path.join(project, '.clubhouse/agents.json'), JSON.stringify([{ ...config, disposedAt: '2026-11-20' }]));
  if (change === 'project registration') await fsp.writeFile(path.join(m.profile, 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
  if (change === 'home namespace') home = path.join(root, 'replacement-home');
  if (change === 'revoked') allowed = false;
  expect(opts.receipts.some((r) => !r.current())).toBe(true);
});
it.each(['canvas-instances.json.bak', 'canvas-instances-backup.json', 'canvas-instances-backup.json.bak'] as const)('refuses missing primary with %s without opening recovery contents', async (recovery) => {
  await fsp.unlink(appFile); await fsp.writeFile(path.join(path.dirname(appFile), recovery), '');
  const result = await read();
  expect(result).toMatchObject({ state: 'unavailable', reason: 'unreadable' });
  expect(result).not.toHaveProperty('rows'); expect(result).not.toHaveProperty('total');
  expect(vi.mocked(fs.openSync).mock.calls.some(([file]) => String(file).endsWith(recovery))).toBe(false);
});
it('distinguishes verified absent primary/recovery inventories from unresolved source', async () => {
  await fsp.unlink(appFile); await fsp.unlink(projectFile);
  const opts = options(), result = await read(query, opts);
  expect(result).toMatchObject({ state: 'recorded', total: 0, rows: [], next: null });
  await fsp.writeFile(path.join(path.dirname(appFile), 'canvas-instances-backup.json'), 'PRIVATE_RECOVERY_PAYLOAD');
  expect(opts.receipts.some((r) => !r.current())).toBe(true);
});
it.each(['ambiguous Home', 'duplicate board', 'duplicate view', 'corrupt', 'oversized', 'scan limit', 'symlink'] as const)('fails the complete page closed for %s', async (mode) => {
  if (mode === 'ambiguous Home') await fsp.writeFile(appFile, JSON.stringify([board('home', null)]));
  if (mode === 'duplicate board') await fsp.writeFile(appFile, JSON.stringify([board('same'), board('same')]));
  if (mode === 'duplicate view') { const b = board('home'); b.views.push({ ...b.views[0] }); await fsp.writeFile(appFile, JSON.stringify([b])); }
  if (mode === 'corrupt') await fsp.writeFile(appFile, '{broken');
  if (mode === 'oversized') await fsp.writeFile(appFile, ' '.repeat(4 * 1024 * 1024 + 1));
  if (mode === 'scan limit') await fsp.writeFile(appFile, JSON.stringify(Array.from({ length: 4097 }, (_, i) => ({ id: `b${i}`, views: [] }))));
  if (mode === 'symlink') { await fsp.unlink(appFile); await fsp.symlink(projectFile, appFile); }
  const result = await read();
  expect(result.state).toBe('unavailable'); expect(result).not.toHaveProperty('rows'); expect(result).not.toHaveProperty('total');
});
it('rejects a stale continuation when selected membership changes and withholds role pages', async () => {
  const first = await read();
  if (first.state !== 'recorded') throw new Error('Expected recorded page');
  await fsp.writeFile(projectFile, JSON.stringify([board('changed')]));
  expect(await read({ ...query, selection: first.selection })).toMatchObject({ state: 'unavailable', reason: 'changed' });
  m.role = true; expect(await read()).toMatchObject({ state: 'unavailable', reason: 'unsupported' });
});
