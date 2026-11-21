import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const m = vi.hoisted(() => ({ home: '', allowed: true }));
vi.mock('electron', () => ({ app: { getPath: () => m.home } }));
vi.mock('./project-store', () => { throw new Error('Ordinary project store must not load'); });
vi.mock('./agent-config', () => { throw new Error('Ordinary agent owner must not load'); });
import { getBaseDirPath } from './base-dir';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { readRegisteredProjectRootsForDisplay as read } from './registered-project-roots-display';
let root: string, folder: string;
const selected = () => ({ projectId: 'selected', projectPath: folder, receipt: { current: () => m.allowed } });
const put = (rows: unknown[]) => fs.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: rows }));
const rows = () => Array.from({ length: 18 }, (_, i) => ({ id: i ? 'p' + i : 'selected', name: 'Project ' + i, displayName: i === 17 ? 'Last custom project' : undefined, path: i ? path.join(root, 'p' + i) : folder }));
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-project-roots-'))); m.home = root; m.allowed = true; folder = path.join(root, 'selected'); await fs.mkdir(getBaseDirPath(), { recursive: true }); await put(rows()); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('returns a private bounded root page with custom names and a final registered-primary receipt', async () => {
  const receipts: Array<{ current(): boolean }> = [], first = read(selected(), { authorized: () => true, receipts });
  expect(first).toMatchObject({ state: 'ok', value: { total: 18, offset: 0, nextOffset: 16 } }); if (first.state !== 'ok') throw new Error('fixture'); expect(first.value.roots).toHaveLength(16);
  const last = read(selected(), { authorized: () => true, receipts, offset: 16 }); expect(last).toMatchObject({ state: 'ok', value: { roots: [{ id: 'p16' }, { id: 'p17', name: { value: 'Last custom project' } }], nextOffset: null } });
  expect(receipts.every((r) => r.current())).toBe(true); await put(rows().slice(0, 16)); expect(receipts.some((r) => !r.current())).toBe(true); expect(read(selected(), { authorized: () => true, receipts: [], offset: 16 }).state).toBe('unavailable');
});
it('requires exact registered selected project but accepts an independently admitted Dispatcher role', async () => {
  expect(read({ ...selected(), projectPath: path.join(root, 'other') }, { authorized: () => true, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'changed' });
  expect(read({ ...selected(), projectId: DISPATCHER_PROJECT_ID }, { authorized: () => true, receipts: [] }).state).toBe('ok');
});
it('captures selected identity before authority callbacks and refuses revoked reads before any missing-primary recovery', async () => {
  const target = selected(); expect(read(target, { authorized: () => { target.projectPath = '/unadmitted'; return true; }, receipts: [] }).state).toBe('ok');
  m.allowed = false; await fs.rename(path.join(getBaseDirPath(), 'projects.json'), path.join(getBaseDirPath(), 'projects.json.bak'));
  expect(read(selected(), { authorized: () => false, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect(await fs.readdir(getBaseDirPath())).toEqual(['projects.json.bak']);
});
it('refuses corrupt/ambiguous/oversized registries rather than adopting a backup or partial project census', async () => {
  await put([...rows(), rows()[0]]); expect(read(selected(), { authorized: () => true, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'unreadable' });
  await fs.writeFile(path.join(getBaseDirPath(), 'projects.json'), '{broken'); await fs.writeFile(path.join(getBaseDirPath(), 'projects.json.bak'), '[]');
  expect(read(selected(), { authorized: () => true, receipts: [] }).state).toBe('unavailable'); expect(await fs.readFile(path.join(getBaseDirPath(), 'projects.json'), 'utf8')).toBe('{broken');
});
