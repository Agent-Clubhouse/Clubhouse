import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
const m = vi.hoisted(() => ({ home: '', external: vi.fn(() => { throw new Error('Display must not enter external services.'); }) }));
vi.mock('electron', () => ({ app: { getPath: () => m.home, isPackaged: false, on: vi.fn(), once: vi.fn() } }));
vi.mock('child_process', () => ({ exec: m.external, execSync: m.external, execFile: m.external, execFileSync: m.external, spawn: m.external }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: m.external }));
vi.mock('./agent-transition', () => ({ withAgentActivity: (_id: string, work: () => unknown) => work(), noteProviderSelection: vi.fn() }));
vi.mock('./free-agent-settings', () => ({ accessForNewAgent: m.external, agentAccess: m.external, getPermissionMode: m.external }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('../telemetry/persist', () => ({ persist: { timed: (_store: string, work: () => unknown) => work(), recovery: vi.fn(), barrierWait: vi.fn() } }));
vi.mock('./settings-audit', () => ({ auditChanged: vi.fn(), auditChanges: vi.fn() }));
vi.mock('./context-window', () => ({ contextWindowCheck: m.external }));
vi.mock('./managed-agents/legacy-migration', () => ({ legacyClubhouseModeEnabled: () => false }));
vi.mock('./managed-agents/changed-notice', () => ({ noteManagedSettingsChanged: m.external }));
vi.mock('./managed-agents/delivery-records', () => ({ forgetDelivery: m.external }));
vi.mock('./chat-idle-settings', () => ({ setAgentIdleSleep: m.external }));
vi.mock('./agent-runtime/chat-media-retention', () => ({ removeAgentChatMedia: m.external }));
vi.mock('./helper-auto-state', () => ({ forgetAutoHelper: m.external }));
vi.mock('./grant-requests', () => ({ dropGrantRequestsFor: m.external }));
vi.mock('fs', async (original) => { const actual = await original<typeof import('fs')>(); return { ...actual,
  statSync: vi.fn(actual.statSync), readFileSync: vi.fn(actual.readFileSync), lstatSync: vi.fn(actual.lstatSync), existsSync: vi.fn(actual.existsSync),
  watch: vi.fn(() => { const watcher = { on: vi.fn(() => watcher), close: vi.fn() }; return watcher; }),
}; });
vi.mock('fs/promises', async (original) => { const actual = await original<typeof import('fs/promises')>(); return { ...actual,
  readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile), stat: vi.fn(actual.stat), rename: vi.fn(actual.rename), mkdir: vi.fn(actual.mkdir),
}; });
import { clearAgentConfigCache, initializeDurableProject, getDurableConfig, peekCachedDurableConfig, readAgentConnectionCacheForDisplay, updateDurableConfig, flushAgentConfig } from './agent-config';
import type { DisplayReceipt } from './display-settings';
let root: string, project: string;
const file = () => path.join(project, '.clubhouse', 'agents.json');
const agent = (extra = {}) => ({ id: 'target', name: 'Selected cache name', color: 'blue', createdAt: '2026-11-19T00:00:00Z', orchestrator: 'codex-cli', orchestration: { connectToDispatcher: true }, instructions: 'PRIVATE_INSTRUCTIONS', env: { token: 'PRIVATE_CREDENTIAL' }, ...extra });
const io = () => [fsp.readFile, fsp.writeFile, fsp.stat, fsp.rename, fsp.mkdir, fs.statSync, fs.readFileSync, fs.lstatSync, fs.existsSync, fs.watch];
const resetObservation = () => { for (const fn of io()) vi.mocked(fn).mockClear(); m.external.mockClear(); };
const assertNoReadEffects = () => { for (const fn of io()) expect.soft(fn).not.toHaveBeenCalled(); expect.soft(m.external).not.toHaveBeenCalled(); };
const read = (receipts: DisplayReceipt[] = []) => readAgentConnectionCacheForDisplay(project, 'target', { receipts });
const warm = async () => { await initializeDurableProject(project); await new Promise<void>((resolve) => setImmediate(resolve)); resetObservation(); };
beforeEach(async () => {
  clearAgentConfigCache(); const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises'); vi.mocked(fsp.rename).mockImplementation(actual.rename);
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-agent-cache-display-'))); m.home = root; project = path.join(root, 'project');
  await fsp.mkdir(path.join(project, '.clubhouse'), { recursive: true }); await fsp.writeFile(file(), JSON.stringify([agent()])); resetObservation();
});
afterEach(async () => { clearAgentConfigCache(); await fsp.rm(root, { recursive: true, force: true }); });

it.each(['present', 'corrupt', 'backup-only', 'missing'] as const)('keeps cold %s cache unknown without loading, recovering, watching or changing disk', async (mode) => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  if (mode === 'corrupt') await actual.writeFile(file(), '{broken');
  if (mode === 'backup-only') await actual.rename(file(), file() + '.bak');
  if (mode === 'missing') await actual.unlink(file());
  await actual.writeFile(file() + '.tmp-pending', 'keep');
  const before = await actual.readdir(path.dirname(file())); resetObservation();
  const receipts: DisplayReceipt[] = []; expect(read(receipts)).toMatchObject({ scope: 'host-session-cache', availability: 'not-loaded' }); expect.soft(receipts).toEqual([]); assertNoReadEffects();
  expect.soft(await actual.readdir(path.dirname(file()))).toEqual(before); expect.soft(await actual.readFile(file() + '.tmp-pending', 'utf8')).toBe('keep');
});
it('projects only bounded selected loaded fields with host-memory observation provenance and a private currentness receipt', async () => {
  await warm(); const receipts: DisplayReceipt[] = [], result = read(receipts);
  expect(result).toMatchObject({ scope: 'host-session-cache', availability: 'loaded', fields: { state: 'ok', inputs: [{ source: 'host-cache' }], value: { id: 'target', name: { value: 'Selected cache name', inputs: [{ source: 'host-cache' }] }, helper: { value: false }, disposed: { value: false }, connectToDispatcher: { value: true } } } });
  expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|projectPath|namespace|runtime|permission/); expect.soft(JSON.stringify(receipts)).toBe('[{}]'); expect(receipts[0].current()).toBe(true); assertNoReadEffects();
});
it('keeps a missing ID in a loaded project distinct from a cold project or confirmed disk absence', async () => {
  await warm(); expect(readAgentConnectionCacheForDisplay(project, 'PRIVATE_OTHER', { receipts: [] })).toMatchObject({ availability: 'not-in-loaded-index' });
  expect(readAgentConnectionCacheForDisplay(path.join(root, 'cold'), 'target', { receipts: [] })).toMatchObject({ availability: 'not-loaded' }); assertNoReadEffects();
});
it('does not borrow a loaded native ID from another project or warm a cold copied project inventory', async () => {
  await warm(); const other = path.join(root, 'other'); const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  await actual.mkdir(path.join(other, '.clubhouse'), { recursive: true }); await actual.writeFile(path.join(other, '.clubhouse', 'agents.json'), JSON.stringify([agent({ name: 'PRIVATE_OTHER_PROJECT_NAME' })])); resetObservation();
  const result = readAgentConnectionCacheForDisplay(other, 'target', { receipts: [] });
  expect.soft(result).toMatchObject({ availability: 'not-loaded' }); expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|Selected cache name/); assertNoReadEffects();
});
it('refuses an inconsistent raw ID in the loaded point index without projecting another identity or retaining a receipt', async () => {
  await warm(); const selected = await getDurableConfig(project, 'target'); selected!.id = 'PRIVATE_REPLACEMENT_ID';
  const receipts: DisplayReceipt[] = [], result = read(receipts);
  expect.soft(result).toMatchObject({ availability: 'invalid' }); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_'); expect.soft(receipts).toEqual([]); assertNoReadEffects();
});
it.each(['name', 'policy', 'disposed', 'helper'] as const)('invalidates late selected %s changes through the actual loaded record, without a reader write or raw clone', async (kind) => {
  await warm(); const receipts: DisplayReceipt[] = []; expect(read(receipts).availability).toBe('loaded'); expect(receipts[0].current()).toBe(true);
  const selected = await getDurableConfig(project, 'target'); expect(selected).not.toBeNull();
  if (kind === 'name') selected!.name = 'Changed cache name';
  if (kind === 'policy') selected!.orchestration = { connectToDispatcher: false };
  if (kind === 'disposed') selected!.disposedAt = '2026-11-19T01:00:00Z';
  if (kind === 'helper') selected!.parentAgentId = 'parent';
  const fresh = read(); expect(fresh.availability).toBe('loaded');
  if (kind === 'name') expect(fresh).toMatchObject({ fields: { value: { name: { value: 'Changed cache name' } } } });
  if (kind === 'policy') expect(fresh).toMatchObject({ fields: { value: { connectToDispatcher: { value: false } } } });
  if (kind === 'disposed') expect(fresh).toMatchObject({ fields: { value: { disposed: { value: true } } } });
  if (kind === 'helper') expect(fresh).toMatchObject({ fields: { value: { helper: { value: true } } } });
  expect(receipts[0].current()).toBe(false); assertNoReadEffects();
});
it('detaches returned field objects and ignores unrelated private definition changes in its selected safe signature', async () => {
  await warm(); const receipts: DisplayReceipt[] = [], result = read(receipts); expect(result.fields?.state).toBe('ok');
  if (result.fields?.state === 'ok' && result.fields.value.name.state === 'ok') result.fields.value.name.value = 'CALLER_EDIT';
  const selected = await getDurableConfig(project, 'target'); selected!.instructions = 'PRIVATE_LATE_TEXT';
  expect.soft(read()).toMatchObject({ fields: { value: { name: { value: 'Selected cache name' } } } }); expect(receipts[0].current()).toBe(true); assertNoReadEffects();
});
it('does not copy or inspect raw private definition properties while projecting selected fields', async () => {
  await warm(); const selected = await getDurableConfig(project, 'target'); expect(selected).not.toBeNull();
  const privateRead = vi.fn(() => { throw new Error('PRIVATE_DEFINITION_MUST_NOT_BE_READ'); });
  Object.defineProperty(selected!, 'instructions', { configurable: true, enumerable: true, get: privateRead });
  const receipts: DisplayReceipt[] = [], result = read(receipts); expect.soft(result.availability).toBe('loaded'); expect.soft(privateRead).not.toHaveBeenCalled(); expect.soft(receipts).toHaveLength(1); if (receipts[0]) expect.soft(receipts[0].current()).toBe(true); assertNoReadEffects();
});
it('keeps stable selected fields current when only their observation time advances', async () => {
  await warm(); let clock = 1000; vi.spyOn(Date, 'now').mockImplementation(() => clock++);
  const receipts: DisplayReceipt[] = []; expect(read(receipts).availability).toBe('loaded'); expect(receipts[0].current()).toBe(true); expect(receipts[0].current()).toBe(true); assertNoReadEffects();
});
it('withholds a loaded index whose owner namespace was not re-established after a real cache-clear commit race', async () => {
  await warm(); expect(read().availability).toBe('loaded');
  // Real owner API, intentional temporary-fixture write. The commit callback
  // retires the original cache; writeAgents then creates an index without the
  // old directory identity. Presence alone must not certify its namespace.
  await updateDurableConfig(project, 'target', { orchestrator: 'codex-cli' }, async () => { clearAgentConfigCache(project); });
  await flushAgentConfig(project); await new Promise<void>((resolve) => setImmediate(resolve));
  expect(peekCachedDurableConfig(project, 'target')).toMatchObject({ id: 'target', name: 'Selected cache name', orchestrator: 'codex-cli' }); resetObservation();
  const receipts: DisplayReceipt[] = [], result = read(receipts);
  expect.soft(result).toMatchObject({ availability: 'namespace-unconfirmed' }); expect.soft(result.fields).toBeUndefined(); expect.soft(receipts).toEqual([]); assertNoReadEffects();
});
it('invalidates a cleared/reloaded cache even when ID and all projected fields are reused', async () => {
  await warm(); const receipts: DisplayReceipt[] = []; const before = read(receipts); expect(before.availability).toBe('loaded'); expect(receipts[0].current()).toBe(true);
  clearAgentConfigCache(project); expect(receipts[0].current()).toBe(false); await warm();
  const after = read(); expect(after).toMatchObject({ availability: 'loaded', fields: { value: { name: { value: 'Selected cache name' } } } }); expect(receipts[0].current()).toBe(false); assertNoReadEffects();
});
it('invalidates actual same-cache agent replacement after a refused same-provider persistence rollback', async () => {
  await warm(); const receipts: DisplayReceipt[] = []; expect(read(receipts).availability).toBe('loaded'); const before = await getDurableConfig(project, 'target'); expect(receipts[0].current()).toBe(true);
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  let refused = 0;
  vi.mocked(fsp.rename).mockImplementation(async (from, to) => { if (String(to) === file()) { refused++; throw Object.assign(new Error('Intentional fixture rename refusal'), { code: 'EROFS' }); } return actual.rename(from, to); });
  // Change a non-displayed setting with the same provider. Telemetry executes
  // its real operation callback; the rename refusal must actually be reached.
  await expect(updateDurableConfig(project, 'target', { orchestrator: 'codex-cli', model: 'fixture-other-model' }, async () => {})).rejects.toThrow('Intentional fixture rename refusal');
  expect(refused).toBe(1);
  const after = await getDurableConfig(project, 'target'); expect(after).not.toBe(before); expect(after?.orchestrator).toBe(before?.orchestrator); expect(after?.name).toBe(before?.name);
  resetObservation(); expect(read()).toMatchObject({ availability: 'loaded', fields: { value: { name: { value: 'Selected cache name' } } } }); expect(receipts[0].current()).toBe(false); assertNoReadEffects();
});
it.each([['', 'target'], ['relative-root', 'target'], ['/host/project', 'x'.repeat(201)], ['/host/project', '']])('rejects invalid point admission without I/O or retaining a receipt: %j', (projectPath, id) => {
  const receipts: DisplayReceipt[] = []; expect(readAgentConnectionCacheForDisplay(projectPath, id, { receipts })).toMatchObject({ availability: 'invalid' }); expect.soft(receipts).toEqual([]); assertNoReadEffects();
});
it('matches a private admitted root namespace before projecting fields without adding cache I/O', async () => {
  await warm(); const actual = await vi.importActual<typeof import('fs')>('fs'); const stat = actual.statSync(project, { bigint: true });
  const expectedProjectNamespace = `ino:${stat.dev}:${stat.ino}`, receipts: DisplayReceipt[] = []; resetObservation();
  const result = readAgentConnectionCacheForDisplay(project, 'target', { receipts, expectedProjectNamespace });
  expect(result).toMatchObject({ availability: 'loaded', fields: { value: { name: { value: 'Selected cache name' } } } });
  expect.soft(JSON.stringify(result)).not.toContain(expectedProjectNamespace); expect.soft(JSON.stringify(receipts)).toBe('[{}]'); expect(receipts[0].current()).toBe(true); assertNoReadEffects();
});
it('withholds a private mismatched admitted namespace without returning fields or a cache receipt', async () => {
  await warm(); const receipts: DisplayReceipt[] = []; const result = readAgentConnectionCacheForDisplay(project, 'target', { receipts, expectedProjectNamespace: 'ino:1:999999999999999999' });
  expect.soft(result).toMatchObject({ availability: 'namespace-unconfirmed' }); expect.soft(result.fields).toBeUndefined(); expect.soft(receipts).toEqual([]); assertNoReadEffects();
});
it.each([['empty', ''], ['overlong', 'x'.repeat(8193)], ['null', null], ['number', 7]] as const)('bounds private expected namespaces before cache lookup: %s', (_label, expected) => {
  const receipts: DisplayReceipt[] = [], result = readAgentConnectionCacheForDisplay(project, 'target', { receipts, expectedProjectNamespace: expected as string });
  expect.soft(result).toMatchObject({ availability: 'invalid' }); expect.soft(receipts).toEqual([]); assertNoReadEffects();
});
it('checks admitted namespace before reading any selected cached display field', async () => {
  await warm(); const selected = await getDurableConfig(project, 'target'); expect(selected).not.toBeNull();
  const fieldRead = vi.fn(() => 'PRIVATE_PRIOR_NAMESPACE_NAME'); Object.defineProperty(selected!, 'name', { configurable: true, enumerable: true, get: fieldRead });
  const receipts: DisplayReceipt[] = [], result = readAgentConnectionCacheForDisplay(project, 'target', { receipts, expectedProjectNamespace: 'ino:1:999999999999999999' });
  expect.soft(result).toMatchObject({ availability: 'namespace-unconfirmed' }); expect.soft(result.fields).toBeUndefined(); expect.soft(receipts).toEqual([]); expect.soft(fieldRead).not.toHaveBeenCalled(); assertNoReadEffects();
});
