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
import { clearAgentConfigCache, initializeDurableProject, getDurableConfig, readAgentConnectionCacheForDisplay } from './agent-config';
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
const warm = async () => { await initializeDurableProject(project); await new Promise<void>((resolve) => setImmediate(resolve)); resetObservation(); };
beforeEach(async () => {
  clearAgentConfigCache(); const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises'); vi.mocked(fsp.rename).mockImplementation(actual.rename);
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-agent-cache-display-'))); m.home = root; project = path.join(root, 'project');
  await fsp.mkdir(path.join(project, '.clubhouse'), { recursive: true }); await fsp.writeFile(file(), JSON.stringify([agent()])); resetObservation();
});
afterEach(async () => { bindingManager._resetForTesting(); _resetPersistedBindingSourcesForTesting(); clearAgentConfigCache(); await fsp.rm(root, { recursive: true, force: true }); });

it.each(['saved-and-memory', 'cold-cache', 'changed-directory', 'cache-late', 'dispatcher-inapplicable', 'helper-inapplicable', 'revoked-before-metadata', 'bounded-page'] as const)('integrates real selected source, primary and owner cache fields into a read-only Connections card: %s', async (kind) => {
  bindingManager._resetForTesting(); _resetPersistedBindingSourcesForTesting();
  const selectedProject = path.join(root, 'selected'); await fsp.mkdir(path.join(selectedProject, '.clubhouse'), { recursive: true });
  const selected = { ...agent(), id: 'selected', name: 'Selected', ...(kind === 'helper-inapplicable' ? { parentAgentId: 'parent' } : {}) }, selectedRecord = { id: 's', name: 'Selected project', path: selectedProject };
  await fsp.writeFile(path.join(selectedProject, '.clubhouse', 'agents.json'), JSON.stringify([selected]));
  await fsp.mkdir(getBaseDirPath()); await fsp.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [selectedRecord, { id: 't', name: 'Target project', path: project }] }));
  const targets = kind === 'bounded-page' ? Array.from({ length: 30 }, (_, i) => agent({ id: 'target-' + i, name: 'Qualified target ' + i })) : [agent()];
  await fsp.writeFile(file(), JSON.stringify(targets));
  await fsp.writeFile(path.join(getBaseDirPath(), 'dispatcher-connections.json'), JSON.stringify({ version: 1, connections: targets.map((target) => ({ agentId: 'selected', targetId: target.id, agentProjectPath: selectedProject, targetProjectPath: project, createdBy: 'selected', createdAt: '2026-11-19T00:00:00Z' })), removedByUser: [] }));
  if (kind !== 'cold-cache' && kind !== 'bounded-page') await warm();
  if (kind === 'saved-and-memory') (await getDurableConfig(project, 'target'))!.name = 'Host accepted custom name';
  if (kind === 'changed-directory') { const actual = await vi.importActual<typeof import('fs')>('fs'); actual.renameSync(project, project + '-retired'); actual.mkdirSync(path.join(project, '.clubhouse'), { recursive: true }); actual.writeFileSync(file(), JSON.stringify([agent({ name: 'New registered primary' })])); }
  const target = captureReadOnlyAgentTargetWitness({ agent: selected, project: selectedRecord }); expect(target.current()).toBe(true);
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  const snapshot = async (folder = root): Promise<unknown> => Object.fromEntries(await Promise.all((await actual.readdir(folder)).sort().map(async (name) => { const child = path.join(folder, name), stat = await actual.stat(child); return [name, stat.isDirectory() ? { ino: stat.ino, children: await snapshot(child) } : { ino: stat.ino, mtimeMs: stat.mtimeMs, bytes: (await actual.readFile(child)).toString('base64') }]; })));
  const before = await snapshot(); resetObservation(); const c = card('connections', 'Connections'), receipts: DisplayReceipt[] = [];
  const source = await import('./dispatcher-endpoint-associations-display'), sourceRead = vi.spyOn(source, 'readSavedDispatcherEndpointMetadataForDisplay'), cacheRead = vi.fn(readAgentConnectionCacheForDisplay);
  let allowed = true, revoked = false; const paths = new Map<number, string>(), actualSync = await vi.importActual<typeof import('fs')>('fs');
  const opens = vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof actualSync.openSync>) => { const fd = actualSync.openSync(...args); paths.set(fd, String(args[0])); return fd; }) as typeof fs.openSync);
  const reads = vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof actualSync.readSync>) => { const n = actualSync.readSync(...args); if (kind === 'revoked-before-metadata' && !revoked && paths.get(Number(args[0])) === path.join(getBaseDirPath(), 'dispatcher-connections.json') && n > 0) { revoked = true; allowed = false; } return n; }) as typeof fs.readSync);
  let failure: unknown;
  try { await readPassiveConnectionCard(c, 'selected', { receipts, authorized: () => allowed, projectPath: selectedProject, name: 'Selected', dispatcher: kind === 'dispatcher-inapplicable', family: kind === 'helper-inapplicable' ? { parentId: 'parent', helperIds: new Set() } : undefined, endpoint: { target, readCache: cacheRead } }); if (kind === 'dispatcher-inapplicable' || kind === 'helper-inapplicable') expect.soft(sourceRead).not.toHaveBeenCalled(); }
  catch (error) { failure = error; }
  finally { sourceRead.mockRestore(); reads.mockRestore(); opens.mockRestore(); }
  if (kind === 'revoked-before-metadata') expect(failure).toEqual(new Error('revoked'));
  else expect(failure).toBeUndefined();
  if (kind === 'dispatcher-inapplicable' || kind === 'helper-inapplicable') {
    expect.soft(cacheRead).not.toHaveBeenCalled(); expect.soft(JSON.stringify(c)).not.toMatch(/Selected cache name|saved target|host memory target/); expect.soft(await snapshot()).toEqual(before); expect.soft(m.external).not.toHaveBeenCalled(); return;
  }
  if (kind === 'revoked-before-metadata') {
    expect(revoked).toBe(true); expect.soft(cacheRead).not.toHaveBeenCalled(); expect.soft([...paths.values()]).not.toContain(file()); expect.soft(JSON.stringify(c)).not.toContain('Selected cache name'); expect.soft(await snapshot()).toEqual(before); expect.soft(m.external).not.toHaveBeenCalled(); return;
  }
  if (kind === 'bounded-page') {
    expect(cacheRead).toHaveBeenCalledTimes(30); expect(receipts.every((r) => r.current())).toBe(true);
    expect.soft(c.rows).toHaveLength(100); expect.soft(c.omitted).toBe(2 + 30 * 8 - 100); // 2 host rows + 30 directions × 8 fields (saved, memory and manual source eligibility), less 100 shown.
    expect.soft(c.rows.some((r) => r.label.endsWith(' manual source eligibility'))).toBe(true);
    expect.soft(c.rows.some((r) => r.label.endsWith(' saved target'))).toBe(true); expect.soft(c.rows.some((r) => r.label.endsWith(' host memory target'))).toBe(true);
    expect.soft(JSON.stringify(c)).not.toMatch(/PRIVATE_|rootNamespace|targetProjectPath/); expect.soft(await snapshot()).toEqual(before); expect.soft(m.external).not.toHaveBeenCalled(); return;
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

it.each(['cross-project-outgoing', 'cross-project-two-way', 'matching-role-folder', 'distinct-native-ids', 'convergent-admitted-role-folder', 'cross-project-same-name', 'cross-project-native-override', 'reverse-cross-project', 'bounded-identity-page'] as const)('keeps configured controller and saved manual endpoint identities independent: %s', async (mode) => {
  const { configuredDispatcherDirections } = await import('./configured-dispatcher-directions');
  const { captureReadOnlyRoleTargetWitness } = await import('./read-only-agent-target-witness');
  const { readSavedDispatcherLinksForDisplay } = await import('./dispatcher-saved-links-display');
  const selectedProject = path.join(root, 'selected'), roleProject = path.join(root, 'dispatcher');
  for (const folder of [selectedProject, roleProject]) await fsp.mkdir(path.join(folder, '.clubhouse'), { recursive: true });
  const selected = { ...agent(), id: 'selected', name: 'Selected', orchestration: { connectToDispatcher: true } }, controller = { ...agent(), id: 'controller1', name: 'Operations' };
  const related = { ...agent(), id: mode === 'distinct-native-ids' ? 'ordinary-target' : 'controller1', name: mode === 'cross-project-same-name' ? 'Operations' : 'Project agent', orchestration: { connectToDispatcher: false } };
  const selectedRecord = { id: 's', name: 'Selected project', path: selectedProject };
  await fsp.writeFile(path.join(selectedProject, '.clubhouse', 'agents.json'), JSON.stringify([selected])); await fsp.writeFile(path.join(roleProject, '.clubhouse', 'agents.json'), JSON.stringify([controller])); await fsp.writeFile(file(), JSON.stringify([related]));
  const same = mode === 'matching-role-folder' || mode === 'convergent-admitted-role-folder', manualProject = same ? roleProject : project, manualId = same ? controller.id : related.id;
  await fsp.mkdir(getBaseDirPath(), { recursive: true }); await fsp.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [selectedRecord, { id: 'p', name: 'Manual target project', path: manualProject }] }));
  const links = [{ agentId: selected.id, targetId: manualId, agentProjectPath: selectedProject, targetProjectPath: manualProject, createdBy: selected.id, createdAt: '2026-11-19T00:00:00Z' }, ...(mode === 'cross-project-two-way' ? [{ agentId: manualId, targetId: selected.id, agentProjectPath: manualProject, targetProjectPath: selectedProject, createdBy: selected.id, createdAt: '2026-11-19T00:00:00Z' }] : [])];
  if (mode === 'reverse-cross-project') links[0] = { ...links[0], agentId: manualId, targetId: selected.id, agentProjectPath: manualProject, targetProjectPath: selectedProject };
  await fsp.writeFile(path.join(getBaseDirPath(), 'dispatcher-connections.json'), JSON.stringify({ version: 1, connections: links, removedByUser: [] }));
  if (mode === 'cross-project-native-override') await fsp.writeFile(path.join(root, 'connection-grants.json'), JSON.stringify({ version: 1, directions: [{ from: { agentId: selected.id }, to: { agentId: manualId }, disabledTools: ['read_output'], enabledTools: [], link: { createdAt: '2026-11-19T00:00:00Z' }, updatedAt: '2026-11-19T00:00:00Z' }] }));
  if (mode === 'cross-project-native-override') { const { readConnectionDirectionsForDisplay } = await import('./connection-directions-display'); expect(readConnectionDirectionsForDisplay(selected.id)).toMatchObject({ state: 'ok', value: { total: 1, rows: [{ disabledTools: { state: 'ok', value: ['read_output'] } }] } }); }
  const { bindingFor } = await import('./dispatcher-connections');
  const originalManual = bindingFor({ agent: selected, projectPath: selectedProject, projectName: 'Selected' } as never, { agent: same ? controller : related, projectPath: manualProject, projectName: 'Related' } as never);
  expect(originalManual.disabledTools ?? []).not.toContain('clear_agent'); expect(originalManual.enabledTools ?? []).not.toContain('wake_agent');
  const selectedReceipt = captureReadOnlyAgentTargetWitness({ agent: selected, project: selectedRecord }), roleReceipt = captureReadOnlyRoleTargetWitness({ agent: controller, project: { id: 'dispatcher', name: 'Dispatcher', path: roleProject } }, () => true);
  expect(selectedReceipt.current()).toBe(true); expect(roleReceipt.current()).toBe(true); expect(project).not.toBe(roleProject);
  const saved = readSavedDispatcherLinksForDisplay(selected.id, selectedProject); expect(saved).toMatchObject({ state: 'ok', value: { total: links.length } });
  const automatic = configuredDispatcherDirections(selected, { state: 'ok', value: true, inputs: [] }, controller); expect(automatic).toMatchObject({ state: 'ok', value: [{ agentId: 'selected', targetId: 'controller1', targetName: 'Operations' }, { agentId: 'controller1', targetId: 'selected', agentName: 'Operations' }] });
  const actualSource = JSON.parse(await fsp.readFile(path.join(getBaseDirPath(), 'dispatcher-connections.json'), 'utf8')); expect(mode === 'reverse-cross-project' ? actualSource.connections[0].agentProjectPath : actualSource.connections[0].targetProjectPath).toBe(manualProject);
  const receipts: DisplayReceipt[] = [selectedReceipt, roleReceipt], c = card('connections', 'Connections'), source = await import('./dispatcher-endpoint-associations-display'), readMetadata = source.readSavedDispatcherEndpointMetadataForDisplay;
  const metadata = readMetadata({ agentId: selected.id, projectPath: selectedProject, target: selectedReceipt }, links, { receipts, readLoadedCache: readAgentConnectionCacheForDisplay });
  expect(metadata).toMatchObject({ state: 'ok', value: { rows: links.map(() => ({ relationship: 'recorded', endpoint: { state: 'ok', value: { record: 'registered-primary', fields: { id: manualId, name: { state: 'ok', value: same ? 'Operations' : related.name } } } } })) } }); expect(receipts.every((r) => r.current())).toBe(true);
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  const snapshot = async (folder = root): Promise<unknown> => Object.fromEntries(await Promise.all((await actual.readdir(folder)).sort().map(async (name) => { const f = path.join(folder, name), st = await actual.lstat(f); return [name, st.isDirectory() ? { ino: st.ino, files: await snapshot(f) } : { ino: st.ino, mtime: st.mtimeMs, bytes: (await actual.readFile(f)).toString('base64') }]; })));
  if (mode === 'bounded-identity-page') for (let i = 0; i < 34; i++) bindingManager.bind(selected.id, { targetId: 'terminal-' + i, targetKind: 'terminal', label: 'Selected terminal ' + i });
  const before = await snapshot();
  resetObservation(); await readPassiveConnectionCard(c, selected.id, { receipts, authorized: () => true, projectPath: selectedProject, name: selected.name, automatic, automaticControllerProjectPath: mode === 'matching-role-folder' ? undefined : roleProject, endpoint: { target: selectedReceipt, readCache: readAgentConnectionCacheForDisplay } });
  expect.soft(await snapshot()).toEqual(before);
  expect(receipts.every((r) => r.current())).toBe(true); expect(m.external).not.toHaveBeenCalled();
  if (mode === 'bounded-identity-page') { expect.soft(c.rows).toHaveLength(100); expect.soft(c.omitted).toBe(21); expect.soft(c.rows.some((r) => r.label.endsWith(' manual source eligibility'))).toBe(false); // The manual pair falls past the row cap; its 3 manual fields, including eligibility, are counted as omitted (121 total).
    expect.soft(JSON.stringify(c)).not.toMatch(/PRIVATE_|rootNamespace|targetProjectPath/); return; }
  const automaticSources = c.rows.filter((r) => r.label.endsWith(' sources') && r.value.includes('Connect to Dispatcher (saved policy)'));
  const manualSources = c.rows.filter((r) => r.label.endsWith(' sources') && r.value.includes('Made by the Dispatcher (saved record'));
  expect.soft(automaticSources).toHaveLength(2); expect.soft(automaticSources.every((r) => r.label.startsWith('Operations'))).toBe(true);
  expect.soft(manualSources).toHaveLength(links.length); expect.soft(manualSources.every((r) => r.label.startsWith(same ? 'Operations' : related.name))).toBe(true);
  if (mode === 'cross-project-two-way') { const headers = c.rows.filter((r) => r.label.startsWith('Project agent') && r.value.startsWith('agent ·')); expect.soft(headers).toHaveLength(2); expect.soft(headers.every((r) => r.value.includes('two-way records'))).toBe(true); }
  if (mode === 'cross-project-outgoing') {
    const manualHeaders = c.rows.filter((r) => r.label.startsWith('Project agent') && r.value.startsWith('agent ·'));
    expect.soft(manualHeaders).toHaveLength(1); expect.soft(manualHeaders.every((r) => !r.value.includes('two-way records') && r.value.includes('sends to it'))).toBe(true);
  }
  const combined = c.rows.filter((r) => r.label.endsWith(' sources') && r.value.includes('Connect to Dispatcher (saved policy)') && r.value.includes('Made by the Dispatcher (saved record'));
  expect.soft(combined).toHaveLength(mode === 'convergent-admitted-role-folder' ? 1 : 0);
  if (mode !== 'convergent-admitted-role-folder' && mode !== 'distinct-native-ids') {
    expect.soft(c.notes.join(' ')).toContain('endpoint projects are not verified equal');
    expect.soft(automaticSources.every((r) => r.label.includes('(automatic Dispatcher)'))).toBe(true); expect.soft(manualSources.every((r) => r.label.includes('(saved Dispatcher link)'))).toBe(true);
    const defaults = c.rows.filter((r) => r.label.endsWith('automatic starting switches')); expect.soft(defaults).toHaveLength(2); expect.soft(defaults.every((r) => r.label.includes('(automatic Dispatcher)') && r.value.split('; Off:')[0].includes('Read output'))).toBe(true);
    const primary = c.rows.filter((r) => r.label.endsWith(' saved target')); expect.soft(primary).toHaveLength(links.length); expect.soft(primary.every((r) => r.label.includes('(saved Dispatcher link)') && r.value.includes(same ? 'Connect to Dispatcher On' : 'Connect to Dispatcher Off'))).toBe(true);
  }
  const automaticDefaults = c.rows.filter((r) => r.label.endsWith('automatic starting switches')), manualDefaults = c.rows.filter((r) => r.label.endsWith('manual starting switches'));
  expect.soft(automaticDefaults).toHaveLength(2); expect.soft(manualDefaults).toHaveLength(mode === 'distinct-native-ids' ? 0 : links.length);
  expect.soft(automaticDefaults.every((r) => r.value.split('; Off:')[0].includes('Wake it') && r.value.split('; Off:')[1].includes('Clear its context'))).toBe(true);
  expect.soft(manualDefaults.every((r) => r.value.split('; Off:')[0].includes('Clear its context') && r.value.split('; Off:')[1].includes('Wake it'))).toBe(true);
  if (mode === 'convergent-admitted-role-folder') { const switches = c.rows.find((r) => r.label === 'Operations outgoing switches'); expect.soft(switches?.value).toContain('Multiple configured sources'); }
  if (mode === 'cross-project-native-override') {
    const native = c.rows.find((r) => r.label.includes('(native-ID records)') && r.label.endsWith('outgoing switches')); expect.soft(native?.value.split('; Off:')[1]).toContain('Read output');
    expect.soft(c.rows.filter((r) => r.label.includes('(automatic Dispatcher)') && /(?:outgoing|incoming) switches$/.test(r.label)).every((r) => r.value.includes('association is unconfirmed'))).toBe(true);
  }
  if (mode === 'reverse-cross-project') { const manual = c.rows.filter((r) => r.label.startsWith(related.name) && r.value.startsWith('agent ·')); expect.soft(manual).toHaveLength(1); expect.soft(manual.every((r) => r.value.includes('sends to this agent') && !r.value.includes('two-way records'))).toBe(true); }
  expect.soft(JSON.stringify(c)).not.toMatch(/PRIVATE_|rootNamespace|targetProjectPath/); expect.soft(JSON.stringify(c)).not.toContain(root);
});
