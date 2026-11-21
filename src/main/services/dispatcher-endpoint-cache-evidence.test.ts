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
import { clearAgentConfigCache, initializeDurableProject, getDurableConfig, peekCachedDurableConfig, readAgentConnectionCacheForDisplay } from './agent-config';
import type { DisplayReceipt } from './display-settings';
import { getBaseDirPath } from './base-dir';
import { readSavedDispatcherEndpointMetadataForDisplay } from './dispatcher-endpoint-associations-display';
let root: string, project: string, selectedProject: string, otherProject: string;
const file = () => path.join(project, '.clubhouse', 'agents.json');
const agent = (extra = {}) => ({ id: 'target', name: 'Selected cache name', color: 'blue', createdAt: '2026-11-19T00:00:00Z', orchestrator: 'codex-cli', orchestration: { connectToDispatcher: true }, instructions: 'PRIVATE_INSTRUCTIONS', env: { token: 'PRIVATE_CREDENTIAL' }, ...extra });
const io = () => [fsp.readFile, fsp.writeFile, fsp.stat, fsp.rename, fsp.mkdir, fs.openSync, fs.readFileSync, fs.lstatSync, fs.existsSync, fs.watch];
const resetObservation = () => { for (const fn of io()) vi.mocked(fn).mockClear(); m.external.mockClear(); };
const assertNoReadEffects = () => { for (const fn of io()) expect.soft(fn).not.toHaveBeenCalled(); expect.soft(m.external).not.toHaveBeenCalled(); };
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
it.each(['registered-project-removed', 'endpoint-primary-removed'] as const)('SCOPT1 refuses the next root cache lookup after earlier work changes its %s admission evidence', async (kind) => {
  await warm(); await warmSecond();
  const pairs = [pair(), pair('other')], admitted: DisplayReceipt[] = [];
  const initial = query(readAgentConnectionCacheForDisplay, admitted, pairs);
  expect(initial).toMatchObject({ state: 'ok', value: { rows: [
    { endpoint: { value: { record: 'registered-primary' } }, hostCache: { value: { availability: 'loaded' } } },
    { endpoint: { value: { record: 'registered-primary' } }, hostCache: { value: { availability: 'loaded' } } },
  ] } });
  expect(admitted.every((r) => r.current())).toBe(true);
  const sourceBefore = fs.readFileSync(source(), 'utf8'), calls: string[] = [];
  const reader: typeof readAgentConnectionCacheForDisplay = (folder, id, options) => {
    const result = readAgentConnectionCacheForDisplay(folder, id, options); expect(result.availability).toBe('loaded'); calls.push(id);
    if (id === 'target') {
      if (kind === 'registered-project-removed') fs.writeFileSync(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 's', name: 'Selected', path: selectedProject }, { id: 't', name: 'Target', path: project }] }));
      else fs.unlinkSync(path.join(otherProject, '.clubhouse', 'agents.json'));
    }
    return result;
  };
  const result = query(reader, [], pairs);
  expect(m.selected).toBe(true); expect(fs.readFileSync(source(), 'utf8')).toBe(sourceBefore);
  if (kind === 'registered-project-removed') expect(JSON.parse(fs.readFileSync(path.join(getBaseDirPath(), 'projects.json'), 'utf8')).projects.some((p: { path: string }) => p.path === otherProject)).toBe(false);
  else expect(fs.existsSync(path.join(otherProject, '.clubhouse', 'agents.json'))).toBe(false);
  expect(result).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect(JSON.stringify(result)).not.toMatch(/Selected cache name|Other host name/);
  expect.soft(calls).not.toContain('other'); expect.soft(calls).toEqual(['target']);
});
it('rechecks only the relevant next primary while preserving final refusal for a changed earlier primary', async () => {
  await warm(); await warmSecond(); const pairs = [pair(), pair('other')], calls: string[] = [];
  expect(query(readAgentConnectionCacheForDisplay, [], pairs)).toMatchObject({ state: 'ok', value: { rows: [{ hostCache: { value: { availability: 'loaded' } } }, { hostCache: { value: { availability: 'loaded' } } }] } });
  const reader: typeof readAgentConnectionCacheForDisplay = (folder, id, options) => {
    const value = readAgentConnectionCacheForDisplay(folder, id, options); expect(value.availability).toBe('loaded'); calls.push(id);
    if (id === 'target') fs.writeFileSync(file(), JSON.stringify([agent({ name: 'Changed earlier primary' })]));
    return value;
  };
  const result = query(reader, [], pairs); expect.soft(calls).toEqual(['target', 'other']); expect.soft(result).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect.soft(JSON.stringify(result)).not.toMatch(/Selected cache name|Other host name/);
});
it('keeps two distinct unchanged project roots useful with the actual passive owner getter', async () => {
  await warm(); await warmSecond(); const reader = vi.fn(readAgentConnectionCacheForDisplay), receipts: DisplayReceipt[] = [];
  expect(query(reader, receipts, [pair(), pair('other')])).toMatchObject({ state: 'ok', value: { rows: [
    { endpoint: { value: { fields: { name: { value: 'Selected cache name' } } } }, hostCache: { value: { availability: 'loaded' } } },
    { endpoint: { value: { fields: { name: { value: 'Other host name' } } } }, hostCache: { value: { availability: 'loaded' } } },
  ] } });
  expect.soft(reader.mock.calls.map((call) => call.slice(0, 2))).toEqual([[project, 'target'], [otherProject, 'other']]); expect(receipts.every((r) => r.current())).toBe(true); noWrites();
});
it('requires admitted directory association before adopting cached fields after a real same-path project replacement', async () => {
  await warm(); const original = fs.statSync(project, { bigint: true });
  expect(peekCachedDurableConfig(project, 'target')).toMatchObject({ name: 'Selected cache name' });
  // Intentional temporary-fixture directory replacement. The ordinary owner
  // cache is left warm; this is a new admission requirement discriminator,
  // not a claim that its host-memory-only contract promised physical identity.
  fs.renameSync(project, project + '-retired'); fs.mkdirSync(path.join(project, '.clubhouse'), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify([agent({ name: 'Expected replacement primary' })]));
  const replacement = fs.statSync(project, { bigint: true });
  expect(`${replacement.dev}:${replacement.ino}`).not.toBe(`${original.dev}:${original.ino}`);
  expect(peekCachedDurableConfig(project, 'target')).toMatchObject({ name: 'Selected cache name' });
  const receipts: DisplayReceipt[] = [], result = query(readAgentConnectionCacheForDisplay, receipts);
  expect(result).toMatchObject({ state: 'ok', value: { rows: [{ endpoint: { value: { record: 'registered-primary', fields: { name: { value: 'Expected replacement primary' } } } } }] } });
  expect(receipts.every((r) => r.current())).toBe(true);
  if (result.state !== 'ok') return;
  expect.soft(result.value.rows[0].hostCache).toMatchObject({ state: 'ok', value: { availability: 'namespace-unconfirmed' } });
  expect.soft(JSON.stringify(result.value.rows[0].hostCache)).not.toContain('Selected cache name');
});
it('preserves primary fields but avoids cache adoption when the held root cannot supply a usable inode tuple', async () => {
  await warm(); const actual = await vi.importActual<typeof import('fs')>('fs');
  // Model a host lacking a usable inode. Real primary parser/descriptor IO is
  // retained; only root lstat identity is unavailable in this fixture.
  vi.mocked(fs.lstatSync).mockImplementation(((...args: Parameters<typeof actual.lstatSync>) => {
    const stats = actual.lstatSync(...args);
    return String(args[0]) === project && args[1] && typeof args[1] === 'object' && args[1].bigint
      ? new Proxy(stats, { get: (target, key, receiver) => key === 'ino' ? 0n : Reflect.get(target, key, receiver) }) : stats;
  }) as typeof fs.lstatSync);
  try {
    const reader = vi.fn(readAgentConnectionCacheForDisplay), result = query(reader);
    expect(result).toMatchObject({ state: 'ok', value: { rows: [{ endpoint: { value: { record: 'registered-primary', fields: { name: { value: 'Selected cache name' } } } } }] } });
    if (result.state !== 'ok') return;
    expect.soft(result.value.rows[0].hostCache).toMatchObject({ state: 'unavailable', reason: 'unreadable' }); expect.soft(reader).not.toHaveBeenCalled(); noWrites();
  } finally { vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync); }
});
it('withholds cache evidence if a later read replaces an earlier admitted directory before final assembly', async () => {
  await warm(); await warmSecond(); let calls = 0;
  const reader: typeof readAgentConnectionCacheForDisplay = (folder, id, options) => {
    const result = readAgentConnectionCacheForDisplay(folder, id, options); expect(result.availability).toBe('loaded'); calls++;
    if (calls === 2) { const prior = fs.statSync(project, { bigint: true }); fs.renameSync(project, project + '-retired'); fs.mkdirSync(path.join(project, '.clubhouse'), { recursive: true }); fs.writeFileSync(file(), JSON.stringify([agent()])); const after = fs.statSync(project, { bigint: true }); expect(`${after.dev}:${after.ino}`).not.toBe(`${prior.dev}:${prior.ino}`); }
    return result;
  };
  const result = query(reader, [], [pair(), pair('other')]); expect(calls).toBe(2);
  expect.soft(result).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect.soft(JSON.stringify(result)).not.toMatch(/Selected cache name|Other host name/);
});

it.each(['registered', 'unregistered', 'wrong-selected', 'prefilled'] as const)('exports private endpoint project identity only after admitted current primary evidence: %s', async (mode) => {
  if (mode === 'unregistered') await fsp.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
  if (mode === 'wrong-selected') await putLinks([link({ agentProjectPath: otherProject })]);
  const projects = new Map<string, string>(mode === 'prefilled' ? [['not-a-pair', 'PRIVATE_UNADMITTED_PATH']] : []), receipts: DisplayReceipt[] = [], before = await disk(); resetObservation();
  const result = readSavedDispatcherEndpointMetadataForDisplay({ agentId: 'selected', projectPath: selectedProject, target: { current: () => m.selected } }, [pair()], { receipts, readLoadedCache: readAgentConnectionCacheForDisplay, endpointProjects: projects });
  if (mode === 'registered') { expect(result).toMatchObject({ state: 'ok', value: { rows: [{ endpoint: { value: { record: 'registered-primary' } } }] } }); expect.soft([...projects]).toEqual([['selected\0target', project]]); expect(receipts.every((r) => r.current())).toBe(true); m.selected = false; expect.soft(receipts.some((r) => !r.current())).toBe(true); }
  else if (mode === 'prefilled') { expect.soft(result).toMatchObject({ state: 'unavailable', reason: 'invalid' }); assertNoReadEffects(); }
  else expect.soft(projects.size).toBe(0);
  expect.soft(JSON.stringify(result)).not.toContain(root); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_'); noWrites(); expect.soft(await disk()).toEqual(before);
});
