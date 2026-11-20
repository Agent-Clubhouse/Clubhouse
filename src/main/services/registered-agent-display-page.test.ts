import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const m = vi.hoisted(() => ({ home: '', allowed: true }));
vi.mock('electron', () => ({ app: { getPath: () => m.home } }));
vi.mock('./agent-config', () => { throw new Error('Display inventory imported the ordinary owner'); });
vi.mock('./project-store', () => { throw new Error('Display inventory imported the ordinary project store'); });
import { getBaseDirPath } from './base-dir';
import { readRegisteredAgentDisplayPage } from './registered-agent-display-page';
import type { DisplayReceipt } from './display-settings';
let root: string, a: string, b: string;
const agent = (id: string, extra = {}) => ({ id, name: 'Name ' + id, color: 'blue', createdAt: '2026-11-20', ...extra });
const put = (folder: string, rows: unknown[]) => fsp.writeFile(path.join(folder, '.clubhouse', 'agents.json'), JSON.stringify(rows));
const selection = () => ({ agentId: 'parent', projectId: 'a', projectPath: a, receipt: { current: () => m.allowed } });
const read = (options = {}) => readRegisteredAgentDisplayPage(selection(), 'helper-children', { authorized: () => m.allowed, receipts: [], ...options });
beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-registered-display-'))); m.home = root; m.allowed = true; a = path.join(root, 'a'); b = path.join(root, 'b');
  for (const p of [a, b]) await fsp.mkdir(path.join(p, '.clubhouse'), { recursive: true });
  await fsp.mkdir(getBaseDirPath(), { recursive: true });
  await fsp.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'a', name: 'Project A', path: a }, { id: 'b', name: 'Custom B', path: b }] }));
  await put(a, [agent('parent')]); await put(b, []);
});
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });
it('projects only applicable selected helpers and private root evidence, without raw configuration or ordinary loaders', async () => {
  await put(b, [agent('helper', { parentAgentId: 'parent', parentProjectPath: a, instructions: 'PRIVATE_INSTRUCTIONS', env: { secret: 'PRIVATE_CREDENTIAL' } }), agent('unrelated', { parentAgentId: 'other', name: 'PRIVATE_UNRELATED_NAME' })]);
  const roots = new Map(), receipts: DisplayReceipt[] = [], result = read({ rootEvidence: roots, receipts });
  expect(result).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 1, entries: [{ agentId: 'helper', projectId: 'b', projectName: { value: 'Custom B' }, parentAgentId: 'parent' }], next: null } });
  expect(roots.size).toBe(1); expect(roots.get('b')).toMatchObject({ projectPath: b }); expect(receipts.every((r) => r.current())).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|instructions|env|projectPath|namespace/); expect(JSON.stringify(result)).not.toContain(root);
  await put(b, []); expect(receipts.some((r) => !r.current())).toBe(true); expect(roots.get('b').receipt.current()).toBe(false);
});
it('continues selected helper matches while preserving independently observed page boundaries', async () => {
  await put(a, [agent('parent'), ...Array.from({ length: 51 }, (_, i) => agent('helper-' + i, { parentAgentId: 'parent' }))]);
  const first = read(); expect(first).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 51, next: { projectOffset: 0, matchOffset: 50 } } });
  if (first.state !== 'ok') throw new Error('fixture'); expect(first.value.entries).toHaveLength(50);
  const last = read(first.value.next!); expect(last).toMatchObject({ state: 'ok', value: { entries: [{ agentId: 'helper-50' }], knownMatches: 51, next: null } });
});
it('keeps configured Dispatcher applicability separate from ordinary unrelated fields and unknown policies', async () => {
  await put(b, [agent('on', { orchestration: { connectToDispatcher: true } }), agent('off', { orchestration: { connectToDispatcher: false } }), agent('disposed', { disposedAt: '2026-11-20', orchestration: { connectToDispatcher: true } }), agent('bad', { orchestration: { connectToDispatcher: 'bad' } })]);
  const result = readRegisteredAgentDisplayPage({ ...selection(), agentId: 'controller', projectId: 'dispatcher' }, 'dispatcher-auto', { authorized: () => true, receipts: [] });
  expect(result).toMatchObject({ state: 'ok', value: { complete: false, unknownRows: 1, entries: [{ agentId: 'on' }] } });
  expect(JSON.stringify(result)).not.toContain('Name off'); expect(JSON.stringify(result)).not.toContain('Name bad');
});
it('refuses denied or prefilled-root-map reads before opening a metadata file', () => {
  const open = vi.spyOn(fs, 'openSync'); m.allowed = false; expect(read().state).toBe('unavailable'); expect(open).not.toHaveBeenCalled();
  m.allowed = true; expect(read({ rootEvidence: new Map([['bad', {}]]) }).state).toBe('unavailable'); expect(open).not.toHaveBeenCalled(); open.mockRestore();
});
it('does not read a primary body beyond admission limits or turn its missing helper evidence into empty', async () => {
  await put(b, [agent('large', { parentAgentId: 'parent', parentProjectPath: a, unused: 'x'.repeat(4 * 1024 * 1024) })]);
  const opened: string[] = [], real = fs.openSync; const spy = vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => { opened.push(String(args[0])); return real(...args); }) as typeof fs.openSync);
  const result = read(); spy.mockRestore(); expect(result).toMatchObject({ state: 'ok', value: { complete: false, unavailableProjects: 1, entries: [] } }); expect(opened).not.toContain(path.join(b, '.clubhouse', 'agents.json'));
});
