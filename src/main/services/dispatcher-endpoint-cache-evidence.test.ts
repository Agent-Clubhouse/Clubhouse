import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
const m = vi.hoisted(() => ({ home: '', selected: true, external: vi.fn(() => { throw new Error('Display must not enter external services.'); }) }));
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
  openSync: vi.fn(actual.openSync), readFileSync: vi.fn(actual.readFileSync), lstatSync: vi.fn(actual.lstatSync), existsSync: vi.fn(actual.existsSync),
  watch: vi.fn(() => { const watcher = { on: vi.fn(() => watcher), close: vi.fn() }; return watcher; }),
}; });
vi.mock('fs/promises', async (original) => { const actual = await original<typeof import('fs/promises')>(); return { ...actual,
  readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile), stat: vi.fn(actual.stat), rename: vi.fn(actual.rename), mkdir: vi.fn(actual.mkdir),
}; });
import { clearAgentConfigCache, initializeDurableProject, getDurableConfig, peekCachedDurableConfig, readAgentConnectionCacheForDisplay, updateDurableConfig, flushAgentConfig } from './agent-config';
import type { DisplayReceipt } from './display-settings';
import { getBaseDirPath } from './base-dir';
import { readSavedDispatcherEndpointMetadataForDisplay } from './dispatcher-endpoint-associations-display';
let root: string, project: string, selectedProject: string, otherProject: string;
const file = () => path.join(project, '.clubhouse', 'agents.json');
const agent = (extra = {}) => ({ id: 'target', name: 'Selected cache name', color: 'blue', createdAt: '2026-11-19T00:00:00Z', orchestrator: 'codex-cli', orchestration: { connectToDispatcher: true }, instructions: 'PRIVATE_INSTRUCTIONS', env: { token: 'PRIVATE_CREDENTIAL' }, ...extra });
const io = () => [fsp.readFile, fsp.writeFile, fsp.stat, fsp.rename, fsp.mkdir, fs.openSync, fs.readFileSync, fs.lstatSync, fs.existsSync, fs.watch];
const resetObservation = () => { for (const fn of io()) vi.mocked(fn).mockClear(); m.external.mockClear(); };
const assertNoReadEffects = () => { for (const fn of io()) expect.soft(fn).not.toHaveBeenCalled(); expect.soft(m.external).not.toHaveBeenCalled(); };
const read = (receipts: DisplayReceipt[] = []) => readAgentConnectionCacheForDisplay(project, 'target', { receipts });
const warm = async () => { await initializeDurableProject(project); await new Promise<void>((resolve) => setImmediate(resolve)); resetObservation(); };
beforeEach(async () => {
  m.selected = true; clearAgentConfigCache(); const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises'); vi.mocked(fsp.rename).mockImplementation(actual.rename);
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-agent-cache-display-'))); m.home = root; project = path.join(root, 'project');
  await fsp.mkdir(path.join(project, '.clubhouse'), { recursive: true }); await fsp.writeFile(file(), JSON.stringify([agent()]));
  selectedProject = path.join(root, 'selected'); otherProject = path.join(root, 'other');
  for (const folder of [selectedProject, otherProject]) await fsp.mkdir(path.join(folder, '.clubhouse'), { recursive: true });
  await fsp.mkdir(getBaseDirPath());
  await fsp.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 's', name: 'Selected', path: selectedProject }, { id: 't', name: 'Target', path: project }, { id: 'o', name: 'Other', path: otherProject }] }));
  await fsp.writeFile(path.join(otherProject, '.clubhouse', 'agents.json'), JSON.stringify([agent({ id: 'other', name: 'Other host name' })]));
  await putLinks([link()]); resetObservation();
});
afterEach(async () => { clearAgentConfigCache(); await fsp.rm(root, { recursive: true, force: true }); });

const pair = (targetId = 'target') => ({ agentId: 'selected', targetId });
const link = (extra = {}) => ({ ...pair(), agentProjectPath: selectedProject, targetProjectPath: project, createdBy: 'selected', createdAt: '2026-11-19T00:00:00Z', ...extra });
const source = () => path.join(getBaseDirPath(), 'dispatcher-connections.json');
const putLinks = (links: unknown[]) => fsp.writeFile(source(), JSON.stringify({ version: 1, connections: links, removedByUser: [] }));
const query = (reader = readAgentConnectionCacheForDisplay, receipts: DisplayReceipt[] = [], pairs = [pair()]) => readSavedDispatcherEndpointMetadataForDisplay({ agentId: 'selected', projectPath: selectedProject, target: { current: () => m.selected } }, pairs, { receipts, readLoadedCache: reader });
const noWrites = () => { for (const fn of [fsp.writeFile, fsp.rename, fsp.mkdir, fs.watch]) expect.soft(fn).not.toHaveBeenCalled(); expect.soft(m.external).not.toHaveBeenCalled(); };
const disk = async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises'), out: Record<string, string> = {};
  const visit = async (folder: string) => { for (const entry of await actual.readdir(folder, { withFileTypes: true })) { const name = path.join(folder, entry.name); if (entry.isDirectory()) await visit(name); else if (entry.isFile()) out[path.relative(root, name)] = (await actual.readFile(name)).toString('base64'); } };
  await visit(root); return out;
};
it('retains distinct saved and exact-project host-cache fields using the real owner getter without reader writes', async () => {
  await warm(); const selected = await getDurableConfig(project, 'target'); selected!.name = 'Accepted host-memory name';
  const before = await disk(); resetObservation(); const reader = vi.fn(readAgentConnectionCacheForDisplay), receipts: DisplayReceipt[] = [], result = query(reader, receipts);
  expect(result).toMatchObject({ state: 'ok', value: { rows: [{ relationship: 'recorded', endpoint: { value: { record: 'registered-primary', fields: { name: { value: 'Selected cache name', inputs: [{ source: 'primary' }] } } } }, hostCache: { state: 'ok', inputs: [{ source: 'host-cache' }], value: { availability: 'loaded', fields: { value: { name: { value: 'Accepted host-memory name', inputs: [{ source: 'host-cache' }] } } } } } }] } });
  expect.soft(reader).toHaveBeenCalledTimes(1); expect.soft(reader.mock.calls[0]?.slice(0, 2)).toEqual([project, 'target']);
  expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|projectPath|current|namespace|runtime|permission/); expect.soft(JSON.stringify(result)).not.toContain(root); expect.soft(JSON.stringify(receipts)).toBe('[{},{},{}]');
  expect(receipts.every((r) => r.current())).toBe(true); noWrites(); expect.soft(await disk()).toEqual(before);
});
it('keeps readable cold host-cache evidence not-loaded rather than warming the owner or implying disk absence', async () => {
  const before = await disk(); resetObservation(); const receipts: DisplayReceipt[] = [], result = query(readAgentConnectionCacheForDisplay, receipts);
  expect(result).toMatchObject({ state: 'ok', value: { rows: [{ endpoint: { value: { record: 'registered-primary' } }, hostCache: { value: { scope: 'host-session-cache', availability: 'not-loaded' } } }] } });
  expect.soft(peekCachedDurableConfig(project, 'target')).toBeNull(); noWrites(); expect.soft(await disk()).toEqual(before); expect(receipts.every((r) => r.current())).toBe(true);
});
it.each(['unregistered', 'corrupt-registry', 'corrupt-primary', 'backup-only', 'absent-id', 'wrong-selected-project'] as const)('never borrows warm native-ID fields for %s source/primary evidence', async (kind) => {
  await warm(); const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  if (kind === 'unregistered') await actual.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
  if (kind === 'corrupt-registry') await actual.writeFile(path.join(getBaseDirPath(), 'projects.json'), '{broken');
  if (kind === 'corrupt-primary') await actual.writeFile(file(), '{broken');
  if (kind === 'backup-only') await actual.rename(file(), file() + '.bak');
  if (kind === 'absent-id') await actual.writeFile(file(), '[]');
  if (kind === 'wrong-selected-project') await putLinks([link({ agentProjectPath: otherProject })]);
  const before = await disk(); resetObservation(); const reader = vi.fn(readAgentConnectionCacheForDisplay), result = query(reader);
  expect.soft(reader).not.toHaveBeenCalled(); expect.soft(JSON.stringify(result)).not.toMatch(/Selected cache name|hostCache/); noWrites(); expect.soft(await disk()).toEqual(before);
});
it.each(['cache-field', 'cache-reload', 'source-path', 'primary', 'registry', 'selected-role'] as const)('retains private real selected %s evidence after helper return', async (kind) => {
  await warm(); const receipts: DisplayReceipt[] = []; expect(query(readAgentConnectionCacheForDisplay, receipts)).toMatchObject({ state: 'ok', value: { rows: [{ hostCache: { value: { availability: 'loaded' } } }] } }); expect(receipts.every((r) => r.current())).toBe(true);
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  if (kind === 'cache-field') (await getDurableConfig(project, 'target'))!.name = 'Changed host memory';
  if (kind === 'cache-reload') { clearAgentConfigCache(project); await warm(); }
  if (kind === 'source-path') await putLinks([link({ targetProjectPath: otherProject })]);
  if (kind === 'primary') await actual.writeFile(file(), JSON.stringify([agent({ name: 'Changed primary' })]));
  if (kind === 'registry') await actual.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
  if (kind === 'selected-role') m.selected = false;
  expect(receipts.every((r) => r.current())).toBe(false);
});
it('keeps a failed cache read unavailable without erasing independently verified saved fields', async () => {
  const reader = vi.fn(() => { throw new Error('Controlled cache failure'); });
  expect(query(reader)).toMatchObject({ state: 'ok', value: { rows: [{ endpoint: { value: { record: 'registered-primary', fields: { name: { value: 'Selected cache name' } } } }, hostCache: { state: 'unavailable', reason: 'unreadable' } }] } }); expect(reader).toHaveBeenCalledTimes(1);
});
it('does not change the saved-only default contract when no cache getter is supplied', async () => {
  await warm(); const result = readSavedDispatcherEndpointMetadataForDisplay({ agentId: 'selected', projectPath: selectedProject, target: { current: () => true } }, [pair()], { receipts: [] });
  expect(result).toMatchObject({ state: 'ok', value: { rows: [{ endpoint: { value: { record: 'registered-primary' } } }] } }); expect.soft(JSON.stringify(result)).not.toContain('hostCache');
});
const warmSecond = async () => { await initializeDurableProject(otherProject); await new Promise<void>((resolve) => setImmediate(resolve)); await putLinks([link(), link({ targetId: 'other', targetProjectPath: otherProject })]); resetObservation(); };
it.each(['cache-record', 'primary', 'source-path', 'registry', 'selected-role'] as const)('withholds all assembled fields if an earlier %s changes during a later real owner cache read', async (kind) => {
  await warm(); await warmSecond(); let calls = 0;
  const reader: typeof readAgentConnectionCacheForDisplay = (folder, id, options) => {
    const value = readAgentConnectionCacheForDisplay(folder, id, options); calls++;
    if (calls === 2) {
      if (kind === 'cache-record') clearAgentConfigCache(project);
      if (kind === 'primary') fs.writeFileSync(file(), JSON.stringify([agent({ name: 'Changed during later read' })]));
      if (kind === 'source-path') fs.writeFileSync(source(), JSON.stringify({ version: 1, connections: [link({ targetProjectPath: otherProject }), link({ targetId: 'other', targetProjectPath: otherProject })] }));
      if (kind === 'registry') fs.writeFileSync(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
      if (kind === 'selected-role') m.selected = false;
    }
    return value;
  };
  const result = query(reader, [], [pair(), pair('other')]); expect(calls).toBe(2); expect.soft(result).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect.soft(JSON.stringify(result)).not.toMatch(/Selected cache name|Other host name/);
});
it('rechecks the exact saved association freshly between cache project groups', async () => {
  await warm(); await warmSecond(); let calls = 0;
  const reader: typeof readAgentConnectionCacheForDisplay = (folder, id, options) => { const value = readAgentConnectionCacheForDisplay(folder, id, options); calls++; if (calls === 1) fs.writeFileSync(source(), JSON.stringify({ version: 1, connections: [link({ targetProjectPath: otherProject }), link({ targetId: 'other', targetProjectPath: otherProject })] })); return value; };
  const result = query(reader, [], [pair(), pair('other')]); expect.soft(calls).toBe(1); expect.soft(result).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect.soft(JSON.stringify(result)).not.toContain('Other host name');
});
it('refuses an already invalid selected target before any cache lookup or source-file access', () => {
  m.selected = false; const reader = vi.fn(readAgentConnectionCacheForDisplay); expect(query(reader)).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect.soft(reader).not.toHaveBeenCalled(); assertNoReadEffects();
});
it('checks shared source identity per cache project phase rather than once for every selected record', async () => {
  const targets = Array.from({ length: 20 }, (_, i) => `target-${i}`);
  await fsp.writeFile(file(), JSON.stringify(targets.map((id) => agent({ id }))));
  await putLinks(targets.map((targetId) => link({ targetId }))); await warm();
  const before = await disk(); resetObservation(); const reader = vi.fn(readAgentConnectionCacheForDisplay), result = query(reader, [], targets.map((id) => pair(id)));
  expect(result.state).toBe('ok'); if (result.state !== 'ok') return;
  expect(result.value.rows).toHaveLength(20); expect(result.value.rows.every((row) => row.hostCache?.state === 'ok' && row.hostCache.value.availability === 'loaded')).toBe(true); expect(reader).toHaveBeenCalledTimes(20);
  const sourceOpens = vi.mocked(fs.openSync).mock.calls.filter((args) => String(args[0]) === source()).length;
  expect.soft(sourceOpens).toBeLessThanOrEqual(12); noWrites(); expect.soft(await disk()).toEqual(before);
});
it('does not expand the saved metadata root cap when an optional host-cache getter is installed', async () => {
  const projects = [selectedProject], pairs = [], links = [];
  for (let i = 0; i < 17; i++) {
    const folder = path.join(root, `bounded-${i}`), id = `target-${i}`; projects.push(folder); pairs.push(pair(id)); links.push(link({ targetId: id, targetProjectPath: folder }));
    await fsp.mkdir(path.join(folder, '.clubhouse'), { recursive: true }); await fsp.writeFile(path.join(folder, '.clubhouse', 'agents.json'), JSON.stringify([agent({ id })])); await initializeDurableProject(folder);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  await fsp.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: projects.map((folder, i) => ({ id: `p-${i}`, name: `P${i}`, path: folder })) })); await putLinks(links); resetObservation();
  const reader = vi.fn(readAgentConnectionCacheForDisplay), result = query(reader, [], pairs); expect(result.state).toBe('ok'); if (result.state !== 'ok') return;
  expect(result.value.rows.slice(0, 16).every((row) => row.hostCache?.state === 'ok' && row.hostCache.value.availability === 'loaded')).toBe(true);
  expect.soft(result.value.rows[16]).toMatchObject({ endpoint: { state: 'unavailable', reason: 'limit' } }); expect.soft(result.value.rows[16].hostCache).toBeUndefined(); expect.soft(reader).toHaveBeenCalledTimes(16); noWrites();
});
it('keeps excessive selected pair admission ahead of source reads and optional cache callbacks', () => {
  const reader = vi.fn(readAgentConnectionCacheForDisplay), result = query(reader, [], Array.from({ length: 51 }, (_, i) => pair(`target-${i}`)));
  expect(result).toMatchObject({ state: 'unavailable', reason: 'limit' }); expect.soft(reader).not.toHaveBeenCalled(); assertNoReadEffects();
});
