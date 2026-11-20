import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const m = vi.hoisted(() => ({ base: '', selected: true, legacy: vi.fn(() => { throw new Error('ordinary reader forbidden'); }) }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
vi.mock('./orchestration-settings', () => ({ readAutoHelpersForDisplay: m.legacy, readGlobalHelperCapForDisplay: m.legacy }));
vi.mock('./settings-store', () => ({ peekMetadataFileForDisplaySync: m.legacy, peekStoredSettingsSync: m.legacy }));
vi.mock('./dispatcher-connections', () => ({ readDispatcherConnections: m.legacy }));
vi.mock('fs', async (original) => { const actual = await original<typeof import('fs')>(); return { ...actual, readSync: vi.fn(actual.readSync), openSync: vi.fn(actual.openSync) }; });
import { readSavedDispatcherEndpointMetadataForDisplay } from './dispatcher-endpoint-associations-display';
import { readConnectionEndpointMetadataForDisplay } from './connection-endpoint-metadata-display';
import type { DisplayReceipt } from './display-settings';
let root: string, a: string, b: string, c: string;
const source = () => path.join(m.base, 'dispatcher-connections.json');
const agentFile = (project: string) => path.join(project, '.clubhouse', 'agents.json');
const putAgents = (project: string, rows: unknown) => fs.promises.writeFile(agentFile(project), JSON.stringify(rows));
const pair = (targetId = 'target') => ({ agentId: 'selected', targetId });
const saved = (extra = {}) => ({ ...pair(), agentProjectPath: a, targetProjectPath: b, createdBy: 'selected', createdAt: '2026-11-19T00:00:00Z', ...extra });
const putSource = (connections: unknown[]) => fs.promises.writeFile(source(), JSON.stringify({ version: 1, connections, removedByUser: [] }));
const query = (pairs = [pair()], receipts: DisplayReceipt[] = []) => readSavedDispatcherEndpointMetadataForDisplay({ agentId: 'selected', projectPath: a, target: { current: () => m.selected } }, pairs, { receipts });
const opened = () => vi.mocked(fs.openSync).mock.calls.map((args) => String(args[0]));
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs'); vi.mocked(fs.readSync).mockImplementation(actual.readSync); vi.mocked(fs.readSync).mockClear(); vi.mocked(fs.openSync).mockClear(); m.legacy.mockClear(); m.selected = true;
  root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-source-association-')));
  m.base = path.join(root, 'base'); a = path.join(root, 'a'); b = path.join(root, 'b'); c = path.join(root, 'c'); await fs.promises.mkdir(m.base);
  for (const project of [a, b, c]) await fs.promises.mkdir(path.join(project, '.clubhouse'), { recursive: true });
  await fs.promises.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'a', path: a, name: 'A' }, { id: 'b', path: b, name: 'B' }, { id: 'c', path: c, name: 'C' }] }));
  await putAgents(a, [{ id: 'selected', name: 'Selected' }]);
  await putAgents(b, [{ id: 'target', name: 'Expected B name', orchestration: { connectToDispatcher: true }, instructions: 'PRIVATE_INSTRUCTIONS' }]);
  await putAgents(c, [{ id: 'target', name: 'PRIVATE_OTHER_PROJECT_NAME' }]); await putSource([saved()]);
});
afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }); });
it('derives the other registered project only from the exact selected saved relationship and returns safe metadata without paths or callbacks', () => {
  const receipts: DisplayReceipt[] = [], result = query([pair()], receipts);
  expect(result).toMatchObject({ state: 'ok', value: { scope: 'saved-dispatcher-endpoint-metadata', rows: [{ ...pair(), relationship: 'recorded', endpoint: { state: 'ok', value: { record: 'registered-primary', fields: { id: 'target', name: { value: 'Expected B name' }, connectToDispatcher: { value: true } } } } }] } });
  expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|projectPath|current|instructions|authority/); expect.soft(JSON.stringify(result)).not.toContain(root); expect.soft(JSON.stringify(receipts)).toBe('[{},{}]');
  expect.soft(opened()).not.toContain(agentFile(c)); expect.soft(m.legacy).not.toHaveBeenCalled(); expect(receipts.every((r) => r.current())).toBe(true);
});
it('resolves incoming selected relationships against their source project without adopting a reversed pair', async () => {
  await putSource([saved({ agentId: 'target', targetId: 'selected', agentProjectPath: b, targetProjectPath: a })]);
  expect(query([{ agentId: 'target', targetId: 'selected' }])).toMatchObject({ state: 'ok', value: { rows: [{ relationship: 'recorded', endpoint: { value: { fields: { name: { value: 'Expected B name' } } } } }] } });
  expect(query([pair()])).toMatchObject({ state: 'ok', value: { rows: [{ relationship: 'not-recorded' }] } });
});
it('does not read another project when the same selected ID is saved against a different selected project', async () => {
  await putSource([saved({ agentProjectPath: c })]);
  expect(query()).toMatchObject({ state: 'ok', value: { rows: [{ relationship: 'different-selected-project' }] } });
  expect.soft(opened()).not.toContain(agentFile(b)); expect.soft(opened()).not.toContain(path.join(m.base, 'projects.json'));
});
it('binds the private other-project path even though a path-free card row would remain unchanged', async () => {
  const receipts: DisplayReceipt[] = []; expect(query([pair()], receipts).state).toBe('ok'); expect(receipts.every((r) => r.current())).toBe(true);
  await putSource([saved({ targetProjectPath: c })]); expect.soft(receipts.every((r) => r.current())).toBe(false);
  expect.soft(query()).toMatchObject({ state: 'ok', value: { rows: [{ endpoint: { value: { fields: { name: { value: 'PRIVATE_OTHER_PROJECT_NAME' } } } } }] } });
});
it('withholds association metadata when the source path changes during the registry read and avoids reading either target inventory', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs'); let changed = false;
  vi.mocked(fs.readSync).mockImplementation((...args: Parameters<typeof actual.readSync>) => {
    const value = actual.readSync(...args);
    if (!changed && opened().includes(path.join(m.base, 'projects.json'))) { changed = true; actual.writeFileSync(source(), JSON.stringify({ version: 1, connections: [saved({ targetProjectPath: c })], removedByUser: [] })); }
    return value;
  });
  const result = query(); expect(changed).toBe(true); expect.soft(result).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect.soft(opened()).not.toContain(agentFile(b)); expect.soft(opened()).not.toContain(agentFile(c)); expect.soft(JSON.stringify(result)).not.toContain('Expected B name');
});
it('keeps selected role/target evidence independent before reading endpoints and after return', async () => {
  m.selected = false; expect(query()).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect(opened()).toEqual([]);
  m.selected = true; const receipts: DisplayReceipt[] = []; query([pair()], receipts); expect(receipts.every((r) => r.current())).toBe(true); m.selected = false; expect(receipts.every((r) => r.current())).toBe(false);
});
it('retains actual endpoint file witnesses through later assembly without aliasing caller pairs or returned fields', async () => {
  const pairs = [pair()], receipts: DisplayReceipt[] = [], result = query(pairs, receipts); expect(result.state).toBe('ok');
  pairs[0].targetId = 'PRIVATE_REPLACEMENT'; if (result.state === 'ok') result.value.rows[0].relationship = 'not-recorded';
  expect.soft(receipts.every((r) => r.current())).toBe(true); expect.soft(query()).toMatchObject({ state: 'ok', value: { rows: [{ relationship: 'recorded' }] } });
  await putAgents(b, [{ id: 'target', name: 'Replaced after return' }]); expect(receipts.every((r) => r.current())).toBe(false);
});
it('copies admitted selected primitives before filesystem work rather than following caller object edits', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs'); let edited = false;
  const selected = { agentId: 'selected', projectPath: a, target: { current: () => true } };
  vi.mocked(fs.readSync).mockImplementation((...args: Parameters<typeof actual.readSync>) => {
    const result = actual.readSync(...args);
    if (!edited) { edited = true; selected.agentId = 'PRIVATE_REPLACEMENT'; selected.projectPath = c; }
    return result;
  });
  const result = readSavedDispatcherEndpointMetadataForDisplay(selected, [pair()], { receipts: [] });
  expect(edited).toBe(true); expect.soft(result).toMatchObject({ state: 'ok', value: { rows: [{ ...pair(), relationship: 'recorded', endpoint: { value: { fields: { name: { value: 'Expected B name' } } } } }] } }); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it.each(['unrelated', 'duplicate', 'self', 'over-limit'] as const)('rejects %s pair admission before opening the source or retaining receipts', (mode) => {
  const pairs = mode === 'unrelated' ? [{ agentId: 'PRIVATE_UNRELATED', targetId: 'target' }] : mode === 'duplicate' ? [pair(), pair()] : mode === 'self' ? [{ agentId: 'selected', targetId: 'selected' }] : Array.from({ length: 51 }, (_, i) => pair(`target-${i}`));
  const receipts: DisplayReceipt[] = []; expect(query(pairs, receipts).state).toBe('unavailable'); expect.soft(opened()).toEqual([]); expect.soft(receipts).toEqual([]);
});
it('charges unrelated source entries before walking them and keeps the count discriminator below the independent byte limit', async () => {
  await putSource(Array.from({ length: 4097 }, (_, i) => ({ agentId: `unrelated-${i}`, targetId: 'unrelated' })));
  expect((await fs.promises.stat(source())).size).toBeLessThan(1024 * 1024);
  expect(query()).toMatchObject({ state: 'unavailable', reason: 'limit' }); expect.soft(opened()).not.toContain(path.join(m.base, 'projects.json'));
});
it('refuses duplicate selected source associations instead of choosing a convenient project', async () => {
  await putSource([saved(), saved({ targetProjectPath: c })]); expect(query()).toMatchObject({ state: 'unavailable', reason: 'unreadable' }); expect.soft(opened()).not.toContain(agentFile(b)); expect.soft(opened()).not.toContain(agentFile(c));
});
it('preserves an applicable saved relationship when independent endpoint primary metadata is unavailable', async () => {
  await fs.promises.writeFile(agentFile(b), '{broken');
  expect(query()).toMatchObject({ state: 'ok', value: { rows: [{ relationship: 'recorded', endpoint: { state: 'unavailable', reason: 'unreadable' } }] } });
});
it('leaves cold corrupt source, backup and temp bytes unchanged without lifecycle recovery or current endpoint reads', async () => {
  await fs.promises.writeFile(source(), '{broken'); await fs.promises.writeFile(source() + '.bak', JSON.stringify({ version: 1, connections: [saved()] })); await fs.promises.writeFile(source() + '.tmp-pending', 'keep');
  const before = await Promise.all(['', '.bak', '.tmp-pending'].map((suffix) => fs.promises.readFile(source() + suffix)));
  expect(query()).toMatchObject({ state: 'unavailable', reason: 'unreadable' }); expect.soft(await Promise.all(['', '.bak', '.tmp-pending'].map((suffix) => fs.promises.readFile(source() + suffix)))).toEqual(before); expect.soft(opened()).not.toContain(agentFile(b)); expect.soft(m.legacy).not.toHaveBeenCalled();
});
it('checks a shared source receipt once per admission/final phase, freshly before the related project read', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: `target-${i}`, name: `Target ${i}` })); await putAgents(b, rows);
  const association = { current: vi.fn(() => true) }, receipts: DisplayReceipt[] = [];
  const result = readConnectionEndpointMetadataForDisplay(rows.map((r) => ({ agentId: r.id, projectPath: b, association })), { receipts });
  expect.soft(result.state).toBe('ok'); expect.soft(association.current).toHaveBeenCalledTimes(3);
  receipts[0].current(); expect(association.current).toHaveBeenCalledTimes(4);
});
it('bounds actual source file rechecks independently of twenty selected pairs sharing the same project', async () => {
  const pairs = Array.from({ length: 20 }, (_, i) => pair(`target-${i}`));
  await putSource(pairs.map((p) => saved(p))); await putAgents(b, pairs.map((p) => ({ id: p.targetId, name: `Saved ${p.targetId}` })));
  const result = query(pairs); expect(result.state).toBe('ok'); if (result.state !== 'ok') return;
  expect(result.value.rows).toHaveLength(20); expect(result.value.rows.every((r) => r.relationship === 'recorded' && r.endpoint?.state === 'ok')).toBe(true);
  // Initial source read + own pre/post checks + metadata admission/project/
  // final checks: no repeated full-source parse for each of the twenty pairs.
  expect(opened().filter((f) => f === source())).toHaveLength(6);
});
