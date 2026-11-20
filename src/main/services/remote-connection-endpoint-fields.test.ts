import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
const m = vi.hoisted(() => ({ home: '', external: vi.fn(() => { throw new Error('Display must not enter external services.'); }) }));
vi.mock('electron', () => ({ app: { getPath: () => m.home, isPackaged: false, on: vi.fn(), once: vi.fn() } }));
vi.mock('child_process', () => ({ exec: m.external, execSync: m.external, execFile: m.external, execFileSync: m.external, spawn: m.external }));
vi.mock('./actions/details-names', () => ({ actionDetailsNames: () => ({ names: { agent: m.external }, notices: () => [] }) }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: () => null, getDispatcherChatAgentId: () => null, isDispatcherIdentityAgentId: () => false, getDispatcherState: m.external, onDispatcherChanged: vi.fn() }));
vi.mock('./dispatcher/dispatcher-settings', () => ({ readDispatcherEnablementForDisplay: () => ({ enabled: { state: 'ok', value: true, inputs: [] }, reason: { state: 'ok', value: null, inputs: [] } }) }));
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
import { getBaseDirPath } from './base-dir';
import { readPassiveConnectionCard } from './remote-connection-card';
import { card } from './remote-details-presentation';
import { captureReadOnlyAgentTargetWitness } from './read-only-agent-target-witness';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { _resetPersistedBindingSourcesForTesting } from './persisted-bindings';
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
afterEach(async () => { bindingManager._resetForTesting(); _resetPersistedBindingSourcesForTesting(); clearAgentConfigCache(); await fsp.rm(root, { recursive: true, force: true }); });

it.each(['saved-and-memory', 'cold-cache', 'changed-directory', 'cache-late', 'dispatcher-inapplicable', 'helper-inapplicable'] as const)('integrates real selected source, primary and owner cache fields into a read-only Connections card: %s', async (kind) => {
  bindingManager._resetForTesting(); _resetPersistedBindingSourcesForTesting();
  const selectedProject = path.join(root, 'selected'); await fsp.mkdir(path.join(selectedProject, '.clubhouse'), { recursive: true });
  const selected = { ...agent(), id: 'selected', name: 'Selected', ...(kind === 'helper-inapplicable' ? { parentAgentId: 'parent' } : {}) }, selectedRecord = { id: 's', name: 'Selected project', path: selectedProject };
  await fsp.writeFile(path.join(selectedProject, '.clubhouse', 'agents.json'), JSON.stringify([selected]));
  await fsp.mkdir(getBaseDirPath()); await fsp.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [selectedRecord, { id: 't', name: 'Target project', path: project }] }));
  await fsp.writeFile(path.join(getBaseDirPath(), 'dispatcher-connections.json'), JSON.stringify({ version: 1, connections: [{ agentId: 'selected', targetId: 'target', agentProjectPath: selectedProject, targetProjectPath: project, createdBy: 'selected', createdAt: '2026-11-19T00:00:00Z' }], removedByUser: [] }));
  if (kind !== 'cold-cache') await warm();
  if (kind === 'saved-and-memory') (await getDurableConfig(project, 'target'))!.name = 'Host accepted custom name';
  if (kind === 'changed-directory') { const actual = await vi.importActual<typeof import('fs')>('fs'); actual.renameSync(project, project + '-retired'); actual.mkdirSync(path.join(project, '.clubhouse'), { recursive: true }); actual.writeFileSync(file(), JSON.stringify([agent({ name: 'New registered primary' })])); }
  const target = captureReadOnlyAgentTargetWitness({ agent: selected, project: selectedRecord }); expect(target.current()).toBe(true);
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  const snapshot = async (folder = root): Promise<unknown> => Object.fromEntries(await Promise.all((await actual.readdir(folder)).sort().map(async (name) => { const child = path.join(folder, name), stat = await actual.stat(child); return [name, stat.isDirectory() ? { ino: stat.ino, children: await snapshot(child) } : { ino: stat.ino, mtimeMs: stat.mtimeMs, bytes: (await actual.readFile(child)).toString('base64') }]; })));
  const before = await snapshot(); resetObservation(); const c = card('connections', 'Connections'), receipts: DisplayReceipt[] = [];
  const source = await import('./dispatcher-endpoint-associations-display'), sourceRead = vi.spyOn(source, 'readSavedDispatcherEndpointMetadataForDisplay'), cacheRead = vi.fn(readAgentConnectionCacheForDisplay);
  try { await readPassiveConnectionCard(c, 'selected', { receipts, authorized: () => true, projectPath: selectedProject, name: 'Selected', dispatcher: kind === 'dispatcher-inapplicable', family: kind === 'helper-inapplicable' ? { parentId: 'parent', helperIds: new Set() } : undefined, endpoint: { target, readCache: cacheRead } }); }
  finally { sourceRead.mockRestore(); }
  if (kind === 'dispatcher-inapplicable' || kind === 'helper-inapplicable') {
    expect.soft(cacheRead).not.toHaveBeenCalled(); expect.soft(JSON.stringify(c)).not.toMatch(/Selected cache name|saved target|host memory target/); expect.soft(await snapshot()).toEqual(before); expect.soft(m.external).not.toHaveBeenCalled(); return;
  }
  const label = kind === 'changed-directory' ? 'New registered primary' : kind === 'saved-and-memory' ? 'Host accepted custom name' : 'Selected cache name';
  expect(c.rows.some((r) => r.label === label)).toBe(true); expect(c.rows.find((r) => r.label === label + ' saved target')?.value).toContain(kind === 'changed-directory' ? 'New registered primary' : 'Selected cache name');
  const memory = c.rows.find((r) => r.label === label + ' host memory target')?.value;
  expect.soft(memory).toContain(kind === 'saved-and-memory' ? 'Host accepted custom name' : kind === 'cold-cache' ? 'Host memory not loaded' : kind === 'cache-late' ? 'Selected cache name' : 'Host memory project association unconfirmed');
  expect.soft(JSON.stringify(c)).not.toMatch(/PRIVATE_|expectedProjectNamespace|rootNamespace|agentProjectPath|targetProjectPath|"current"/); expect.soft(JSON.stringify(c)).not.toContain(root); expect.soft(c.notes.join(' ')).toContain('do not confirm that this link works now');
  expect(receipts.every((r) => r.current())).toBe(true); if (kind === 'cache-late') { (await getDurableConfig(project, 'target'))!.name = 'Changed after card read'; expect(receipts.some((r) => !r.current())).toBe(true); } expect.soft(m.external).not.toHaveBeenCalled();
  expect.soft(await snapshot()).toEqual(before);
  for (const fn of [fsp.writeFile, fsp.rename, fsp.mkdir, fs.watch]) expect.soft(fn).not.toHaveBeenCalled();
});
