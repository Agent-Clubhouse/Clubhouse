import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const m = vi.hoisted(() => ({ base: '', generic: vi.fn(() => { throw new Error('ordinary lifecycle reader not admitted'); }) }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
vi.mock('./project-store', () => ({ list: m.generic, peekProjectsChecked: m.generic }));
vi.mock('./agent-config', () => ({ listDurable: m.generic, getDurableConfig: m.generic }));
vi.mock('./orchestration-settings', () => ({ readAutoHelpersForDisplay: m.generic, readGlobalHelperCapForDisplay: m.generic }));
vi.mock('./settings-store', () => ({ peekMetadataFileForDisplaySync: m.generic, peekStoredSettingsSync: m.generic }));
vi.mock('fs', async (original) => { const actual = await original<typeof import('fs')>(); return { ...actual, readSync: vi.fn(actual.readSync), openSync: vi.fn(actual.openSync) }; });
import { readConnectionEndpointMetadataForDisplay, CONNECTION_METADATA_REQUESTS, CONNECTION_METADATA_ROOTS, type AdmittedConnectionEndpoint } from './connection-endpoint-metadata-display';
import type { DisplayReceipt } from './display-settings';
let root: string, a: string, b: string;
const file = (project: string) => path.join(project, '.clubhouse', 'agents.json');
const row = (id: string, name: string, extra = {}) => ({ id, name, orchestration: { connectToDispatcher: true }, ...extra });
const put = (project: string, rows: unknown) => fs.promises.writeFile(file(project), JSON.stringify(rows));
const registry = (projects: Array<{ id: string; path: string }>) => fs.promises.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects }));
const request = (agentId = 'target', projectPath = b, association: DisplayReceipt = { current: () => true }): AdmittedConnectionEndpoint => ({ agentId, projectPath, association });
const query = (requests = [request()], receipts: DisplayReceipt[] = []) => readConnectionEndpointMetadataForDisplay(requests, { receipts });
const opened = () => vi.mocked(fs.openSync).mock.calls.map((args) => String(args[0]));
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  vi.mocked(fs.readSync).mockImplementation(actual.readSync); vi.mocked(fs.readSync).mockClear(); vi.mocked(fs.openSync).mockClear(); m.generic.mockClear();
  root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-related-metadata-')));
  m.base = path.join(root, 'base'); a = path.join(root, 'a'); b = path.join(root, 'b');
  await fs.promises.mkdir(m.base);
  for (const project of [a, b]) await fs.promises.mkdir(path.join(project, '.clubhouse'), { recursive: true });
  await registry([{ id: 'a', path: a }, { id: 'b', path: b }]);
  await put(a, [row('target', 'PRIVATE_OTHER_PROJECT_NAME')]);
  await put(b, [row('target', 'Expected project name', { instructions: 'PRIVATE_INSTRUCTIONS', env: { token: 'PRIVATE_TOKEN' } }), row('PRIVATE_OTHER', 'PRIVATE_UNRELATED_NAME')]);
});
afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }); });

it('reads only the exact registered expected project and returns safe saved fields, not current namespace or permission evidence', () => {
  const receipts: DisplayReceipt[] = [], result = query([request()], receipts);
  expect(result).toMatchObject({ state: 'ok', value: [{ state: 'ok', value: { record: 'registered-primary', fields: {
    id: 'target', name: { state: 'ok', value: 'Expected project name' }, helper: { value: false }, disposed: { value: false }, connectToDispatcher: { value: true },
  } } }] });
  expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|projectPath|instructions|env|runtime|permission/);
  expect.soft(opened()).not.toContain(file(a)); expect.soft(m.generic).not.toHaveBeenCalled(); expect.soft(receipts).toHaveLength(1); expect(receipts[0].current()).toBe(true);
});
it('keeps project-qualified duplicate native IDs separate and does not use a same-name fallback', async () => {
  await put(a, [row('different-id', 'target')]);
  const result = query([request('target', a), request('target', b)]);
  expect(result).toMatchObject({ state: 'ok', value: [{ state: 'ok', value: { record: 'absent-from-primary' } }, { state: 'ok', value: { fields: { name: { value: 'Expected project name' } } } }] });
});
it('does not open an unregistered related root even if its file is readable and contains a matching ID', async () => {
  await registry([{ id: 'a', path: a }]);
  expect(query()).toMatchObject({ state: 'ok', value: [{ state: 'ok', value: { record: 'project-not-registered' } }] });
  expect(opened()).not.toContain(file(b));
});
it.each(['false', 'throw', 'malformed', 'overlong'] as const)('refuses %s association/input before any registry/project read', (mode) => {
  const value = request();
  if (mode === 'false') value.association = { current: () => false };
  if (mode === 'throw') value.association = { current: () => { throw new Error('changed source'); } };
  if (mode === 'malformed') value.projectPath = '';
  if (mode === 'overlong') value.agentId = 'x'.repeat(201);
  const receipts: DisplayReceipt[] = [];
  expect(query([value], receipts)).toMatchObject({ state: 'ok', value: [{ state: 'unavailable' }] });
  expect.soft(opened()).toEqual([]); expect.soft(receipts).toEqual([]); expect.soft(m.generic).not.toHaveBeenCalled();
});
it('bounds request admission before visiting rows or retaining input receipts', () => {
  expect(query(Array.from({ length: CONNECTION_METADATA_REQUESTS + 1 }, () => request()))).toMatchObject({ state: 'unavailable', reason: 'limit' });
  expect(opened()).toEqual([]);
});
it.each(['backup-only', 'corrupt', 'invalid-root'] as const)('keeps %s agent evidence unknown while preserving the independent readable endpoint', async (mode) => {
  if (mode === 'backup-only') { await fs.promises.rename(file(b), file(b) + '.bak'); }
  if (mode === 'corrupt') await fs.promises.writeFile(file(b), '{broken');
  if (mode === 'invalid-root') await put(b, {});
  expect(query([request('target', a), request('target', b)])).toMatchObject({ state: 'ok', value: [{ state: 'ok', value: { record: 'registered-primary' } }, { state: 'unavailable', reason: 'unreadable' }] });
});
it('distinguishes genuinely absent inventory from unreadable/backup-only and invalidates absence on primary creation', async () => {
  await fs.promises.unlink(file(b)); const receipts: DisplayReceipt[] = [];
  expect(query([request()], receipts)).toMatchObject({ state: 'ok', value: [{ state: 'ok', value: { record: 'absent-from-primary' } }] });
  expect(receipts[0].current()).toBe(true); await put(b, [row('target', 'Created later')]); expect(receipts[0].current()).toBe(false);
});
it.each(['duplicate-id', 'malformed-row', 'duplicate-project', 'future-version'] as const)('refuses ambiguous %s collections without adopting a convenient matching row', async (mode) => {
  if (mode === 'duplicate-id') await put(b, [row('target', 'First'), row('target', 'Second')]);
  if (mode === 'malformed-row') await put(b, [row('target', 'First'), { id: null }]);
  if (mode === 'duplicate-project') await registry([{ id: 'a', path: a }, { id: 'b', path: b }, { id: 'duplicate', path: b }]);
  if (mode === 'future-version') await fs.promises.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 2, projects: [{ id: 'b', path: b }] }));
  expect(query()).toMatchObject({ state: 'ok', value: [{ state: 'unavailable', reason: 'unreadable' }] });
});
it('charges nonmatching registry/agent rows and keeps a previous independent result when a later inventory exceeds the total visit budget', async () => {
  await put(b, Array.from({ length: 4094 }, (_, i) => row(`unrelated-${i}`, 'Unrelated')));
  // Both files are individually below the byte bound; 2 registry + 1 A +
  // 4094 B entries exceed the shared 4096-row traversal budget.
  expect((await fs.promises.stat(file(b))).size).toBeLessThan(4 * 1024 * 1024);
  expect(query([request('target', a), request('target', b)])).toMatchObject({ state: 'ok', value: [{ state: 'ok', value: { record: 'registered-primary' } }, { state: 'unavailable', reason: 'limit' }] });
});
it('does not open roots beyond the separate related-project limit', async () => {
  const projects = [];
  for (let i = 0; i < CONNECTION_METADATA_ROOTS + 1; i++) {
    const project = path.join(root, `many-${i}`); await fs.promises.mkdir(path.join(project, '.clubhouse'), { recursive: true }); await put(project, [row('target', `Name ${i}`)]); projects.push({ id: `p-${i}`, path: project });
  }
  await registry(projects); const result = query(projects.map((p) => request('target', p.path)));
  expect(result.state).toBe('ok'); if (result.state !== 'ok') return;
  expect.soft(result.value.slice(0, CONNECTION_METADATA_ROOTS).every((r) => r.state === 'ok')).toBe(true);
  expect.soft(result.value[CONNECTION_METADATA_ROOTS]).toMatchObject({ state: 'unavailable', reason: 'limit' });
  expect.soft(opened()).not.toContain(file(projects[CONNECTION_METADATA_ROOTS].path));
});
it('binds actual registry and agent primaries through later assembly, with detached returned fields and copied request identities', async () => {
  const receipts: DisplayReceipt[] = [], input = request(), result = query([input], receipts);
  expect(result.state).toBe('ok'); if (result.state !== 'ok' || result.value[0].state !== 'ok' || result.value[0].value.record !== 'registered-primary') return;
  const fields = result.value[0].value.fields; if (fields.name.state === 'ok') fields.name.value = 'CALLER_EDIT';
  input.agentId = 'OTHER'; input.projectPath = a;
  expect.soft(query()).toMatchObject({ state: 'ok', value: [{ state: 'ok', value: { fields: { name: { value: 'Expected project name' } } } }] });
  expect(receipts[0].current()).toBe(true);
  await put(b, [row('target', 'Replaced after return')]); expect(receipts[0].current()).toBe(false);
  const newReceipts: DisplayReceipt[] = []; query([request()], newReceipts); expect(newReceipts[0].current()).toBe(true);
  await registry([{ id: 'a', path: a }]); expect(newReceipts[0].current()).toBe(false);
});
it('withholds fields if their source association changes during a real metadata read, and retains that private receipt after return', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs'); let associated = true, reads = 0;
  vi.mocked(fs.readSync).mockImplementation((...args: Parameters<typeof actual.readSync>) => {
    const result = actual.readSync(...args); if (++reads === 2) associated = false; return result;
  });
  const receipts: DisplayReceipt[] = [], result = query([request('target', b, { current: () => associated })], receipts);
  expect.soft(reads).toBeGreaterThanOrEqual(2); expect.soft(result).toMatchObject({ state: 'ok', value: [{ state: 'unavailable', reason: 'changed' }] }); expect.soft(JSON.stringify(result)).not.toContain('Expected project name'); expect.soft(opened()).not.toContain(file(b)); expect(receipts[0].current()).toBe(false);
});
it('revalidates earlier selected file evidence after reading a later endpoint', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs'); let changed = false;
  vi.mocked(fs.readSync).mockImplementation((...args: Parameters<typeof actual.readSync>) => {
    const result = actual.readSync(...args);
    if (!changed && opened().includes(file(b))) { changed = true; actual.writeFileSync(file(a), JSON.stringify([row('target', 'Changed during later read')])); }
    return result;
  });
  const result = query([request('target', a), request('target', b)]);
  expect(changed).toBe(true); expect.soft(result).toMatchObject({ state: 'ok', value: [{ state: 'unavailable', reason: 'changed' }, { state: 'unavailable', reason: 'changed' }] }); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_OTHER_PROJECT_NAME');
});
it('does not recover corrupt primary bytes, remove temps or adopt a readable backup', async () => {
  await fs.promises.writeFile(file(b), '{broken'); await fs.promises.writeFile(file(b) + '.bak', JSON.stringify([row('target', 'PRIVATE_BACKUP_NAME')])); await fs.promises.writeFile(file(b) + '.tmp-pending', 'keep');
  const before = await Promise.all(['', '.bak', '.tmp-pending'].map((suffix) => fs.promises.readFile(file(b) + suffix)));
  const result = query(); expect(result).toMatchObject({ state: 'ok', value: [{ state: 'unavailable' }] }); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect.soft(await Promise.all(['', '.bak', '.tmp-pending'].map((suffix) => fs.promises.readFile(file(b) + suffix)))).toEqual(before); expect.soft(m.generic).not.toHaveBeenCalled();
});
