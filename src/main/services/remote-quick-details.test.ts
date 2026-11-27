import { fixtureBindingPage, fixtureSourcePage, fixtureDirectionPage, fixturePeerMetadata } from './connection-card-fixtures.qa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { execFile } from 'child_process';
import { beginQuickAgentRun, clearQuickAgentRuns, finishQuickAgentRun, noteQuickAgentRuntime } from './quick-agent-events';
import type { AgentRegistration } from './agent-registry';
import { noteAgentStarting, _resetAgentDisplayStateForTesting } from './agent-display-state';
import { resolveReadOnlyQuickTarget } from './read-only-quick-target';
import { projectActionDetails } from './actions/details-read';
import { readRemoteQuickDetails } from './remote-quick-details';
import { isRemoteAgentDetails, type RemoteAgentDetails } from '../../shared/remote-agent-details';
import { readRemoteAgentChanges } from './remote-agent-changes';
import { isRemoteAgentChanges } from '../../shared/remote-agent-changes';
import * as repository from './read-only-repository-changes';
import { createAssetCatalogStore } from './asset-catalog/store';
import { ASSET_CATALOG_VERSION } from '../../shared/asset-catalog-types';
import { createManagedAgentsService } from './managed-agents/service';
import { createManagedStateStore } from './managed-agents/state-store';
import { resetAllSettingsStoresForTests } from './settings-store';
const m = vi.hoisted(() => ({ base: '', realConnections: false, service: undefined as import('./managed-agents/service').ManagedAgentsService | undefined, durable: vi.fn(), registration: vi.fn(), runtime: vi.fn(), running: vi.fn(), bindings: vi.fn(), connectionFixture: vi.fn(), sourceFrame: { pairs: [], unreadable: [] } as import('../../shared/connection-sources').AgentConnectionSources, satellite: vi.fn(), peer: vi.fn(), directions: vi.fn(), actions: vi.fn(), canvases: vi.fn(), template: vi.fn(), entries: vi.fn(), connection: vi.fn() }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: m.registration } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: m.runtime }));
vi.mock('./agent-system', () => ({ isAgentRunning: m.running }));
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: m.durable }));
vi.mock('./dispatcher/dispatcher-service', () => ({ isDispatcherIdentityAgentId: () => false, dispatcherDisplayName: () => 'Dispatcher' }));
vi.mock('../orchestrators', () => ({ getProvider: (id: string) => ({ displayName: `Host ${id}` }) }));
vi.mock('./clubhouse-mcp/binding-manager', async (original) => { const actual = await original<typeof import('./clubhouse-mcp/binding-manager')>(); return { ...actual, bindingManager: new Proxy(actual.bindingManager, { get(target, key) { if (key === 'getAllBindings') return () => { throw new Error('legacy global bindings must not be read'); }; if (key === 'readBindingsForDisplay') return (id: string, options: Parameters<typeof target.readBindingsForDisplay>[1]) => m.realConnections ? target.readBindingsForDisplay(id, options) : fixtureBindingPage(m.bindings(), id, options!.direction!, actual.projectBindingRowForDisplay); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }) }; });
vi.mock('./persisted-bindings', async (original) => { const actual = await original<typeof import('./persisted-bindings')>(); const binding = await vi.importActual<typeof import('./clubhouse-mcp/binding-manager')>('./clubhouse-mcp/binding-manager'); return { ...actual, readCachedConnectionSourcesForDisplay: (...args: Parameters<typeof actual.readCachedConnectionSourcesForDisplay>) => m.realConnections ? actual.readCachedConnectionSourcesForDisplay(...args) : fixtureSourcePage(m.sourceFrame, args[0], binding.projectBindingRowForDisplay) }; });
vi.mock('./connection-directions-display', async (original) => { const actual = await original<typeof import('./connection-directions-display')>(); return { ...actual, readConnectionDirectionsForDisplay: (...args: Parameters<typeof actual.readConnectionDirectionsForDisplay>) => m.realConnections ? actual.readConnectionDirectionsForDisplay(...args) : fixtureDirectionPage(m.directions(), args[0]) }; });
// A modeled async admission at the actual card API boundary preserves the old
// assembly-race schedules. It is NOT the production legacy source reader.
vi.mock('./remote-details-cards', async (original) => { const actual = await original<typeof import('./remote-details-cards')>(); return { ...actual, readConnectionCard: async (...args: Parameters<typeof actual.readConnectionCard>) => { if (!m.realConnections) m.sourceFrame = await m.connectionFixture(args[1]); return actual.readConnectionCard(...args); } }; });
vi.mock('./annex-client', () => ({ getSatellite: m.satellite }));
vi.mock('./annex-peers', () => ({ getPeer: () => { throw new Error('legacy credential reader must not be read'); }, readPeerMetadataForDisplay: () => fixturePeerMetadata(m.peer()), peekPeerAlias: () => m.peer()?.alias, capturePeerPairingForDisplay: () => ({ state: 'unavailable', inputs: [], matches: () => undefined }) }));
vi.mock('./connection-sources', () => ({ listConnectionSources: () => { throw new Error('legacy source reader must not be read'); } }));
vi.mock('./connection-grants-store', () => ({ listConnectionDirectionsForInspection: m.directions }));

vi.mock('./actions', async () => ({ readActionDetailsForAgent: (agentId: string, projectId: string, dispatcher: boolean, names: import('../../shared/actions').ActionNames) => projectActionDetails({ list: m.actions, lastRunForDisplay: (id: string) => m.actions().find((a: { id: string }) => a.id === id)?.lastRun }, agentId, projectId, dispatcher, names), peekActionProjectName: () => 'Project' }));
vi.mock('./canvas-store-reader', () => ({ getAgentCanvasMemberships: m.canvases }));
vi.mock('./clubhouse-mcp/bridge-server', () => ({ getAgentConnection: m.connection, getCurrentAgentConnection: () => m.connection()?.current ? m.connection() : null }));
vi.mock('./managed-agents', () => ({ managedAgents: () => m.service ?? ({ getTemplateForDisplay: m.template,
  openSetupMetadataForDisplay: async () => ({ head: async (id: string) => (await m.entries())[id] ?? null, receipt: { current: () => true } }) }) }));
let root: string, project: string;
async function snapshot(folder: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const item of await fs.readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, item.name), relative = prefix + item.name;
    if (item.isDirectory()) Object.assign(out, await snapshot(file, relative + '/'));
    else out[relative] = (await fs.readFile(file)).toString('base64');
  }
  return out;
}
const start = () => beginQuickAgentRun({ agentId: 'quick', projectPath: project, cwd: project, name: 'Review', model: 'launch-model', effort: 'high', orchestrator: 'codex-cli', managedTemplate: { id: 't1', agentName: 'Review', addParts: ['added'], removeParts: ['removed'] } });
beforeEach(async () => {
  m.realConnections = false; clearQuickAgentRuns(); _resetAgentDisplayStateForTesting();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-quick-details-')); m.base = path.join(root, 'profile'); project = path.join(root, 'project');
  m.service = undefined; vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests();
  await fs.mkdir(m.base); await fs.mkdir(project);
  await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'p1', name: 'Project', path: project }] }));
  m.registration.mockReturnValue(undefined); m.runtime.mockReturnValue(undefined); m.running.mockReturnValue(false);
  m.bindings.mockReturnValue([]); m.connectionFixture.mockResolvedValue({ pairs: [], unreadable: [] }); m.satellite.mockReturnValue(null); m.peer.mockReturnValue(undefined); m.directions.mockReturnValue([]);
  m.actions.mockReturnValue([]); m.canvases.mockResolvedValue([]); m.connection.mockReturnValue(null);
  m.template.mockResolvedValue({ name: 'Review template', source: 'primary', observedAt: Date.now() }); m.entries.mockResolvedValue({ added: { name: 'Extra' }, removed: { name: 'Tone' } });
  m.durable.mockImplementation(() => { throw new Error('Quick reads must not resolve a durable config.'); });
});
afterEach(async () => { resetAllSettingsStoresForTests(); vi.restoreAllMocks(); clearQuickAgentRuns(); m.service = undefined; await fs.rm(root, { recursive: true, force: true }); });
const read = async () => {
  const target = await resolveReadOnlyQuickTarget('quick', () => true);
  expect(target).not.toBeNull();
  const result = await readRemoteQuickDetails(target!, () => true);
  expect(result.status).toBe(200); expect(isRemoteAgentDetails(result.body, 'quick')).toBe(true);
  return result.body as RemoteAgentDetails;
};
describe('read-only quick Details target and cards', () => {
  it('refuses the selected board query like every inventory page (#13 preview)', async () => {
    start();
    const target = await resolveReadOnlyQuickTarget('quick', () => true); expect(target).not.toBeNull();
    expect(await readRemoteQuickDetails(target!, () => true, { card: 'canvases', source: 'selected-canvas-board', member: 'a'.repeat(64), selection: 'b'.repeat(64) })).toEqual({ status: 400, body: { error: 'unsupported_inventory_page' } });
  });
  it('uses the shared selected quick-agent action groups without exposing action definitions or another run', async () => {
    start();
    const related = { id: 'reminder', name: 'Quick reminder', owner: { kind: 'agent', agentId: 'quick' }, enabled: false, trigger: { kind: 'once', at: 1000 }, steps: [{ kind: 'message', agentId: 'quick', text: 'PRIVATE_PROMPT' }], lastRun: { outcome: 'done', startedAt: 1000, reason: 'PRIVATE_RUN_REASON' } };
    m.actions.mockReturnValue([related, { ...related, id: 'other', name: 'PRIVATE_OTHER_ACTION', owner: { kind: 'agent', agentId: 'other' }, steps: [{ kind: 'wake', agentId: 'other' }] }]);
    const c = (await read()).cards.find((c) => c.id === 'actions')!;
    expect(c.summary).toBe('1 related'); expect(c.rows.map((r) => r.action?.group)).toEqual(['owned', 'targeting']);
    expect(c.rows[0].action).toMatchObject({ enabled: false, lastRun: { outcome: 'done', startedAt: 1000 } }); expect(JSON.stringify(c)).not.toContain('PRIVATE_'); expect(m.durable).not.toHaveBeenCalled();
  });
  it('shows retained launch choices without creating a durable config or pretending the requested provider is running', async () => {
    start(); noteAgentStarting('quick', true);
    const before = await snapshot(root), result = await read();
    expect(result).toMatchObject({ running: false, status: 'spawning', providerId: 'unknown', settings: null });
    const c = result.cards.find((c) => c.id === 'settings')!;
    expect(c.rows).toContainEqual({ label: 'Requested model', value: 'launch-model' });
    expect(c.rows).toContainEqual({ label: 'Requested effort', value: 'high' });
    expect(c.rows).toContainEqual({ label: 'Template', value: 'Review template' });
    expect(c.rows).toContainEqual({ label: 'Added for this run', value: 'Extra' });
    expect(c.rows).toContainEqual({ label: 'Left out for this run', value: 'Tone' });
    expect(result.cards.find((c) => c.id === 'orchestrate')?.state).toBe('not-applicable');
    expect(result.cards.find((c) => c.id === 'dispatcher')?.state).toBe('not-applicable');
    expect(await snapshot(root)).toEqual(before);
    expect(await resolveReadOnlyQuickTarget('Review', () => true)).toBeNull();
  });
  it('uses actual registration for runtime/provider and authenticated current-run MCP evidence', async () => {
    const run = start(); const registration: AgentRegistration = { projectPath: project, cwd: project, orchestrator: 'claude-code', runtime: 'pty', nonce: 'run-a', launchAccess: { access: 'ask', freeAgentMode: false } };
    m.running.mockReturnValue(true); m.registration.mockReturnValue(registration);
    noteQuickAgentRuntime(run, registration, () => m.registration() === registration);
    m.runtime.mockImplementation(() => ({ kind: 'pty' })); // Facade identity is not a run identity.
    m.connection.mockReturnValue({ connectedAt: 1, toolCount: 999 });
    let value = await read();
    expect(value.providerId).toBe('claude-code');
    expect(value.cards.find((c) => c.id === 'settings')?.rows).toContainEqual({ label: 'CLI', value: 'Host claude-code' });
    expect(JSON.stringify(value)).not.toContain('999 tools');
    m.connection.mockReturnValue({ current: true, connectedAt: Date.now(), toolCount: 12 });
    value = await read(); expect(JSON.stringify(value)).toContain('12 tools');
  });
  it('does not adopt a prior runtime for a reused ID or its current nonce/handshake/cwd', async () => {
    start(); m.running.mockReturnValue(true);
    m.bindings.mockReturnValue([{ agentId: 'quick', targetId: 'PRIVATE_PRIOR_TARGET', targetKind: 'agent', label: 'PRIVATE_PRIOR_CONNECTION' }]);
    m.registration.mockReturnValue({ projectPath: project, cwd: '/PRIVATE_PRIOR_FOLDER', orchestrator: 'prior-cli', runtime: 'pty', nonce: 'prior-run' });
    m.runtime.mockReturnValue({ kind: 'chat', getSessionId: () => 'PRIVATE_PRIOR_SESSION' });
    m.connection.mockReturnValue({ current: true, toolCount: 999 });
    const value = await read();
    expect(value).toMatchObject({ running: false, status: 'spawning', providerId: 'unknown', sessionId: null });
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE_PRIOR|prior-cli|999 tools/);
    expect(m.connectionFixture).not.toHaveBeenCalled();
    expect(value.cards.find((c) => c.id === 'session')?.rows).toContainEqual({ label: 'Requested folder', value: project });
    expect((await readRemoteAgentChanges('quick', { scope: 'branch' }, () => true)).status).toBe(409);
  });
  it('retains safe observed runtime metadata historically after the exact runtime is untracked', async () => {
    const run = start(); const registration: AgentRegistration = { projectPath: project, cwd: project, orchestrator: 'actual-cli', runtime: 'headless', nonce: 'PRIVATE_AUTH_NONCE' };
    m.registration.mockReturnValue(registration);
    noteQuickAgentRuntime(run, registration, () => m.registration() === registration);
    m.registration.mockReturnValue(undefined); finishQuickAgentRun(run, 'completed');
    const value = await read();
    expect(value).toMatchObject({ running: false, providerId: 'actual-cli', sessionId: null, status: 'sleeping' });
    expect(value.cards.find((c) => c.id === 'settings')?.rows).toContainEqual({ label: 'Last view', value: 'Headless' });
    expect(JSON.stringify(value)).not.toContain('PRIVATE_AUTH_NONCE');
    expect(JSON.stringify(run)).not.toContain('PRIVATE_AUTH_NONCE');
  });
  it('withholds runtime evidence for a failed launch even if another registration remains live', async () => {
    const run = start(); const registration: AgentRegistration = { projectPath: project, cwd: '/PRIVATE_OLD_CWD', orchestrator: 'old-cli', runtime: 'pty', nonce: 'old' };
    finishQuickAgentRun(run, 'failed'); m.registration.mockReturnValue(registration); m.running.mockReturnValue(true);
    noteQuickAgentRuntime(run, registration, () => true); // A late observation cannot adopt a finished/replaced launch.
    const value = await read();
    expect(value).toMatchObject({ running: false, status: 'error', providerId: 'unknown' });
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE_OLD_CWD|old-cli/);
  });
  it('keeps missing templates and unreadable connection sources partial, never verified empty', async () => {
    start(); m.template.mockRejectedValue(new Error('PRIVATE_ERROR'));
    m.connectionFixture.mockResolvedValue({ pairs: [], unreadable: ['Host source'] });
    const result = await read();
    expect(result.cards.find((c) => c.id === 'settings')?.rows).toContainEqual({ label: 'Requested model', value: 'launch-model' });
    const connections = result.cards.find((c) => c.id === 'connections')!;
    expect(connections.state).toBe('error'); expect(connections.summary).toBe('Connection run association unavailable'); expect(m.connectionFixture).not.toHaveBeenCalled();
    expect(connections.notes.join(' ')).not.toContain('No Clubhouse MCP connections');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ERROR');
  });
  it.each(['replacement', 'finished', 'project-removed', 'nonce-changed', 'revoked'] as const)('withholds late quick evidence after %s', async (condition) => {
    const run = start(); let allowed = true;
    const registration = { cwd: project, orchestrator: 'codex-cli', runtime: 'pty', nonce: 'run-a' };
    m.registration.mockReturnValue(registration);
    const target = await resolveReadOnlyQuickTarget('quick', () => allowed);
    m.canvases.mockImplementation(async () => {
      if (condition === 'replacement') start();
      if (condition === 'finished') finishQuickAgentRun(run, 'completed');
      if (condition === 'project-removed') await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
      if (condition === 'nonce-changed') registration.nonce = 'run-b';
      if (condition === 'revoked') allowed = false;
      return [{ name: 'PRIVATE_LATE_BOARD', scope: 'app', canvasId: 'c', viewId: 'v' }];
    });
    const response = await readRemoteQuickDetails(target!, () => allowed);
    expect(response.status).toBe(condition === 'revoked' ? 403 : 409);
    expect(response.body).not.toHaveProperty('cards');
    expect(JSON.stringify(response)).not.toContain('PRIVATE_LATE_BOARD');
  });
});

async function quickTemplateFixture() {
  const catalogDir = path.join(root, 'catalog'), stateDir = path.join(root, 'managed');
  await fs.mkdir(catalogDir); await fs.mkdir(stateDir);
  const stateFile = path.join(stateDir, 'state.json'), catalogFile = path.join(catalogDir, 'catalog.json');
  const template = { id: 't1', name: 'Review template', builtin: false, description: 'PRIVATE_TEMPLATE_DESCRIPTION', setup: { blocks: [], skills: [], mcps: [] }, settings: { freeAgentMode: true, PRIVATE_CONFIG: 'PRIVATE_TEMPLATE_SETTINGS' } };
  const entry = (id: string, name: string) => ({ id, kind: 'block', name, source: { kind: 'user' }, owner: { kind: 'library' }, createdAt: '2026-11-19', headRevision: 1, revisions: [{ revision: 1, savedAt: '2026-11-19', contentHash: 'a'.repeat(64), projection: { kind: 'block', bytes: 10 } }], PRIVATE_CONFIG: 'PRIVATE_PART_SETTINGS' });
  const state = { version: 1, parts: {}, templates: { t1: template, unrelated: { ...template, id: 'unrelated', name: 'PRIVATE_UNRELATED_TEMPLATE' } } };
  const index = { version: ASSET_CATALOG_VERSION, assets: { added: entry('added', 'Extra'), removed: entry('removed', 'Tone'), unrelated: entry('unrelated', 'PRIVATE_UNRELATED_PART') }, compositions: {}, runs: {} };
  await fs.writeFile(stateFile, JSON.stringify(state)); await fs.writeFile(catalogFile, JSON.stringify(index));
  await fs.writeFile(path.join(root, 'free-agent-settings.json'), '{broken');
  await fs.writeFile(path.join(root, 'free-agent-settings.json.bak'), '{"defaultMode":"skip-all"}');
  const aged = path.join(root, `.free-agent-settings.json.tmp-${process.pid + 100000}-1`);
  await fs.writeFile(aged, 'do not sweep this temp'); const old = new Date(Date.now() - 3 * 86400000); await fs.utimes(aged, old, old);
  const service = createManagedAgentsService({ catalog: createAssetCatalogStore({ dir: catalogDir }), state: createManagedStateStore(stateDir), listProjects: async () => [], listAgents: async () => [], getAgent: m.durable, setManagedSetup: vi.fn(), isRunning: () => false });
  m.service = service;
  return { stateFile, catalogFile, state, index, service };
}
async function metadataDisk(folder = root): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const name of (await fs.readdir(folder)).sort()) {
    const file = path.join(folder, name), stat = await fs.lstat(file);
    result[name] = stat.isDirectory() ? { ino: stat.ino, files: await metadataDisk(file) } : { bytes: (await fs.readFile(file)).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs };
  }
  return result;
}
describe('Quick template passive selected metadata composition', () => {
  it('keeps cold corrupt Access and aged temps unchanged while displaying selected names without ordinary lists or revision reads', async () => {
    const { service } = await quickTemplateFixture(); start();
    const template = vi.spyOn(service, 'getTemplate'), entries = vi.spyOn(service, 'liveEntries'), head = vi.spyOn(service, 'headContent');
    const ids: string[] = [], open = service.openSetupMetadataForDisplay.bind(service);
    vi.spyOn(service, 'openSetupMetadataForDisplay').mockImplementation(async () => {
      const reader = await open(); return { ...reader, head: async (id: string) => { ids.push(id); return reader.head(id); } };
    });
    const before = await metadataDisk(), result = await read();
    const c = result.cards.find((card) => card.id === 'settings')!;
    expect.soft(c.rows).toEqual(expect.arrayContaining([{ label: 'Template', value: 'Review template' }, { label: 'Added for this run', value: 'Extra' }, { label: 'Left out for this run', value: 'Tone' }]));
    expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|headRevision|contentHash|setupReceipts|payloadsVerified/);
    expect.soft(template).not.toHaveBeenCalled(); expect.soft(entries).not.toHaveBeenCalled(); expect.soft(head).not.toHaveBeenCalled();
    expect.soft(ids).toEqual(['added', 'removed']);
    expect.soft(await metadataDisk()).toEqual(before);
    expect(m.durable).not.toHaveBeenCalled();
  });
  it.each(['template', 'catalog'] as const)('retains independent launch metadata when the actual %s file exceeds its display cap', async (kind) => {
    const f = await quickTemplateFixture(); start();
    if (kind === 'template') await fs.writeFile(f.stateFile, JSON.stringify({ ...f.state, PRIVATE_PADDING: 'x'.repeat(512 * 1024) }));
    else await fs.writeFile(f.catalogFile, JSON.stringify({ ...f.index, PRIVATE_PADDING: 'x'.repeat(4 * 1024 * 1024) }));
    const before = await metadataDisk(), result = await read(), c = result.cards.find((card) => card.id === 'settings')!;
    expect.soft(c.state).toBe('error');
    expect.soft(c.rows).toContainEqual({ label: 'Template', value: kind === 'template' ? 'Template metadata unavailable' : 'Review template' });
    expect.soft(c.rows).toContainEqual({ label: 'Added for this run', value: kind === 'catalog' ? 'Unavailable from library metadata' : 'Extra' });
    expect.soft(c.rows).toContainEqual({ label: 'Requested model', value: 'launch-model' });
    expect.soft(await metadataDisk()).toEqual(before); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
  });
  it.each(['template', 'catalog'] as const)('retains independent launch fields when the selected %s primary is unreadable', async (kind) => {
    const f = await quickTemplateFixture(); start(); await fs.writeFile(kind === 'template' ? f.stateFile : f.catalogFile, '{broken');
    const before = await metadataDisk(), result = await read(), c = result.cards.find((card) => card.id === 'settings')!;
    expect(c.state).toBe('error');
    expect(c.rows).toContainEqual({ label: 'Requested model', value: 'launch-model' });
    expect(c.rows).toContainEqual({ label: 'Template', value: kind === 'template' ? 'Template metadata unavailable' : 'Review template' });
    expect(c.rows).toContainEqual({ label: 'Added for this run', value: kind === 'catalog' ? 'Unavailable from library metadata' : 'Extra' });
    expect(c.notes.join(' ')).toContain(kind === 'template' ? 'selected template is unavailable' : 'No empty library');
    expect(await metadataDisk()).toEqual(before); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });
  it('does not let unrelated malformed template/catalog entries suppress selected names', async () => {
    const f = await quickTemplateFixture(); start();
    await fs.writeFile(f.stateFile, JSON.stringify({ ...f.state, templates: { ...f.state.templates, unrelated: null } }));
    await fs.writeFile(f.catalogFile, JSON.stringify({ ...f.index, assets: { ...f.index.assets, unrelated: null } }));
    const before = await metadataDisk(), result = await read(), c = result.cards.find((card) => card.id === 'settings')!;
    expect(c.rows).toContainEqual({ label: 'Template', value: 'Review template' }); expect(c.rows).toContainEqual({ label: 'Added for this run', value: 'Extra' });
    expect(await metadataDisk()).toEqual(before); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });
  it.each(['template', 'part', 'during-later-head', 'revoked'] as const)('withholds selected setup after real %s evidence changes across an await', async (change) => {
    const f = await quickTemplateFixture(); start(); let allowed = true, changed = false;
    const target = await resolveReadOnlyQuickTarget('quick', () => allowed); expect(target).not.toBeNull();
    if (change === 'during-later-head' || change === 'revoked') {
      const open = f.service.openSetupMetadataForDisplay.bind(f.service);
      vi.spyOn(f.service, 'openSetupMetadataForDisplay').mockImplementation(async () => {
        const reader = await open(); return { ...reader, head: async (id: string) => {
          const value = await reader.head(id);
          if (id === 'removed') {
            if (change === 'revoked') allowed = false;
            else { f.index.assets.added.name = 'Changed selected part'; await fs.writeFile(f.catalogFile, JSON.stringify(f.index)); }
            changed = true;
          }
          return value;
        } };
      });
    } else m.canvases.mockImplementation(async () => {
      if (change === 'template') { f.state.templates.t1.name = 'Changed selected template'; await fs.writeFile(f.stateFile, JSON.stringify(f.state)); }
      else { delete (f.index.assets as Partial<typeof f.index.assets>).added; await fs.writeFile(f.catalogFile, JSON.stringify(f.index)); }
      changed = true; return [];
    });
    const result = await readRemoteQuickDetails(target!, () => allowed); expect(changed).toBe(true);
    expect.soft(result.status).toBe(change === 'revoked' ? 403 : 409); expect.soft(result.body).not.toHaveProperty('cards');
    expect.soft(JSON.stringify(result.body)).not.toMatch(/Review template|Extra|Tone|PRIVATE_/);
  });
  it('ignores unrelated template and catalog changes while keeping selected receipts private', async () => {
    const f = await quickTemplateFixture(); start();
    m.canvases.mockImplementation(async () => {
      f.state.templates.unrelated.name = 'PRIVATE_CHANGED_TEMPLATE'; f.index.assets.unrelated.name = 'PRIVATE_CHANGED_PART';
      await fs.writeFile(f.stateFile, JSON.stringify(f.state)); await fs.writeFile(f.catalogFile, JSON.stringify(f.index)); return [];
    });
    const result = await read(); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|"(?:current|receipts|setupReceipts)"\s*:/);
    expect(result.cards.find((c) => c.id === 'settings')?.rows).toContainEqual({ label: 'Added for this run', value: 'Extra' });
  });
});

async function quickRepository() {
  const git = (...args: string[]) => new Promise<string>((resolve, reject) => execFile('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } }, (error, out) => error ? reject(error) : resolve(out.trim())));
  // An empty file, not os.devNull: Git for Windows cannot open \\.\nul as a config file.
  await fs.writeFile(path.join(root, 'empty-gitconfig'), '');
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@invalid');
  await fs.writeFile(path.join(project, '.gitattributes'), '* -filter -ident -text\n'); await fs.writeFile(path.join(project, 'source.txt'), 'before\n');
  await git('add', '.'); await git('commit', '-m', 'base'); await git('switch', '-c', 'feature');
  await fs.writeFile(path.join(project, 'source.txt'), 'after\n');
  // The Git/filesystem comparison is real; the already-created runtime is modeled.
  const run = start(); const registration: AgentRegistration = { projectPath: project, cwd: project, orchestrator: 'codex-cli', runtime: 'pty', nonce: 'created-run' };
  m.registration.mockReturnValue(registration);
  noteQuickAgentRuntime(run, registration, () => m.registration() === registration);
  return git;
}
describe('quick Changes with actual inventories and Git', () => {
  it('does not read a requested cwd from an unconfirmed/failed launch', async () => {
    const run = beginQuickAgentRun({ agentId: 'quick', name: 'Failed', projectPath: project, cwd: path.join(root, 'unconfirmed-folder') });
    finishQuickAgentRun(run, 'failed');
    const readRoot = vi.spyOn(repository, 'readOnlyRepositoryRoot');
    const result = await readRemoteAgentChanges('quick', { scope: 'branch' }, () => true);
    expect(result.status).toBe(200); expect(result.body).toHaveProperty('state', 'unsupported');
    expect(readRoot).not.toHaveBeenCalled(); expect(m.durable).not.toHaveBeenCalled();
  });
  it('reads branch metadata and patches without a durable fallback or repository writes', async () => {
    const git = await quickRepository();
    await git('update-ref', 'refs/clubhouse/checkpoints/quick/old-session/old-turn/start', 'HEAD');
    const before = await snapshot(root);
    const result = await readRemoteAgentChanges('quick', { scope: 'branch' }, () => true);
    expect(result.status).toBe(200); expect(isRemoteAgentChanges(result.body, 'quick', { scope: 'branch' })).toBe(true);
    const body = result.body as { files: Array<{ fileKey: string; path: string }> };
    expect(body.files.map((f) => f.path)).toEqual(['source.txt']);
    const patch = await readRemoteAgentChanges('quick', { scope: 'branch', fileKey: body.files[0].fileKey }, () => true);
    expect(JSON.stringify(patch)).toContain('+after');
    const historical = await readRemoteAgentChanges('quick', { scope: 'session' }, () => true);
    expect(historical.body).toHaveProperty('state', 'unsupported');
    expect(m.durable).not.toHaveBeenCalled();
    expect(await snapshot(root)).toEqual(before);
  });
  it.each(['project-removed', 'replacement'] as const)('withholds an actual quick comparison after %s during the comparison await', async (condition) => {
    await quickRepository();
    const actual = repository.readOnlyRepositoryChanges;
    vi.spyOn(repository, 'readOnlyRepositoryChanges').mockImplementation(async (...args) => {
      const value = await actual(...args);
      if (condition === 'replacement') start();
      else await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
      return value;
    });
    const result = await readRemoteAgentChanges('quick', { scope: 'branch' }, () => true);
    expect(result.status).toBe(409); expect(result.body).not.toHaveProperty('files');
    expect(m.durable).not.toHaveBeenCalled();
  });
});


describe('actual selected Quick Connections evidence at final assembly', () => {
  it.each(['unchanged', 'binding', 'primary', 'revoked-and-changed'] as const)('keeps the attested quick run and final selected evidence: %s', async (mode) => {
    const { bindingManager } = await import('./clubhouse-mcp/binding-manager');
    const sources = await import('./persisted-bindings');
    const { readConnectionDirectionsForDisplay } = await import('./connection-directions-display');
    m.realConnections = true; bindingManager._resetForTesting(); sources._resetPersistedBindingSourcesForTesting();
    bindingManager.setConnectionToolsSource(null, null); bindingManager.setConnectionInstructionsSource(null);
    const run = start(), registration: AgentRegistration = { projectPath: project, cwd: project, orchestrator: 'claude-code', runtime: 'pty', nonce: 'PRIVATE_CURRENT_NONCE' };
    m.running.mockReturnValue(true); m.registration.mockReturnValue(registration); noteQuickAgentRuntime(run, registration, () => m.registration() === registration);
    bindingManager.bind('quick', { targetId: 'selected-target', targetKind: 'agent', label: 'Quick selected target' });
    const file = path.join(root, 'connection-grants.json');
    const put = (disabledTools: string[]) => fs.writeFile(file, JSON.stringify({ version: 1, directions: [{ from: { agentId: 'quick' }, to: { agentId: 'selected-target' }, disabledTools, link: { createdAt: '2026-11-19T00:00:00Z' } }] }));
    await put([]);
    const admitted: Array<{ current(): boolean }> = [];
    bindingManager.readBindingsForDisplay('quick', { direction: 'outgoing', receipts: admitted }); readConnectionDirectionsForDisplay('quick', { receipts: admitted });
    expect(admitted.every((receipt) => receipt.current())).toBe(true);
    let allowed = true, late = false;
    m.canvases.mockImplementation(async () => { late = true; if (mode === 'binding' || mode === 'revoked-and-changed') bindingManager.updateBinding('quick', 'selected-target', { label: 'Quick new target' }); if (mode === 'primary') await put(['read_output']); if (mode === 'revoked-and-changed') allowed = false; return []; });
    try {
      const target = await resolveReadOnlyQuickTarget('quick', () => allowed); expect(target).not.toBeNull();
      const result = await readRemoteQuickDetails(target!, () => allowed);
      expect(late).toBe(true); expect(m.connectionFixture).not.toHaveBeenCalled(); expect(admitted.every((receipt) => receipt.current())).toBe(mode === 'unchanged');
      if (mode === 'unchanged') { expect(result.status).toBe(200); expect(isRemoteAgentDetails(result.body, 'quick')).toBe(true); expect(JSON.stringify(result.body)).toContain('Quick selected target'); }
      else { expect.soft(result.status).toBe(mode === 'revoked-and-changed' ? 403 : 409); expect.soft(result.body).toEqual({ error: mode === 'revoked-and-changed' ? 'details_read_refused' : 'connection_evidence_changed' }); expect.soft(result.body).not.toHaveProperty('cards'); }
    } finally { m.realConnections = false; sources._resetPersistedBindingSourcesForTesting(); bindingManager._resetForTesting(); }
  });
});

it('keeps current Quick bindings while refusing inapplicable saved durable Dispatcher connections for its native ID', async () => {
  const run = start(), registration: AgentRegistration = { projectPath: project, cwd: project, orchestrator: 'claude-code', runtime: 'pty', nonce: 'PRIVATE_RUN_NONCE' };
  m.registration.mockReturnValue(registration); m.running.mockReturnValue(true); m.runtime.mockReturnValue({ kind: 'pty' }); noteQuickAgentRuntime(run, registration, () => m.registration() === registration);
  const bindings = await import('./clubhouse-mcp/binding-manager'), sources = await import('./persisted-bindings'), saved = await import('./dispatcher-saved-links-display'), owner = await import('./dispatcher-connections');
  m.realConnections = true; bindings.bindingManager._resetForTesting(); sources._resetPersistedBindingSourcesForTesting();
  bindings.bindingManager.setConnectionToolsSource(null, null); bindings.bindingManager.setConnectionInstructionsSource(null);
  bindings.bindingManager.bind('quick', { targetId: 'current-target', targetKind: 'agent', label: 'Current receiver' });
  await fs.writeFile(path.join(m.base, 'dispatcher-connections.json'), JSON.stringify({ version: 1, connections: [{ agentId: 'quick', targetId: 'PRIVATE_INAPPLICABLE_TARGET', agentProjectPath: project, targetProjectPath: '/other-project', createdAt: '2026-11-19T00:00:00Z', createdBy: 'controller' }], removedByUser: [] }));
  const savedRead = vi.spyOn(saved, 'readSavedDispatcherLinksForDisplay'), memoryRead = vi.spyOn(owner, 'readDispatcherLinkMemoryForDisplay');
  try { const result = await read(); expect.soft(result.cards.find((card) => card.id === 'connections')?.rows.some((row) => row.label === 'Current receiver')).toBe(true); expect.soft(savedRead).not.toHaveBeenCalled(); expect.soft(memoryRead).not.toHaveBeenCalled(); expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_INAPPLICABLE_TARGET|PRIVATE_RUN_NONCE/); }
  finally { m.realConnections = false; bindings.bindingManager._resetForTesting(); sources._resetPersistedBindingSourcesForTesting(); }
});

describe('attested Quick Connections continuation', () => {
  it.each(['unchanged', 'binding-late', 'replacement', 'finished', 'revoked', 'display-reopen', 'display-stable', 'display-reopen-early', 'display-reopen-revoked'] as const)('binds the final source page to this exact Quick run: %s', async (mode) => {
    const { bindingManager } = await import('./clubhouse-mcp/binding-manager'), sources = await import('./persisted-bindings');
    m.realConnections = true; bindingManager._resetForTesting(); sources._resetPersistedBindingSourcesForTesting(); bindingManager.setConnectionToolsSource(null, null); bindingManager.setConnectionInstructionsSource(null);
    let displayGeneration = 'admitted-display';
    const admittedRuntime = { kind: 'chat', getSessionId: () => 'same-app-session', getNativeSessionId: () => 'same-native-session', getDisplayRunId: () => displayGeneration };
    const run = start(), registration: AgentRegistration = { projectPath: project, cwd: project, runtime: mode.startsWith('display-') ? 'chat' : 'pty', orchestrator: 'codex-cli', nonce: 'PRIVATE_CURRENT_QUICK_NONCE' };
    m.registration.mockReturnValue(registration); m.running.mockReturnValue(true); m.runtime.mockReturnValue(mode.startsWith('display-') ? admittedRuntime : { kind: 'pty' }); noteQuickAgentRuntime(run, registration, () => m.registration() === registration);
    for (let i = 0; i < 41; i++) bindingManager.bind('quick', { targetId: 'terminal-' + i, targetKind: 'terminal', label: 'Quick terminal ' + i });
    let earlyReached = false;
    if (mode === 'display-reopen-early') m.template.mockImplementationOnce(async () => { earlyReached = true; displayGeneration = 'reopened-display'; return { name: 'Review template', source: 'primary', observedAt: Date.now() }; });
    let allowed = true, reached = false, observed = false;
    const module = await import('./remote-connection-card'), original = module.readPassiveConnectionCard;
    const capture = vi.spyOn(module, 'readPassiveConnectionCard').mockImplementation(async (...args) => { await original(...args); observed = args[0].rows.some((row) => row.label === 'Quick terminal 40'); });
    m.canvases.mockImplementationOnce(async () => { reached = true; if (mode === 'binding-late') bindingManager.updateBinding('quick', 'terminal-40', { label: 'Changed terminal' }); if (mode === 'replacement') m.registration.mockReturnValue({ ...registration, nonce: 'replacement' }); if (mode === 'finished') finishQuickAgentRun(run, 'completed'); if (mode === 'revoked' || mode === 'display-reopen-revoked') allowed = false; if (mode === 'display-reopen' || mode === 'display-reopen-revoked') displayGeneration = 'reopened-display'; return []; });
    try {
      const target = await resolveReadOnlyQuickTarget('quick', () => allowed); expect(target).not.toBeNull();
      const response = await readRemoteQuickDetails(target!, () => allowed, { card: 'connections', source: 'outgoing', offset: 40 });
      expect(reached).toBe(true); expect(observed).toBe(true);
      if (mode.startsWith('display-')) { expect(m.runtime()).toBe(admittedRuntime); expect(admittedRuntime.getSessionId()).toBe('same-app-session'); expect(admittedRuntime.getNativeSessionId()).toBe('same-native-session'); expect(displayGeneration).toBe(mode === 'display-stable' ? 'admitted-display' : 'reopened-display'); if (mode === 'display-reopen-early') expect(earlyReached).toBe(true); }
      if (mode === 'unchanged' || mode === 'display-stable') {
        expect(response.status).toBe(200); expect(isRemoteAgentDetails(response.body, 'quick')).toBe(true); const body = response.body as RemoteAgentDetails;
        expect(body.connectionPageOnly).toBe(true); expect(body.connectionPageEnvelope).toBe(1); expect(body.cards.filter((c) => c.id !== 'connections').every((c) => c.requested === false && c.rows.length === 0 && c.notes.length === 0)).toBe(true); expect(body.connectionPageSources).toEqual(['outgoing', 'incoming', 'directions', 'sources']); expect(body.cards.find((c) => c.id === 'connections')?.connectionPage).toMatchObject({ source: 'outgoing', offset: 40, known: 41, next: null }); expect(JSON.stringify(body)).not.toContain('PRIVATE_CURRENT_QUICK_NONCE');
      } else { expect.soft(response.status).toBe(mode === 'revoked' || mode === 'display-reopen-revoked' ? 403 : 409); expect.soft(response.body).not.toHaveProperty('cards'); }
    } finally { capture.mockRestore(); m.realConnections = false; bindingManager._resetForTesting(); sources._resetPersistedBindingSourcesForTesting(); }
  });
  it('does not advertise run-owned connection pages for an unattested or stopped Quick launch and refuses durable-only source queries', async () => {
    start(); const target = await resolveReadOnlyQuickTarget('quick', () => true); expect(target).not.toBeNull();
    const response = await readRemoteQuickDetails(target!, () => true); expect(response.status).toBe(200); expect((response.body as RemoteAgentDetails).connectionPageSources).toEqual([]);
    const denied = await readRemoteQuickDetails(target!, () => true, { card: 'connections', source: 'tool-records' }); expect(denied.status).toBe(404); expect(denied.body).not.toHaveProperty('cards'); expect(m.durable).not.toHaveBeenCalled();
  });
});
