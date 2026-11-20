import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const m = vi.hoisted(() => ({ home: '', allowed: true }));
vi.mock('electron', () => ({ app: { getPath: () => m.home } }));
vi.mock('fs', async (original) => { const actual = await original<typeof import('fs')>(); return { ...actual, openSync: vi.fn(actual.openSync) }; });
vi.mock('./agent-config', () => { throw new Error('Display inventory imported the ordinary owner'); });
vi.mock('./project-store', () => { throw new Error('Display inventory imported the ordinary project store'); });
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { getBaseDirPath } from './base-dir';
import { readRegisteredAgentDisplayPage } from './registered-agent-display-page';
import type { DisplayReceipt } from './display-settings';
let root: string, a: string, b: string;
const agent = (id: string, extra = {}) => ({ id, name: 'Name ' + id, color: 'blue', createdAt: '2026-11-20', ...extra });
const put = (folder: string, rows: unknown[]) => fsp.writeFile(path.join(folder, '.clubhouse', 'agents.json'), JSON.stringify(rows));
const selection = () => ({ agentId: 'parent', projectId: 'a', projectPath: a, receipt: { current: () => m.allowed } });
const read = (options = {}) => readRegisteredAgentDisplayPage(selection(), 'helper-children', { authorized: () => m.allowed, receipts: [], ...options });
beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-registered-display-'))); m.home = root; m.allowed = true; vi.mocked(fs.openSync).mockClear(); a = path.join(root, 'a'); b = path.join(root, 'b');
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
  const result = readRegisteredAgentDisplayPage({ ...selection(), agentId: 'controller', projectId: DISPATCHER_PROJECT_ID }, 'dispatcher-auto', { authorized: () => true, receipts: [] });
  expect(result).toMatchObject({ state: 'ok', value: { complete: false, unknownRows: 1, entries: [{ agentId: 'on' }] } });
  expect(JSON.stringify(result)).not.toContain('Name off'); expect(JSON.stringify(result)).not.toContain('Name bad');
});
it('refuses denied or prefilled-root-map reads before opening a metadata file', () => {
  const open = vi.spyOn(fs, 'openSync'); m.allowed = false; expect(read().state).toBe('unavailable'); expect(open).not.toHaveBeenCalled();
  m.allowed = true; expect(read({ rootEvidence: new Map([['bad', {}]]) }).state).toBe('unavailable'); expect(open).not.toHaveBeenCalled(); open.mockRestore();
});
it('does not read a primary body beyond admission limits or turn its missing helper evidence into empty', async () => {
  await put(b, [agent('large', { parentAgentId: 'parent', parentProjectPath: a, unused: 'x'.repeat(4 * 1024 * 1024) })]);
  const actual = await vi.importActual<typeof import('fs')>('fs'); const opened: string[] = [], real = actual.openSync; const spy = vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => { opened.push(String(args[0])); return real(...args); }) as typeof fs.openSync);
  const result = read(); spy.mockRestore(); expect(result).toMatchObject({ state: 'ok', value: { complete: false, unavailableProjects: 1, entries: [] } }); expect(opened).not.toContain(path.join(b, '.clubhouse', 'agents.json'));
});

it('captures selection facts before authorization callbacks and withholds an in-read revocation', async () => {
  await put(b, [agent('wanted', { parentAgentId: 'parent', parentProjectPath: a }), agent('PRIVATE_OTHER_HELPER', { parentAgentId: 'different', parentProjectPath: b })]);
  const selected = selection(); let called = false;
  const result = readRegisteredAgentDisplayPage(selected, 'helper-children', { receipts: [], authorized: () => { if (!called) { called = true; selected.agentId = 'different'; selected.projectId = 'b'; selected.projectPath = b; } return true; } });
  expect(result).toMatchObject({ state: 'ok', value: { entries: [{ agentId: 'wanted' }], complete: true } }); expect(JSON.stringify(result)).not.toContain('PRIVATE_OTHER_HELPER');
  const actual = (await vi.importActual<typeof import('fs')>('fs')).openSync;
  const open = vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => { const fd = actual(...args); m.allowed = false; return fd; }) as typeof fs.openSync);
  m.allowed = true; expect(read().state).toBe('unavailable'); expect(m.allowed).toBe(false); open.mockRestore();
});
it('admits only a bounded number of distinct parent alias probes and labels the remaining association unknown', async () => {
  const aliases = Array.from({ length: 65 }, (_, i) => a + (path.sep + '.' + path.sep).repeat(i + 1));
  await put(b, aliases.map((alias, i) => agent('child-' + i, { parentAgentId: 'parent', parentProjectPath: alias })));
  const result = read(); expect(result).toMatchObject({ state: 'ok', value: { complete: false, knownMatches: 64, unknownRows: 1 } });
  if (result.state !== 'ok') throw new Error('fixture'); expect(result.value.entries).toHaveLength(50);
});
it('charges both inventory passes before traversing an oversized row collection', async () => {
  await put(b, Array.from({ length: 2049 }, (_, i) => agent('child-' + i, { parentAgentId: 'parent', parentProjectPath: a })));
  const result = read(); expect(result).toMatchObject({ state: 'ok', value: { complete: false, unavailableProjects: 1, knownMatches: 0, entries: [] } });
});
it('continues registered-root pages and treats a shifted page as changed rather than verified empty', async () => {
  const projects = [{ id: 'a', name: 'Project A', path: a }];
  for (let i = 0; i < 16; i++) { const folder = path.join(root, 'project-' + i); await fsp.mkdir(path.join(folder, '.clubhouse'), { recursive: true }); await put(folder, [agent('child-' + i, { parentAgentId: 'parent', parentProjectPath: a })]); projects.push({ id: 'p' + i, name: 'Project ' + i, path: folder }); }
  await fsp.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects }));
  const first = read(); expect(first).toMatchObject({ state: 'ok', value: { knownMatches: 15, next: { projectOffset: 16, matchOffset: 0 } } });
  const last = read({ projectOffset: 16 }); expect(last).toMatchObject({ state: 'ok', value: { entries: [{ agentId: 'child-15' }], next: null } });
  expect(read({ projectOffset: 17 })).toMatchObject({ state: 'unavailable', reason: 'changed' });
});
it('keeps malformed relationship data partial while preserving known helpers, missing files and explicit false values', async () => {
  await put(b, [agent('known', { parentAgentId: 'parent', parentProjectPath: a, orchestration: { connectToDispatcher: false } }), agent('bad', { parentAgentId: 'parent', parentProjectPath: {} })]);
  const result = read(); expect(result).toMatchObject({ state: 'ok', value: { complete: false, unknownRows: 1, entries: [{ agentId: 'known', fields: { connectToDispatcher: { state: 'ok', value: false } } }] } });
  await fsp.unlink(path.join(b, '.clubhouse', 'agents.json')); expect(read()).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 0 } });
  await fsp.writeFile(path.join(b, '.clubhouse', 'agents.json.bak'), '[]'); expect(read()).toMatchObject({ state: 'ok', value: { complete: false, unavailableProjects: 1 } });
});
it('keeps a full bounded registry from consuming every related-agent row admission', async () => {
  const projects = [{ id: 'a', name: 'Selected', path: a }, { id: 'b', name: 'Other', path: b }, ...Array.from({ length: 4094 }, (_, i) => ({ id: 'p' + i, name: 'Project ' + i, path: path.join(root, 'not-opened-' + i) }))];
  await fsp.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects })); await put(b, [agent('known', { parentAgentId: 'parent', parentProjectPath: a })]);
  const result = read(); expect(result).toMatchObject({ state: 'ok', value: { knownMatches: 1, entries: [{ agentId: 'known' }], next: { projectOffset: 16, matchOffset: 0 } } });
});
it('continues at a deferred root after the aggregate byte budget, without permanently losing later supported records', async () => {
  const projects = [{ id: 'a', name: 'Selected', path: a }];
  for (let i = 0; i < 3; i++) {
    const folder = path.join(root, 'large-' + i); await fsp.mkdir(path.join(folder, '.clubhouse'), { recursive: true });
    await put(folder, [agent('large-' + i, { parentAgentId: 'parent', parentProjectPath: a, unused: 'x'.repeat(3 * 1024 * 1024) })]); projects.push({ id: 'large-' + i, name: 'Large ' + i, path: folder });
  }
  await fsp.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects }));
  const first = read(); expect(first).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 2, unavailableProjects: 0, next: { projectOffset: 3, matchOffset: 0 } } });
  if (first.state !== 'ok') throw new Error('fixture'); expect(first.value.entries.map((entry) => entry.agentId)).toEqual(['large-0', 'large-1']);
  const last = read(first.value.next!); expect(last).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 1, entries: [{ agentId: 'large-2' }], next: null } });
});

it('continues a supported later root when earlier roots exhausted this page agent-row budget', async () => {
  await put(b, Array.from({ length: 2048 }, (_, i) => agent('child-' + i, { parentAgentId: 'parent', parentProjectPath: a })));
  const first = read(); expect(first).toMatchObject({ state: 'ok', value: { complete: true, unavailableProjects: 0, knownMatches: 0, next: { projectOffset: 1, matchOffset: 0 } } });
  const last = read({ projectOffset: 1, matchOffset: 2000 }); expect(last).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 2048, next: null } });
  if (last.state !== 'ok') throw new Error('fixture'); expect(last.value.entries).toHaveLength(48); expect(last.value.entries[47].agentId).toBe('child-2047');
});
it('does not adopt another project’s same-ID parent or probe unrelated relationship aliases', async () => {
  await put(b, [agent('safe', { parentAgentId: 'parent', parentProjectPath: a }), agent('wrong', { name: 'PRIVATE_OTHER_PARENT_CHILD', parentAgentId: 'parent', parentProjectPath: b }), agent('unrelated', { name: 'PRIVATE_OTHER_RELATIONSHIP', parentAgentId: 'unrelated', parentProjectPath: '/unadmitted/never-probe' })]);
  const result = read(); expect(result).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 1, entries: [{ agentId: 'safe' }] } }); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});
