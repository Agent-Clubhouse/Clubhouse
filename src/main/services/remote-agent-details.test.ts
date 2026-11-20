import { fixtureBindingPage, fixtureSourcePage, fixtureDirectionPage, fixturePeerMetadata } from './connection-card-fixtures.qa';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { resetAllSettingsStoresForTests } from './settings-store';
import { setAgentCardSource } from './dispatcher/dispatcher-agent-card-source';
import { readAgentCardForDisplay } from './dispatcher/dispatcher-agent-card-display';
import { agentPagePath, renderAgentPage } from './dispatcher/dispatcher-memory';
import { noteAgentStarting, _resetAgentDisplayStateForTesting } from './agent-display-state';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { ORCHESTRATION_DEFAULTS } from '../../shared/orchestration-policy';
import { isRemoteAgentDetails, type RemoteAgentDetails } from '../../shared/remote-agent-details';
const m = vi.hoisted(() => ({ target: vi.fn(), settings: vi.fn(), provider: vi.fn(), running: vi.fn(), policies: vi.fn(), helpers: vi.fn(), requests: vi.fn(), bindings: vi.fn(), connectionFixture: vi.fn(), sourceFrame: { pairs: [], unreadable: [] } as import('../../shared/connection-sources').AgentConnectionSources, satellite: vi.fn(), peer: vi.fn(), directions: vi.fn(), dispatcher: vi.fn(), dispatcherOn: vi.fn(), agentCard: vi.fn(), actions: vi.fn(), canvases: vi.fn(), status: vi.fn(), entries: vi.fn(), template: vi.fn(), mcp: vi.fn(), branch: vi.fn(), transcript: vi.fn(), historical: vi.fn(), envCached: vi.fn(), catalog: vi.fn(), connection: vi.fn(), work: vi.fn(), realConnections: false, realWitness: false, realDispatcher: false, realPolicy: false, base: '', registration: vi.fn(), runtime: vi.fn(), useRealRuntime: false }));
const liveProbes = vi.hoisted(() => ({ model: vi.fn(() => { throw new Error('Historical Details must not probe live models.'); }), quota: vi.fn(() => { throw new Error('Historical Details must not probe live quota.'); }) }));
// Native transcript lookup/parser stay real. Their unrelated live CLI probe
// ports must remain unused, without importing a spawn/transport graph here.
vi.mock('../orchestrators/model-probes', () => ({ probeClaudeModels: liveProbes.model }));
vi.mock('../orchestrators/quota-probes', () => ({ probeClaudeQuota: liveProbes.quota }));
vi.mock('child_process', async (original) => ({ ...await original<typeof import('child_process')>(), execSync: vi.fn(() => '') }));
vi.mock('../util/shell', async (original) => ({ ...await original<typeof import('../util/shell')>(), isShellEnvironmentCached: m.envCached }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
vi.mock('./read-only-agent-target-witness', async (original) => {
  const actual = await original<typeof import('./read-only-agent-target-witness')>();
  return { ...actual, captureReadOnlyAgentTargetWitness: (...args: Parameters<typeof actual.captureReadOnlyAgentTargetWitness>) => m.realWitness ? actual.captureReadOnlyAgentTargetWitness(...args) : { current: () => true } };
});
vi.mock('./read-only-config-target', async (original) => { const actual = await original<typeof import('./read-only-config-target')>(); return { captureReadOnlyConfigTargetWitness: (...args: Parameters<typeof actual.captureReadOnlyConfigTargetWitness>) => m.realWitness ? actual.captureReadOnlyConfigTargetWitness(...args) : { current: () => true } }; });
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: m.target }));
vi.mock('./remote-agent-settings', () => ({ readRemoteAgentSettings: m.settings }));
vi.mock('./display-provider', () => ({ captureDisplayProvider: () => { const provider = m.provider(); return { provider, selection: { state: 'ok', value: provider.id, inputs: [] }, receipt: { current: () => true } }; } }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: m.provider, isAgentRunning: m.running }));
vi.mock('./agent-runtime/pty-runtime', () => ({ PtyAgentRuntime: class { kind = 'pty'; constructor(readonly agentId: string) {} } }));
vi.mock('./pty-manager', () => ({ isRunning: () => m.running() }));
vi.mock('./agent-runtime', async (original) => {
  const actual = await original<typeof import('./agent-runtime')>();
  return { ...actual, getAgentRuntime: (id: string) => m.useRealRuntime ? actual.getAgentRuntime(id) : m.runtime() };
});
vi.mock('./agent-registry', () => ({ agentRegistry: { get: m.registration } }));
vi.mock('./orchestration-display', async (original) => { const actual = await original<typeof import('./orchestration-display')>(); return { readOrchestrationForDisplay: (target: Parameters<typeof actual.readOrchestrationForDisplay>[0], options: Parameters<typeof actual.readOrchestrationForDisplay>[1]) => {
  if (m.realPolicy) return actual.readOrchestrationForDisplay(target, options);
  const policy = m.policies().get(target.agent.id) ?? ORCHESTRATION_DEFAULTS;
  return { fields: Object.fromEntries(Object.entries(ORCHESTRATION_DEFAULTS).map(([key]) => [key, { state: 'ok', value: policy[key], inputs: [] }])), sources: policy.sources ?? {}, globalCap: { state: 'ok', value: 20, inputs: [] }, autoEffective: { state: 'ok', value: policy.autoEffective ?? { effective: false, source: 'default' }, inputs: [] } };
} }; });
vi.mock('./orchestration-settings', async (original) => ({ ...await original<typeof import('./orchestration-settings')>(), getGlobalHelperCap: () => 20 }));
vi.mock('./helper-index', () => ({ listHelpersEverywhere: m.helpers }));
vi.mock('./read-only-helper-work', () => ({ readOnlyHelperWork: m.work, HELPER_TRANSFORM_UNAVAILABLE: 'Custom Git filters or text transforms are not run for helper work.' }));
vi.mock('./helper-start-requests', () => ({ readStartRequestsForDisplay: () => ({ state: 'ok', value: m.requests(), inputs: [] }) }));
vi.mock('./clubhouse-mcp/binding-manager', async (original) => { const actual = await original<typeof import('./clubhouse-mcp/binding-manager')>(); return { ...actual, bindingManager: new Proxy(actual.bindingManager, { get(target, key) { if (key === 'getAllBindings') return () => { throw new Error('legacy global bindings must not be read'); }; if (key === 'readBindingsForDisplay') return (id: string, options: Parameters<typeof target.readBindingsForDisplay>[1]) => m.realConnections ? target.readBindingsForDisplay(id, options) : fixtureBindingPage(m.bindings(), id, options!.direction!, actual.projectBindingRowForDisplay); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }) }; });
vi.mock('./persisted-bindings', async (original) => { const actual = await original<typeof import('./persisted-bindings')>(); const binding = await vi.importActual<typeof import('./clubhouse-mcp/binding-manager')>('./clubhouse-mcp/binding-manager'); return { ...actual, readCachedConnectionSourcesForDisplay: (...args: Parameters<typeof actual.readCachedConnectionSourcesForDisplay>) => m.realConnections ? actual.readCachedConnectionSourcesForDisplay(...args) : fixtureSourcePage(m.sourceFrame, args[0], binding.projectBindingRowForDisplay) }; });
vi.mock('./connection-directions-display', async (original) => { const actual = await original<typeof import('./connection-directions-display')>(); return { ...actual, readConnectionDirectionsForDisplay: (...args: Parameters<typeof actual.readConnectionDirectionsForDisplay>) => m.realConnections ? actual.readConnectionDirectionsForDisplay(...args) : fixtureDirectionPage(m.directions(), args[0]) }; });
// A modeled async admission at the actual card API boundary preserves the old
// assembly-race schedules. It is NOT the production legacy source reader.
vi.mock('./remote-details-cards', async (original) => { const actual = await original<typeof import('./remote-details-cards')>(); return { ...actual, readConnectionCard: async (...args: Parameters<typeof actual.readConnectionCard>) => { if (!m.realConnections) m.sourceFrame = await m.connectionFixture(args[1]); return actual.readConnectionCard(...args); } }; });
vi.mock('./clubhouse-mcp/bridge-server', () => ({ getAgentConnection: m.connection, getCurrentAgentConnection: () => m.connection()?.current ? m.connection() : null }));
vi.mock('./annex-client', () => ({ getSatellite: m.satellite }));
vi.mock('./annex-peers', () => ({ getPeer: () => { throw new Error('legacy credential reader must not be read'); }, readPeerMetadataForDisplay: () => fixturePeerMetadata(m.peer()), peekPeerAlias: () => m.peer()?.alias, capturePeerPairingForDisplay: () => ({ state: 'unavailable', inputs: [], matches: () => undefined }) }));
vi.mock('./connection-sources', () => ({ listConnectionSources: () => { throw new Error('legacy source reader must not be read'); } }));
vi.mock('./connection-grants-store', () => ({ listConnectionDirectionsForInspection: m.directions }));
vi.mock('./dispatcher/dispatcher-service', () => ({ dispatcherDisplayName: () => m.dispatcher()?.config?.name ?? 'Dispatcher', getDispatcherState: () => { throw new Error('ordinary Dispatcher state must not be read'); }, getDispatcherAgentId: () => m.dispatcher()?.agentId ?? null, getDispatcherChatAgentId: () => m.dispatcher()?.chatAgentId ?? null, isDispatcherAgentId: (id: string) => id === m.dispatcher()?.agentId, isDispatcherIdentityAgentId: (id: string) => [m.dispatcher()?.agentId, m.dispatcher()?.chatAgentId].includes(id) }));
vi.mock('./dispatcher/dispatcher-settings', async (original) => {
  const actual = await original<typeof import('./dispatcher/dispatcher-settings')>();
  return { ...actual, isDispatcherEnabled: () => { throw new Error('ordinary Dispatcher initialization must not be read'); }, readDispatcherEnablementForDisplay: (...args: Parameters<typeof actual.readDispatcherEnablementForDisplay>) => m.realDispatcher ? actual.readDispatcherEnablementForDisplay(...args) : { enabled: { state: 'ok', value: m.dispatcherOn(), inputs: [] }, reason: { state: 'ok', value: null, inputs: [] } } };
});
vi.mock('./dispatcher/dispatcher-agent-card-source', async (original) => {
  const actual = await original<typeof import('./dispatcher/dispatcher-agent-card-source')>();
  return { ...actual, readAgentCardView: () => { throw new Error('ordinary description reader must not be read'); } };
});
vi.mock('./agent-grants-service', async (original) => {
  const actual = await original<typeof import('./agent-grants-service')>();
  return { ...actual, viewOf: () => { throw new Error('ordinary grants must not be read'); } };
});

vi.mock('./actions', async () => ({ readActionDetailsForAgent: (agentId: string, projectId: string, dispatcher: boolean, names: import('../../shared/actions').ActionNames) => projectActionDetails({ list: m.actions, lastRunForDisplay: (id: string) => m.actions().find((a: { id: string }) => a.id === id)?.lastRun }, agentId, projectId, dispatcher, names), peekActionProjectName: () => 'Project' }));
vi.mock('./canvas-store-reader', () => ({ getAgentCanvasMemberships: m.canvases }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ liveEntries: m.entries, getTemplate: m.template }), statusFor: m.status }));
vi.mock('./agent-settings-service', () => ({ readMcpConfig: m.mcp, readLaunchWrapper: async () => undefined, readDefaultMcps: async () => [] }));
vi.mock('./git-service', () => ({ getBranchChanges: m.branch }));
vi.mock('../orchestrators', () => ({ isSessionCapable: () => true, getProvider: (id: string) => m.catalog(id) }));

import { captureInstructionDisplayWitness } from './instruction-display-witness';
import { ChatDetailsRecorder } from './agent-runtime/chat-details-evidence';
import { MINIMAL_CHAT_CAPABILITIES } from '../../shared/chat';
import { projectActionDetails } from './actions/details-read';
import { readRemoteAgentDetails } from './remote-agent-details';
const agent = () => ({ id: 'a1', name: 'Selected', color: 'blue', createdAt: '2026-11-18', worktreePath: '/host/selected', branch: 'feature' });
const project = { id: 'p1', name: 'Project', path: '/host/project' };
const PEER_MACHINE = 'aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa';
const setting = () => ({ version: 1, agentId: 'a1', readOnly: true, provider: 'Host CLI', model: 'model', runtime: 'terminal', access: 'Ask first', executionPolicy: 'defaults', autoSleep: null, context: null, setup: { state: 'ok', managed: false, template: null, instructions: 'None', skills: null, mcps: null } });
beforeEach(() => {
  _resetAgentDisplayStateForTesting();
  m.realConnections = false; m.realPolicy = false; m.envCached.mockReturnValue(true); m.realDispatcher = false; m.realWitness = false; m.useRealRuntime = false; m.registration.mockReturnValue(undefined); m.runtime.mockReturnValue(undefined);
  m.target.mockResolvedValue({ agent: agent(), project });
  m.settings.mockResolvedValue({ status: 200, body: setting() });
  m.provider.mockReturnValue({ id: 'codex-cli', conventions: {}, readSessionTranscript: m.transcript });
  m.transcript.mockResolvedValue([]); m.historical.mockResolvedValue([{ type: 'result', duration_ms: 5000, total_cost_usd: 1.25 }]);
  m.catalog.mockImplementation((id: string) => ({ id, displayName: id === 'claude-code' ? 'Host Current Claude' : id, readSessionTranscript: m.historical }));
  m.running.mockReturnValue(false);
  m.policies.mockReturnValue(new Map([['a1', ORCHESTRATION_DEFAULTS]]));
  m.helpers.mockResolvedValue([]); m.requests.mockReturnValue([]); m.work.mockResolvedValue({ dirty: 0, unpushed: 0, unmerged: null });
  m.bindings.mockReturnValue([]); m.connectionFixture.mockResolvedValue({ pairs: [], unreadable: [] }); m.satellite.mockReturnValue(null); m.peer.mockReturnValue(undefined); m.directions.mockReturnValue([]);
  m.dispatcher.mockReturnValue({ agentId: 'disp', config: { name: 'Host Dispatcher' } }); m.dispatcherOn.mockReturnValue(false);
  m.actions.mockReturnValue([]); m.canvases.mockResolvedValue([]);
  m.status.mockResolvedValue({ managed: false, running: false, waiting: false, changes: [] }); m.entries.mockResolvedValue({}); m.template.mockResolvedValue({ name: 'Template' });
  m.mcp.mockResolvedValue([]); m.branch.mockResolvedValue({ available: true, branch: 'feature', base: 'main', files: [] }); m.connection.mockReturnValue(null);
});
const read = async () => {
  const response = await readRemoteAgentDetails('a1', () => true);
  expect(response.status).toBe(200);
  expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
  return response.body as RemoteAgentDetails;
};
describe('host selected-agent Details projections', () => {
  it.each(['same', 'missing-source', 'legacy-source', 'broken-index', 'missing-index', 'withheld', 'truncated', 'missing-controller', 'wrong-role', 'name-collision', 'controller-late', 'grants-late', 'description-late', 'source-late', 'switch-late', 'switch-off', 'switch-unknown', 'connected-off', 'revoked', 'both', 'both-level-late', 'both-controller-late', 'both-revoked'] as const)('composes selected passive Dispatcher metadata and final receipts: %s', async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-dispatcher-')));
    const getPath = vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); m.base = root; m.realWitness = true; m.realDispatcher = true;
    const selectedFolder = path.join(root, 'project'), controllerFolder = path.join(root, 'dispatcher');
    const selected = { ...agent(), worktreePath: selectedFolder }, controller = { ...agent(), id: 'controller1', name: 'Operations', worktreePath: controllerFolder, PRIVATE_CONFIG: 'PRIVATE_PROVIDER_ENV' };
    const selectedProject = { ...project, path: selectedFolder }, controllerProject = { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: controllerFolder };
    for (const folder of [selectedFolder, controllerFolder]) await fs.mkdir(path.join(folder, '.clubhouse'), { recursive: true });
    await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify([selectedProject]));
    await fs.writeFile(path.join(selectedFolder, '.clubhouse', 'agents.json'), JSON.stringify([selected]));
    const controllerFile = path.join(controllerFolder, '.clubhouse', 'agents.json'); await fs.writeFile(controllerFile, JSON.stringify([controller]));
    m.target.mockImplementation(async (id: string, _path: unknown, options: { strict?: boolean }) => {
      expect(options).toEqual({ strict: true });
      if (id !== 'controller1') return { agent: selected, project: selectedProject };
      return { agent: mode === 'name-collision' ? { ...controller, id: 'other', name: 'controller1' } : controller, project: mode === 'wrong-role' ? selectedProject : controllerProject };
    });
    m.dispatcher.mockReturnValue({ agentId: mode === 'missing-controller' ? null : 'controller1', chatAgentId: 'chat1' });
    m.policies.mockReturnValue(new Map([['a1', { ...ORCHESTRATION_DEFAULTS, orchestrate: mode.startsWith('both'), connectToDispatcher: mode !== 'connected-off' }]]));
    const liveRegistration = { projectPath: selectedFolder, cwd: selectedFolder, runtime: 'pty', orchestrator: 'claude-code', nonce: 'PRIVATE_CURRENT_NONCE', launchAccess: { freeAgentMode: true, permissionMode: 'auto', access: 'auto' } };
    if (mode.startsWith('both')) { m.running.mockReturnValue(true); m.registration.mockReturnValue(liveRegistration); }
    await fs.writeFile(path.join(root, 'dispatcher-settings.json'), mode === 'switch-unknown' ? '{broken' : JSON.stringify({ enabled: mode !== 'switch-off' }));
    const grantsFile = path.join(root, 'agent-grants.json'); await fs.writeFile(grantsFile, JSON.stringify({ agents: { controller1: { changes: [{ action: 'agent.restart', target: { kind: 'any' }, mode: 'allow' }] }, PRIVATE_UNRELATED: { changes: 'PRIVATE_GRANT' } } }));
    const index = path.join(root, 'dispatcher-agent-cards.json'), memory = path.join(root, 'memory'); await fs.mkdir(memory);
    if (mode !== 'missing-index') await fs.writeFile(index, mode === 'broken-index' ? '{broken' : JSON.stringify({ version: 1, agents: { a1: { page: 'selected', projectPath: selectedFolder, connected: true, setup: 'PRIVATE_SETUP' }, unrelated: { page: 'other', projectPath: '/other', connected: true, setup: 'PRIVATE_OTHER' } } }));
    const pageFile = agentPagePath('selected', memory); await fs.mkdir(path.dirname(pageFile), { recursive: true });
    await fs.writeFile(pageFile, renderAgentPage('PRIVATE_TITLE', { card: mode === 'withheld' ? 'When to reach it: apiKey = ("PRIVATE_SECRET")\nOwns: Selected component' : mode === 'truncated' ? 'When to reach it: ' + 'x'.repeat(900) + '\nOwns: Selected component' : 'When to reach it: Review selected work\nOwns: Selected component', notes: 'When to reach it: PRIVATE_NOTES' }));
    const ordinary = vi.fn(() => { throw new Error('ordinary source invoked'); });
    const source = { status: ordinary, saveUserCard: ordinary, ...(mode !== 'legacy-source' && { display: (id: string, folder: string, options: Parameters<typeof readAgentCardForDisplay>[3]) => readAgentCardForDisplay({ storePath: () => index, memoryRoot: memory }, id, folder, options) }) };
    setAgentCardSource(mode === 'missing-source' ? null : source);
    // These unrelated corrupt stores and old temporary files must survive a
    // cold display read; no generic initialization or recovery is authorized.
    await fs.writeFile(path.join(root, 'dispatcher-federation.json'), '{broken');
    await fs.writeFile(path.join(root, 'experimental-settings.json'), '{broken');
    for (const file of ['dispatcher-settings.json', 'agent-grants.json', 'dispatcher-federation.json', 'dispatcher-agent-cards.json']) {
      const temp = path.join(root, `.${file}.tmp-${process.pid + 100000}-1`); await fs.writeFile(temp, 'retain'); const old = new Date(Date.now() - 3 * 86400000); await fs.utimes(temp, old, old);
    }
    const disk = async (folder = root): Promise<unknown> => Object.fromEntries(await Promise.all((await fs.readdir(folder)).sort().map(async (name) => { const file = path.join(folder, name), stat = await fs.lstat(file); return [name, stat.isDirectory() ? { ino: stat.ino, files: await disk(file) } : { ino: stat.ino, mtimeMs: stat.mtimeMs, bytes: (await fs.readFile(file)).toString('base64') }]; })));
    const before = await disk(); let allowed = true;
    m.canvases.mockImplementation(async () => {
      if (mode === 'controller-late' || mode === 'both-controller-late') await fs.writeFile(controllerFile, JSON.stringify([{ ...controller, disposedAt: '2026-11-19' }]));
      if (mode === 'grants-late') await fs.writeFile(grantsFile, JSON.stringify({ agents: { controller1: { changes: [{ action: 'agent.message', target: { kind: 'connected' }, mode: 'off' }] } } }));
      if (mode === 'description-late') await fs.writeFile(pageFile, renderAgentPage('Title', { card: 'Owns: New selected component', notes: '' }));
      if (mode === 'source-late') setAgentCardSource(null);
      if (mode === 'switch-late') await fs.writeFile(path.join(root, 'dispatcher-settings.json'), '{"enabled":false}');
      if (mode === 'revoked' || mode === 'both-revoked') allowed = false;
      if (mode === 'both-level-late') liveRegistration.launchAccess = { freeAgentMode: false, permissionMode: 'auto', access: 'plan' };
      return [];
    });
    try {
      const response = await readRemoteAgentDetails('a1', () => allowed);
      const late = ['controller-late', 'grants-late', 'description-late', 'source-late', 'switch-late', 'both-level-late', 'both-controller-late'].includes(mode);
      expect.soft(response.status).toBe((mode === 'revoked' || mode === 'both-revoked') ? 403 : late ? 409 : 200);
      if (late || mode === 'revoked' || mode === 'both-revoked') expect.soft(JSON.stringify(response.body)).not.toMatch(/cards|providerId|Operations|Selected component/);
      else {
        expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
        const card = (response.body as RemoteAgentDetails).cards.find((c) => c.id === 'dispatcher')!;
        const unknown = ['missing-source', 'legacy-source', 'broken-index'].includes(mode), noController = ['missing-controller', 'wrong-role', 'name-collision'].includes(mode);
        expect(card.state).toBe(mode === 'switch-off' ? 'not-applicable' : unknown || noController || mode === 'switch-unknown' ? 'error' : 'ok');
        if (mode === 'switch-off') { expect(card.rows).toEqual([]); expect(m.target.mock.calls.map(([id]) => id)).toEqual(['a1', 'controller1']); expect(m.target.mock.calls.every(([, , options]) => options?.strict === true)).toBe(true); }
        else if (mode === 'connected-off') { expect(card.summary).toBe('not connected'); expect(card.rows).toEqual([{ label: 'Connected', value: 'Off' }]); }
        else {
          expect(card.title).toBe(noController ? 'Dispatcher' : 'Operations');
          expect(card.rows).toContainEqual({ label: 'Connected', value: 'On' });
          if (unknown) { expect(card.rows).toContainEqual({ label: 'Description', value: 'Unavailable from host metadata' }); expect(card.rows).not.toContainEqual({ label: 'Description', value: 'No description yet' }); }
          else if (mode === 'missing-index') expect(card.rows).toContainEqual({ label: 'Description', value: 'No description yet' });
          else { expect(card.rows).toContainEqual({ label: 'Owns', value: 'Selected component' }); if (mode === 'withheld') expect(card.notes.join(' ')).toContain('text withheld'); if (mode === 'truncated') expect(card.notes.join(' ')).toContain('fields truncated'); }
          if (!noController) expect(card.rows.some((r) => r.value.includes('Allow · set for every agent'))).toBe(true);
        }
        if (mode === 'both') expect((response.body as RemoteAgentDetails).cards.find((c) => c.id === 'orchestrate')?.rows).toContainEqual({ label: 'Helper access ceiling', value: 'At most Auto, Selected’s level now.' });
        expect.soft(JSON.stringify(response.body)).not.toMatch(/PRIVATE_|receipts|primarySignature|"current":/);
      }
      expect.soft(ordinary).not.toHaveBeenCalled();
      if (!late) expect.soft(await disk()).toEqual(before);
    } finally { setAgentCardSource(null); resetAllSettingsStoresForTests(); getPath.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(['on', 'off', 'missing-controller', 'mismatched-id', 'wrong-folder', 'unreadable-primary', 'removed-late', 'role-cleared-late', 'revoked'] as const)('uses only a strictly admitted canonical Dispatcher wires identity: %s', async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-dispatcher-wires-'))); m.base = root; m.realWitness = true; m.realDispatcher = true;
    const folder = path.join(root, 'dispatcher'), chatFolder = path.join(root, 'dispatcher-chat');
    const controller = { ...agent(), id: 'controller1', name: 'Operations', worktreePath: folder }, chat = { ...agent(), id: 'chat1', name: 'Dispatcher chat', worktreePath: chatFolder };
    for (const [dir, config] of [[folder, controller], [chatFolder, chat]] as const) { await fs.mkdir(path.join(dir, '.clubhouse'), { recursive: true }); await fs.writeFile(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify([config])); }
    const primary = path.join(folder, '.clubhouse', 'agents.json'); if (mode === 'unreadable-primary') await fs.writeFile(primary, '{broken');
    m.dispatcher.mockReturnValue({ agentId: mode === 'missing-controller' ? null : 'controller1', chatAgentId: 'chat1' });
    m.target.mockImplementation(async (id: string, _path: unknown, options: { strict?: boolean }) => {
      expect(options).toEqual({ strict: true });
      if (id === 'chat1') return { agent: chat, project: { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: chatFolder } };
      if (mode === 'unreadable-primary') throw new Error('Unreadable primary');
      return { agent: mode === 'mismatched-id' ? { ...controller, id: 'other', name: 'controller1' } : controller, project: { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: mode === 'wrong-folder' ? chatFolder : folder } };
    });
    m.dispatcherOn.mockReturnValue(mode !== 'off'); m.settings.mockResolvedValue({ status: 200, body: { ...setting(), agentId: 'chat1' } });
    let allowed = true;
    m.connectionFixture.mockImplementation(async (id: string) => {
      expect(id).toBe('controller1');
      if (mode === 'removed-late') await fs.writeFile(primary, '[]');
      if (mode === 'role-cleared-late') m.dispatcher.mockReturnValue({ agentId: null, chatAgentId: 'chat1' });
      if (mode === 'revoked') allowed = false;
      return { pairs: [], unreadable: [] };
    });
    try {
      const response = await readRemoteAgentDetails('chat1', () => allowed);
      const late = ['removed-late', 'role-cleared-late'].includes(mode), missing = ['missing-controller', 'mismatched-id', 'wrong-folder', 'unreadable-primary'].includes(mode);
      expect.soft(response.status).toBe(mode === 'revoked' ? 403 : late ? 409 : 200);
      if (late || mode === 'revoked') expect.soft(JSON.stringify(response.body)).not.toMatch(/cards|providerId|Operations/);
      else {
        expect(isRemoteAgentDetails(response.body, 'chat1')).toBe(true);
        const cards = (response.body as RemoteAgentDetails).cards;
        const connections = cards.find((c) => c.id === 'connections')!;
        expect(connections.state).toBe(missing ? 'error' : 'ok');
        if (missing) { expect(m.connectionFixture).not.toHaveBeenCalled(); expect(connections.notes.join(' ')).not.toContain('No Clubhouse MCP wires'); }
        else expect(m.connectionFixture).toHaveBeenCalledWith('controller1');
        for (const id of ['dispatcher', 'orchestrate', 'skills-mcp', 'session', 'canvases', 'changes']) expect(cards.find((c) => c.id === id)?.state).toBe('not-applicable');
      }
      expect(m.target.mock.calls.every(([id]) => ['chat1', 'controller1'].includes(id))).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(['same', 'missing-record', 'stopped', 'late-level', 'late-nonce', 'late-replacement', 'late-untrack', 'revoked'] as const)('binds the corresponding helper ceiling note through full Details assembly: %s', async (mode) => {
    const r = { projectPath: project.path, cwd: '/host/selected', runtime: 'pty', orchestrator: 'claude-code', nonce: 'PRIVATE_RUN_NONCE', launchAccess: mode === 'missing-record' ? undefined : { freeAgentMode: true, permissionMode: 'auto', access: 'auto' } };
    m.registration.mockReturnValue(mode === 'stopped' ? undefined : r); m.running.mockReturnValue(mode !== 'stopped');
    m.policies.mockReturnValue(new Map([['a1', { ...ORCHESTRATION_DEFAULTS, orchestrate: true, access: 'bypass' }]]));
    let allowed = true;
    m.canvases.mockImplementation(async () => {
      if (mode === 'late-level') r.launchAccess = { freeAgentMode: false, permissionMode: 'auto', access: 'plan' };
      if (mode === 'late-nonce') r.nonce = 'PRIVATE_NEW_NONCE';
      if (mode === 'late-replacement') m.registration.mockReturnValue({ ...r });
      if (mode === 'late-untrack') m.registration.mockReturnValue(undefined);
      if (mode === 'revoked') allowed = false;
      return [];
    });
    const response = await readRemoteAgentDetails('a1', () => allowed), late = mode.startsWith('late-');
    expect.soft(response.status).toBe(mode === 'revoked' ? 403 : late ? 409 : 200);
    if (late || mode === 'revoked') expect.soft(JSON.stringify(response.body)).not.toMatch(/cards|providerId|Selected runs at/);
    else {
      expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
      const card = (response.body as RemoteAgentDetails).cards.find((c) => c.id === 'orchestrate')!;
      expect(card.rows).toContainEqual({ label: 'Helper access ceiling', value: mode === 'missing-record' ? 'Unavailable from current host run metadata' : mode === 'stopped' ? 'Never more than Selected’s level when a helper starts.' : 'Selected runs at Auto now, so helpers get Auto.' });
      expect(card.state).toBe(mode === 'missing-record' ? 'error' : 'ok');
      expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_RUN|PRIVATE_NEW|launchAccess|permissionMode/);
      if (mode === 'same') expect(card.notes.join(' ')).toContain('recorded by Clubhouse');
    }
  });

  it.each(['same', 'disposed', 'removed', 'same-bytes-replaced', 'cache-cleared', 'cache-moved', 'revoked'] as const)('keeps an actual sleeping Dispatcher primary receipt through the final connection await: %s', async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-role-final-'))); m.base = root; m.realWitness = true;
    const folder = path.join(root, 'dispatcher'); const configs = path.join(folder, '.clubhouse'); await fs.mkdir(configs, { recursive: true });
    const selected = { ...agent(), id: 'disp', name: 'Selected Dispatcher', worktreePath: folder };
    const file = path.join(configs, 'agents.json'); const primary = JSON.stringify([selected]); await fs.writeFile(file, primary);
    m.target.mockResolvedValue({ agent: selected, project: { id: DISPATCHER_PROJECT_ID, path: folder, name: 'Dispatcher' } });
    m.settings.mockResolvedValue({ status: 200, body: { ...setting(), agentId: 'disp' } });
    let allowed = true;
    m.connectionFixture.mockImplementation(async () => {
      if (mode === 'disposed') await fs.writeFile(file, JSON.stringify([{ ...selected, disposedAt: '2026-11-19' }]));
      if (mode === 'removed') await fs.writeFile(file, '[]');
      if (mode === 'same-bytes-replaced') { await fs.rename(file, `${file}.old`); await fs.writeFile(file, primary); }
      if (mode === 'cache-cleared') m.dispatcher.mockReturnValue({ agentId: null });
      if (mode === 'cache-moved') m.dispatcher.mockReturnValue({ agentId: null, chatAgentId: 'disp' });
      if (mode === 'revoked') allowed = false;
      return { pairs: [], unreadable: [] };
    });
    try {
      const response = await readRemoteAgentDetails('disp', () => allowed);
      expect.soft(response.status).toBe(mode === 'same' ? 200 : mode === 'revoked' ? 403 : 409);
      if (mode === 'same') { expect(isRemoteAgentDetails(response.body, 'disp')).toBe(true); expect(await fs.readFile(file, 'utf8')).toBe(primary); }
      else expect.soft(JSON.stringify(response.body)).not.toMatch(/Selected Dispatcher|cards|providerId|Host CLI/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(['same', 'provider-changed', 'folder-changed'] as const)('separates current registered provider from inherited next-start choice and fences late evidence: %s', async (mode) => {
    m.provider.mockReturnValue({ id: 'codex-cli', displayName: 'Host Next Codex', conventions: {} });
    m.settings.mockResolvedValue({ status: 200, body: { ...setting(), provider: 'Host Next Codex', providerId: 'codex-cli' } });
    const recorder = new ChatDetailsRecorder('current-claude');
    recorder.observe({ v: 2, agentId: 'a1', sessionId: 's1', seq: 1, ts: 1, type: 'session_started', data: { provider: 'claude-code', driver: 'claude_agent_sdk', resumed: false, nativeSessionId: 'n1', cliVersion: '1.2.3', capabilities: MINIMAL_CHAT_CAPABILITIES, cwd: '/host/selected' } });
    const evidence = vi.fn(() => recorder.read(2));
    m.runtime.mockReturnValue({ kind: 'chat', getSessionId: () => 's1', getNativeSessionId: () => 'n1', getDetailsEvidence: evidence });
    const registration = { nonce: 'PRIVATE_NONCE', runtime: 'chat', orchestrator: 'claude-code', cwd: '/host/selected' };
    m.registration.mockReturnValue(registration); m.running.mockReturnValue(true);
    m.canvases.mockImplementation(async () => { if (mode === 'provider-changed') registration.orchestrator = 'codex-cli'; if (mode === 'folder-changed') registration.cwd = '/host/replacement'; return []; });
    const response = await readRemoteAgentDetails('a1', () => true);
    expect(response.status).toBe(mode === 'same' ? 200 : 409);
    if (mode === 'same') {
      expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
      expect(response.body).toMatchObject({ providerId: 'claude-code', providerLabel: 'Host Current Claude', settings: { providerId: 'codex-cli', provider: 'Host Next Codex' }, providerEvidence: { providerId: 'claude-code', values: { cliVersion: '1.2.3' } } });
      expect(JSON.stringify(response.body)).not.toContain('PRIVATE_NONCE');
    } else { expect(evidence).not.toHaveBeenCalled(); expect(JSON.stringify(response.body)).not.toContain('1.2.3'); }
  });
  it.each(['same', 'replacement', 'revoked'] as const)('projects current provider facts only after the complete Details assembly fence: %s', async (mode) => {
    const recorder = new ChatDetailsRecorder('display-a');
    recorder.observe({ v: 2, agentId: 'a1', sessionId: 's1', seq: 1, ts: 1, type: 'session_started', data: { driver: 'claude_agent_sdk', provider: 'claude-code', resumed: false, nativeSessionId: 'n1', cwd: '/host/selected', cliVersion: 'INITIAL_VERSION', capabilities: MINIMAL_CHAT_CAPABILITIES } });
    const getDetailsEvidence = vi.fn(() => recorder.read(2));
    const runtime = { kind: 'chat', getSessionId: () => 's1', getNativeSessionId: () => 'n1', getDetailsEvidence };
    m.runtime.mockReturnValue(runtime); m.running.mockReturnValue(true);
    const registration = { nonce: 'private-auth-nonce', runtime: 'chat' };
    m.registration.mockReturnValue(registration);
    m.provider.mockReturnValue({ id: 'claude-code', conventions: {} });
    let authorized = true;
    m.canvases.mockImplementation(async () => {
      if (mode === 'replacement') m.registration.mockReturnValue({ ...registration, nonce: 'new-private-nonce' });
      if (mode === 'revoked') authorized = false;
      return [];
    });
    const response = await readRemoteAgentDetails('a1', () => authorized);
    expect(response.status).toBe(mode === 'same' ? 200 : mode === 'replacement' ? 409 : 403);
    if (mode === 'same') {
      expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
      expect((response.body as RemoteAgentDetails).providerEvidence).toMatchObject({ runId: 'display-a', values: { cliVersion: 'INITIAL_VERSION' } });
      expect(JSON.stringify(response.body)).not.toContain('private-auth-nonce');
    } else { expect(getDetailsEvidence).not.toHaveBeenCalled(); expect(JSON.stringify(response.body)).not.toContain('INITIAL_VERSION'); }
  });
  it('does not describe a connected peer without a snapshot as cached name evidence', async () => {
    m.directions.mockReturnValue([{ from: { agentId: 'a1' }, to: { agentId: 'b', machineId: PEER_MACHINE }, disabledTools: [], link: { createdAt: '2026-11-19' }, updatedAt: '2026-11-19' }]);
    m.satellite.mockReturnValue({ alias: 'Studio', state: 'connected' });
    const connections = (await read()).cards.find((c) => c.id === 'connections')!;
    expect(connections.rows.find((r) => r.label === 'b')?.value).toContain('target name unavailable');
    expect(JSON.stringify(connections)).not.toContain('names from cached snapshot');
    expect(connections.notes.join(' ')).toContain('unavailable or ambiguous');
  });
  it('folds only the selected local agent’s network directions and projects cached peer fields without raw trust records or unrelated agents', async () => {
    const base = { disabledTools: ['send_message'], link: { createdAt: '2026-11-19' }, updatedAt: '2026-11-19' };
    m.directions.mockReturnValue([
      { ...base, from: { agentId: 'a1' }, to: { agentId: 'b', machineId: PEER_MACHINE } },
      { ...base, from: { agentId: 'b', machineId: PEER_MACHINE }, to: { agentId: 'a1' } },
      { ...base, from: { agentId: 'a1', machineId: 'PRIVATE_FOREIGN_FROM' }, to: { agentId: 'PRIVATE_OTHER_AGENT', machineId: 'PRIVATE_OTHER_MACHINE' } },
    ]);
    m.satellite.mockImplementation((id: string) => id === PEER_MACHINE ? { alias: 'Studio', state: 'disconnected', snapshotUnavailable: true,
      snapshot: { agents: { p1: [{ id: 'b', name: 'Peer B' }, { id: 'unrelated', name: 'PRIVATE_UNRELATED_NAME' }] }, quickAgents: {} }, tlsCertificatePem: 'PRIVATE_CERTIFICATE' } : null);
    m.peer.mockReturnValue({ alias: 'Saved alias', lastSeen: '2026-11-19T00:00:00Z', publicKey: 'PRIVATE_UNUSED_TRUST_RECORD' });
    const value = await read();
    const connections = value.cards.find((c) => c.id === 'connections')!;
    expect.soft(connections.summary).toBe('0 local directions · 1 remote connections');
    expect.soft(connections.rows.find((r) => r.label === 'Peer B on Studio')?.value).toContain('two-way records');
    expect.soft(connections.rows.find((r) => r.label === 'Peer B on Studio')?.value).toContain('saved network link · names from retained metadata');
    expect.soft(connections.rows.find((r) => r.label === 'Peer B on Studio host record')?.value).toBe('Studio · retained transport: disconnected · snapshot missing or incomplete');
    expect.soft(connections.rows.find((r) => r.label === 'Peer B on Studio outgoing switches')?.value).toContain('Off: Send messages');
    expect.soft(connections.notes.join(' ')).not.toContain('No Clubhouse MCP wires');
    expect.soft(JSON.stringify(value)).not.toMatch(/PRIVATE_OTHER|PRIVATE_UNRELATED|PRIVATE_CERTIFICATE|PRIVATE_UNUSED/i);
    expect.soft(m.satellite.mock.calls.every(([id]) => id === PEER_MACHINE)).toBe(true);
  });
  it('never substitutes a different cached agent’s name when the saved network target is absent', async () => {
    m.directions.mockReturnValue([{ from: { agentId: 'a1' }, to: { agentId: 'missing', machineId: PEER_MACHINE }, disabledTools: [], link: { createdAt: '2026-11-19' }, updatedAt: '2026-11-19' }]);
    m.satellite.mockReturnValue({ alias: 'Studio', state: 'connected', snapshot: { agents: { p: [{ id: 'different', name: 'PRIVATE_OTHER_AGENT_NAME' }] }, quickAgents: {} } });
    const c = (await read()).cards.find((c) => c.id === 'connections')!;
    expect.soft(c.rows.some((r) => r.label === 'missing')).toBe(true);
    expect.soft(c.notes.join(' ')).toContain('target name is unavailable or ambiguous');
    expect.soft(JSON.stringify(c)).not.toContain('PRIVATE_OTHER_AGENT_NAME');
  });
  it.each(['parent-removal', 'earlier-helper-release', 'cross-project-reparent', 'disposed-reparent'] as const)('withholds complete Details when real primary membership changes after helper work: %s', async (condition) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-final-inventory-'));
    try {
      m.realWitness = true; m.base = path.join(root, 'profile');
      const home = path.join(root, 'home'), other = path.join(root, 'other');
      await fs.mkdir(m.base); await fs.mkdir(path.join(home, '.clubhouse'), { recursive: true }); await fs.mkdir(path.join(other, '.clubhouse'), { recursive: true });
      const selected = { ...agent(), worktreePath: home };
      const p1 = { id: 'p1', name: 'Home', path: home }, p2 = { id: 'p2', name: 'Other', path: other };
      const a = { ...selected, id: 'h1', name: 'First helper', parentAgentId: 'a1', ...(condition === 'disposed-reparent' && { disposedAt: '2026-11-19' }) };
      const b = { ...selected, id: 'h2', name: 'Second helper', parentAgentId: 'a1' };
      const cross = condition === 'cross-project-reparent' || condition === 'disposed-reparent';
      if (cross) Object.assign(a, { parentProjectPath: home, worktreePath: other });
      const homeRows = cross ? [selected] : [selected, a, b], otherRows = cross ? [a] : [];
      const homeFile = path.join(home, '.clubhouse', 'agents.json'), otherFile = path.join(other, '.clubhouse', 'agents.json');
      await fs.writeFile(homeFile, JSON.stringify(homeRows)); await fs.writeFile(otherFile, JSON.stringify(otherRows));
      await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [p1, p2] }));
      m.target.mockResolvedValue({ agent: selected, project: p1 });
      const realIndex = await vi.importActual<typeof import('./helper-index')>('./helper-index');
      let acquired = false;
      let actualReceipts: Array<{ current(): boolean }> = [];
      m.helpers.mockImplementation(async (...args: Parameters<typeof realIndex.listHelpersEverywhere>) => {
        const entries = await realIndex.listHelpersEverywhere(...args);
        expect(entries.map((entry) => entry.config.id)).toEqual(cross ? ['h1'] : ['h1', 'h2']);
        actualReceipts = args[2]?.receipts ?? [];
        expect(actualReceipts).toHaveLength(2);
        expect(actualReceipts.every((receipt) => receipt.current())).toBe(true);
        acquired = true;
        return entries;
      });
      let calls = 0;
      m.work.mockImplementation(async () => {
        if (++calls === 2 && condition === 'earlier-helper-release') await fs.writeFile(homeFile, JSON.stringify([selected, { ...a, parentAgentId: 'other' }, b]));
        return { dirty: 1, unpushed: 2, unmerged: null };
      });
      m.canvases.mockImplementation(async () => {
        if (condition === 'parent-removal') await fs.writeFile(homeFile, JSON.stringify([a, b]));
        if (cross) await fs.writeFile(otherFile, JSON.stringify([{ ...a, parentAgentId: 'other' }]));
        return [];
      });
      const result = await readRemoteAgentDetails('a1', () => true);
      expect(result.status).toBe(409);
      expect(result.body).not.toHaveProperty('cards');
      expect(acquired).toBe(true);
      expect(actualReceipts.some((receipt) => !receipt.current())).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('projects only the selected agent’s verified bounded canvas membership navigation identities', async () => {
    m.canvases.mockResolvedValue([{ name: 'Host board', scope: 'app', canvasId: 'board', viewId: 'view' }]);
    const value = await read();
    expect(value.cards.find((c) => c.id === 'canvases')?.rows).toEqual([{ label: 'Host board', value: 'Home', canvas: { scope: 'app', canvasId: 'board', viewId: 'view' } }]);
  });
  it('projects policy and the selected host folder/branch without invented usage or local defaults', async () => {
    const value = await read();
    expect(value.cards.find((c) => c.id === 'orchestrate')?.rows).toContainEqual({ label: 'At once', value: '5' });
    expect(value.cards.find((c) => c.id === 'session')?.rows).toContainEqual({ label: 'Folder', value: '/host/selected' });
    expect(m.branch).not.toHaveBeenCalled(); // strict paged Changes uses its own selected-target read, never this swallowing legacy reader.
    expect(m.helpers).toHaveBeenCalledWith('/host/project', 'a1', { includeDisposed: true, readOnly: true, receipts: expect.any(Array) });
    expect(m.canvases).toHaveBeenCalledWith('a1', 'p1', { strict: true });
    expect(value.cards.find((c) => c.id === 'dispatcher')?.state).toBe('not-applicable');
    expect(m.transcript).not.toHaveBeenCalled();
  });
  it('returns only touching connections and related actions, never private definitions or unrelated records', async () => {
    m.bindings.mockReturnValue([{ agentId: 'a1', targetId: 'b', targetKind: 'agent', label: 'Peer', instructions: { '*': 'PRIVATE_INSTRUCTIONS' } }, { agentId: 'x', targetId: 'y', targetKind: 'agent', label: 'UNRELATED_WIRE' }]);
    const action = (id: string, target: string) => ({ id, name: id, owner: { kind: 'agent', agentId: 'owner' }, enabled: true, trigger: { kind: 'once', at: Date.now() }, steps: [{ kind: 'message', agentId: target, message: 'PRIVATE_ACTION_MESSAGE' }] });
    m.actions.mockReturnValue([action('related', 'a1'), action('UNRELATED_ACTION', 'other')]);
    const value = await read();
    const text = JSON.stringify(value);
    expect(text).toContain('related'); expect(text).toContain('Peer');
    for (const privateText of ['PRIVATE_INSTRUCTIONS', 'PRIVATE_ACTION_MESSAGE', 'UNRELATED_ACTION', 'UNRELATED_WIRE']) expect(text).not.toContain(privateText);
  });
  it.each(['agent', 'dispatcher'] as const)('projects selected %s Actions relationship groups and safe last-run fields only', async (kind) => {
    const id = kind === 'dispatcher' ? 'disp' : 'a1'; m.target.mockResolvedValue({ agent: { ...agent(), id }, project });
    m.settings.mockResolvedValue({ status: 200, body: { ...setting(), agentId: id } });
    const base = { enabled: false, running: false, trigger: { kind: 'once', at: 1000 }, steps: [{ kind: 'message', agentId: id, text: 'PRIVATE_ACTION_MESSAGE' }], lastRun: { outcome: 'done', startedAt: 1000, reason: 'PRIVATE_RUN_REASON', steps: ['PRIVATE_RUN_STEPS'], chain: ['PRIVATE_CHAIN'] } };
    const owned = { ...base, id: 'mine', name: 'My reminder', owner: kind === 'dispatcher' ? { kind: 'dispatcher' } : { kind: 'agent', agentId: id }, trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: id } } };
    const targeted = { ...base, id: 'targeted', name: 'Targets me', owner: { kind: 'user' } };
    const unrelated = { ...base, id: 'other', name: 'PRIVATE_UNRELATED_NAME', owner: { kind: 'agent', agentId: 'other' }, steps: [{ kind: 'message', agentId: 'other', text: 'PRIVATE_UNRELATED_TEXT' }] };
    m.actions.mockReturnValue([owned, targeted, unrelated]);
    const response = await readRemoteAgentDetails(id, () => true); expect(response.status).toBe(200); expect(isRemoteAgentDetails(response.body, id)).toBe(true);
    const c = (response.body as RemoteAgentDetails).cards.find((c) => c.id === 'actions')!;
    expect(c.summary).toBe(kind === 'dispatcher' ? '1 made by the Dispatcher' : '2 related');
    expect(c.rows.filter((r) => r.label === 'My reminder').map((r) => r.action?.group)).toEqual(kind === 'dispatcher' ? ['dispatcher'] : ['owned', 'targeting', 'triggered-by']);
    expect(c.rows[0].action).toMatchObject({ enabled: false, lastRun: { outcome: 'done', startedAt: 1000 } });
    expect(c.rows[0].value).toContain('Off'); expect(c.rows[0].value).toContain('done');
    expect(JSON.stringify(c)).not.toMatch(/PRIVATE_/); expect(c.rows.every((r) => r.action?.description)).toBe(true);
  });
  it('counts bounded action relationship rows and makes omissions explicit without truncating a last-run record', async () => {
    m.actions.mockReturnValue(Array.from({ length: 55 }, (_, i) => ({ id: `action${i}`, name: `Reminder${i}`, owner: { kind: 'agent', agentId: 'a1' }, enabled: true, steps: [{ kind: 'wake', agentId: 'a1', prompt: 'PRIVATE_PROMPT' }], trigger: { kind: 'once', at: 1000 } })));
    const c = (await read()).cards.find((c) => c.id === 'actions')!;
    expect(c.summary).toBe('55 related'); expect(c.rows).toHaveLength(100); expect(c.omitted).toBe(10);
    expect(c.rows.every((r) => r.action?.group === 'owned' || r.action?.group === 'targeting')).toBe(true); expect(JSON.stringify(c)).not.toContain('PRIVATE_PROMPT');
  });
  it('binds last-session usage to the selected saved session and provider, not a broad session list', async () => {
    m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }] }, project });
    const value = await read();
    expect(m.historical).toHaveBeenCalledWith('selected-last', '/host/selected', { maxBytes: 2097152, stats: expect.any(Object), passiveLookup: true });
    expect(m.transcript).not.toHaveBeenCalled();
    expect(value.cards.find((c) => c.id === 'session')?.rows).toContainEqual({ label: 'Last CLI', value: 'Host Current Claude' });
    expect(value.cards.find((c) => c.id === 'session')?.rows).toContainEqual({ label: 'Cost', value: '$1.25' });
  });
  it.each(['missing', 'unrelated', 'unset', 'conflicting', 'partly-unset'] as const)('keeps historical provider attribution unknown with %s association', async (mode) => {
    const record = { sessionId: 'selected-last', orchestrator: 'claude-code' };
    const sessionHistory = mode === 'missing' ? undefined : mode === 'unrelated' ? [{ ...record, sessionId: 'other' }] : mode === 'unset' ? [{ sessionId: 'selected-last' }] : [record, mode === 'conflicting' ? { ...record, orchestrator: 'codex-cli' } : { sessionId: 'selected-last' }];
    m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory }, project });
    const c = (await read()).cards.find((c) => c.id === 'session')!;
    expect.soft(m.transcript).not.toHaveBeenCalled(); expect.soft(m.historical).not.toHaveBeenCalled();
    expect.soft(c.rows).toContainEqual({ label: 'Last CLI', value: 'Not recorded unambiguously for this session' });
    expect.soft(c.notes.join(' ')).toContain('configured next-start provider is not used');
  });
  it.each(['zero', 'missing', 'truncated'] as const)('preserves historical reported values and completeness: %s', async (mode) => {
    m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }], lastSleep: { at: '2026-11-19T01:00:00Z', reason: 'exited' } }, project });
    const transcript = async (_id: string, _cwd: string, options: { stats?: Record<string, unknown> }) => {
      if (options.stats) Object.assign(options.stats, { truncated: mode === 'truncated', fileBytes: mode === 'truncated' ? 4000000 : 100, bytesRead: 100 });
      return [{ type: 'result', ...(mode !== 'missing' && { duration_ms: 0, total_cost_usd: 0 }) }];
    };
    m.transcript.mockImplementation(transcript); m.historical.mockImplementation(transcript);
    const c = (await read()).cards.find((c) => c.id === 'session')!;
    expect.soft(c.rows).toContainEqual({ label: 'Duration', value: mode === 'missing' ? 'Not reported' : '0s' });
    expect.soft(c.rows).toContainEqual({ label: 'Cost', value: mode === 'missing' ? 'Not reported' : '$0.00' });
    expect.soft(c.rows.filter((r) => r.label === 'Ended')).toEqual([{ label: 'Ended', value: '2026-11-19T01:00:00Z' }]);
    expect.soft(c.rows).toContainEqual({ label: 'Why', value: 'CLI exited' });
    expect.soft(c.notes.join(' ')).toContain(mode === 'truncated' ? 'truncated' : 'complete file');
  });
  it.each(['uninstalled', 'no-transcript', 'no-results', 'unknown-completeness', 'invalid-totals', 'unsafe-id'] as const)('keeps historical availability explicit: %s', async (mode) => {
    const lastSessionId = mode === 'unsafe-id' ? '../other' : 'selected-last';
    m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId, sessionHistory: [{ sessionId: lastSessionId, orchestrator: 'claude-code' }] }, project });
    if (mode === 'uninstalled') m.catalog.mockReturnValue(undefined);
    else m.historical.mockResolvedValue(mode === 'no-transcript' ? null : mode === 'no-results' ? [{ type: 'user', message: 'PRIVATE_TEXT' }] : [{ type: 'result', duration_ms: mode === 'invalid-totals' ? -1 : 5000, total_cost_usd: mode === 'invalid-totals' ? Infinity : 1.25 }]);
    const c = (await read()).cards.find((c) => c.id === 'session')!;
    expect(m.transcript).not.toHaveBeenCalled(); expect(JSON.stringify(c)).not.toContain('PRIVATE_TEXT');
    if (mode === 'uninstalled' || mode === 'unsafe-id') { expect(m.historical).not.toHaveBeenCalled(); expect(c.notes.join(' ')).toMatch(/does not support|cannot be read safely/); }
    else {
      expect(m.historical).toHaveBeenCalledTimes(1); expect(c.notes.join(' ')).toContain('did not report whether');
      if (mode === 'no-transcript') expect(c.notes.join(' ')).toContain('Usage is unknown');
      if (mode === 'no-results' || mode === 'invalid-totals') for (const label of ['Duration', 'Cost']) expect(c.rows).toContainEqual({ label, value: 'Not reported' });
      if (mode === 'unknown-completeness') expect(c.rows).toContainEqual({ label: 'Duration', value: '5s' });
    }
  });
  it.each(['cold', 'warm'] as const)('does not initialize shell environment for historical display: %s', async (mode) => {
    const shell = await vi.importActual<typeof import('../util/shell')>('../util/shell');
    const { execSync } = await import('child_process'); const platform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' }); shell.invalidateShellEnvironmentCache(); vi.mocked(execSync).mockClear();
      m.envCached.mockImplementation(shell.isShellEnvironmentCached);
      if (mode === 'warm') { shell.getShellEnvironment(); expect(execSync).toHaveBeenCalledTimes(1); vi.mocked(execSync).mockClear(); }
      m.historical.mockImplementation(async () => { shell.getShellEnvironment(); return [{ type: 'result', duration_ms: 0, total_cost_usd: 0 }]; });
      m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }] }, project });
      const c = (await read()).cards.find((c) => c.id === 'session')!;
      expect.soft(execSync).not.toHaveBeenCalled(); expect.soft(m.transcript).not.toHaveBeenCalled();
      if (mode === 'cold') { expect.soft(m.historical).not.toHaveBeenCalled(); expect.soft(c.notes.join(' ')).toContain('not cached'); expect.soft(shell.isShellEnvironmentCached()).toBe(false); }
      else { expect(m.historical).toHaveBeenCalledTimes(1); expect(c.rows).toContainEqual({ label: 'Cost', value: '$0.00' }); }
    } finally { Object.defineProperty(process, 'platform', { value: platform }); shell.invalidateShellEnvironmentCache(); }
  });
  it('keeps a limited historical native lookup unknown rather than verified missing or empty', async () => {
    m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }] }, project });
    m.historical.mockImplementation(async (_id, _cwd, options) => { options.stats.lookupIncomplete = true; return null; });
    const c = (await read()).cards.find((c) => c.id === 'session')!;
    expect(m.historical).toHaveBeenCalledWith('selected-last', '/host/selected', expect.objectContaining({ passiveLookup: true }));
    expect(c.notes.join(' ')).toContain('bounded limit or an unreadable directory'); expect(c.notes.join(' ')).toContain('availability is unknown');
    expect(c.rows.some((r) => r.label === 'Cost' || r.label === 'Duration')).toBe(false);
  });
  it.each(['small', 'truncated'] as const)('reads historical native provider file with real byte bound and unchanged storage: %s', async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-history-native-'));
    const platform = process.platform;
    const shell = await vi.importActual<typeof import('../util/shell')>('../util/shell');
    const { execSync } = await import('child_process');
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' }); shell.invalidateShellEnvironmentCache();
      vi.mocked(execSync).mockReturnValue(`CLAUDE_CONFIG_DIR=${root}\n`); shell.getShellEnvironment(); vi.mocked(execSync).mockClear();
      m.envCached.mockImplementation(shell.isShellEnvironmentCached);
      const folder = path.join(root, 'projects', '-host-selected'); await fs.mkdir(folder, { recursive: true });
      const file = path.join(folder, 'selected-last.jsonl');
      const result = (duration_ms: number, total_cost_usd: number) => JSON.stringify({ type: 'result', duration_ms, total_cost_usd });
      const filler = JSON.stringify({ type: 'user', message: 'PRIVATE_HISTORY_TEXT'.repeat(512) });
      const text = [result(1000, 10), ...(mode === 'truncated' ? Array(400).fill(filler) : []), result(0, 0), ''].join('\n');
      await fs.writeFile(file, text); const before = await fs.stat(file); const entries = await fs.readdir(folder);
      const { ClaudeCodeProvider } = await vi.importActual<typeof import('../orchestrators/claude-code-provider')>('../orchestrators/claude-code-provider');
      const provider = new ClaudeCodeProvider();
      const originalLookup = provider.transcriptPath.bind(provider);
      const lookup = vi.spyOn(provider, 'transcriptPath').mockImplementation(async (...args) => { const selected = await originalLookup(...args); shell.invalidateShellEnvironmentCache(); return selected; }); const nativeRead = vi.spyOn(provider, 'readSessionTranscript');
      m.catalog.mockReturnValue(provider);
      m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }] }, project });
      const c = (await read()).cards.find((c) => c.id === 'session')!;
      expect(lookup).toHaveBeenCalledWith('selected-last', '/host/selected', expect.objectContaining({ passiveLookup: true, maxBytes: 2097152 })); expect(m.transcript).not.toHaveBeenCalled();
      expect(execSync).not.toHaveBeenCalled(); expect(shell.isShellEnvironmentCached()).toBe(false);
      expect(nativeRead).toHaveBeenCalledTimes(1); const options = nativeRead.mock.calls[0][2]!;
      expect(options.maxBytes).toBe(2097152); expect(options.stats?.fileBytes).toBe(Buffer.byteLength(text));
      expect(options.stats?.bytesRead).toBeLessThanOrEqual(2097152);
      expect(c.notes.join(' ')).toContain(mode === 'truncated' ? 'truncated' : 'complete file');
      if (mode === 'truncated') { expect(Buffer.byteLength(text)).toBeGreaterThan(2097152); expect(options.stats?.truncated).toBe(true); }
      expect(c.rows).toContainEqual({ label: 'Duration', value: '0s' }); expect(c.rows).toContainEqual({ label: 'Cost', value: '$0.00' });
      expect(c.rows.some((r) => r.label === 'Ended')).toBe(false); expect(JSON.stringify(c)).not.toContain('PRIVATE_HISTORY_TEXT');
      expect(await fs.readFile(file, 'utf8')).toBe(text); expect(await fs.readdir(folder)).toEqual(entries);
      const after = await fs.stat(file); expect({ size: after.size, mtimeMs: after.mtimeMs, ino: after.ino }).toEqual({ size: before.size, mtimeMs: before.mtimeMs, ino: before.ino });
      expect(liveProbes.model).not.toHaveBeenCalled(); expect(liveProbes.quota).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', { value: platform }); shell.invalidateShellEnvironmentCache(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(['inventory', 'revocation'] as const)('withholds historical evidence after awaited %s change with real primary witness', async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-history-witness-'));
    try {
      m.realWitness = true; m.base = path.join(root, 'profile'); const home = path.join(root, 'home');
      await fs.mkdir(m.base); await fs.mkdir(path.join(home, '.clubhouse'), { recursive: true });
      const selected = { ...agent(), worktreePath: home, lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }] };
      const selectedProject = { ...project, path: home }; const file = path.join(home, '.clubhouse', 'agents.json');
      await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [selectedProject] })); await fs.writeFile(file, JSON.stringify([selected]));
      m.target.mockResolvedValue({ agent: selected, project: selectedProject }); let allowed = true;
      const transcript = async () => {
        if (mode === 'inventory') await fs.writeFile(file, JSON.stringify([{ ...selected, sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'codex-cli' }] }])); else allowed = false;
        return [{ type: 'result', total_cost_usd: 42 }];
      };
      m.historical.mockImplementation(transcript); m.transcript.mockImplementation(transcript);
      const response = await readRemoteAgentDetails('a1', () => allowed);
      expect(response.status).toBe(mode === 'inventory' ? 409 : 403); expect(response.body).not.toHaveProperty('cards');
      expect(m.historical).toHaveBeenCalledTimes(1); expect(m.transcript).not.toHaveBeenCalled();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('distinguishes verified empty, per-section error and explicit bounded omissions', async () => {
    m.actions.mockImplementation(() => { throw new Error('PRIVATE_ERROR'); });
    m.canvases.mockResolvedValue(Array.from({ length: 112 }, (_, i) => ({ name: `Board ${i}`, scope: 'project' })));
    const value = await read();
    expect(value.cards.find((c) => c.id === 'actions')).toMatchObject({ state: 'error', rows: [] });
    expect(value.cards.find((c) => c.id === 'connections')).toMatchObject({ state: 'ok', rows: [], summary: '0 known directions' });
    expect(value.cards.find((c) => c.id === 'canvases')).toMatchObject({ state: 'ok', omitted: 12 });
    expect(JSON.stringify(value)).not.toContain('PRIVATE_ERROR');
  });
  it('rejects aliases/disposed agents and rechecks authority after awaited work', async () => {
    m.target.mockResolvedValueOnce({ agent: { ...agent(), id: 'other' }, project });
    expect((await readRemoteAgentDetails('a1', () => true)).status).toBe(404);
    expect(m.provider).not.toHaveBeenCalled();
    let allowed = true;
    m.provider.mockImplementation(async () => { allowed = false; return { id: 'codex-cli' }; });
    expect((await readRemoteAgentDetails('a1', () => allowed)).status).toBe(403);
    expect(m.settings).not.toHaveBeenCalled();
  });
  it('rejects late results after revocation and never returns partial private host data', async () => {
    let allowed = true;
    m.canvases.mockImplementation(async () => { allowed = false; return [{ name: 'PRIVATE_BOARD', scope: 'project' }]; });
    const response = await readRemoteAgentDetails('a1', () => allowed);
    expect(response.status).toBe(403); expect(JSON.stringify(response)).not.toContain('PRIVATE_BOARD');
    expect(m.branch).not.toHaveBeenCalled();
  });
  it('does not claim an earlier run’s retained MCP handshake or tool count is current', async () => {
    m.running.mockReturnValue(true);
    m.registration.mockReturnValue({ cwd: '/host/selected', runtime: 'pty', nonce: 'run-a' });
    noteAgentStarting('a1');
    m.connection.mockReturnValue({ connectedAt: 1, toolCount: 999 });
    let value = await read();
    let evidence = value.cards.find((c) => c.id === 'skills-mcp')!;
    expect(JSON.stringify(evidence)).not.toContain('999 tools');
    expect(JSON.stringify(evidence)).not.toContain('Connected');
    m.connection.mockReturnValue({ connectedAt: Date.now() + 1, toolCount: 12, current: true });
    value = await read(); evidence = value.cards.find((c) => c.id === 'skills-mcp')!;
    expect(JSON.stringify(evidence)).toContain('12 tools');
    _resetAgentDisplayStateForTesting();
    // Matching bridge auth identity proves the run even if lifecycle time is unknown.
    expect(JSON.stringify((await read()).cards.find((c) => c.id === 'skills-mcp'))).toContain('12 tools');
    m.running.mockReturnValue(false);
    expect(JSON.stringify((await read()).cards.find((c) => c.id === 'skills-mcp'))).not.toContain('Connected');
  });
  it('shares helper counters/work words, skips inapplicable checks and makes the work bound explicit', async () => {
    const helpers = Array.from({ length: 10 }, (_, i) => ({ projectPath: project.path, config: { ...agent(), id: `h${i}`, name: `Helper ${i}`, parentAgentId: 'a1' } }));
    helpers.push({ projectPath: project.path, config: { ...agent(), id: 'starting', name: 'Starting helper', parentAgentId: 'a1', creation: { state: 'creating' } } } as never);
    helpers.push({ projectPath: project.path, config: { ...agent(), id: 'disposed', name: 'Disposed helper', parentAgentId: 'a1', disposedAt: '2026-11-19' } } as never);
    m.helpers.mockResolvedValue(helpers);
    m.work.mockResolvedValueOnce({ dirty: 2, unpushed: 150, unmerged: 0 }).mockResolvedValueOnce({ dirty: 0, unpushed: 0, unmerged: null, error: 'unknown' });
    const c = (await read()).cards.find((c) => c.id === 'orchestrate')!;
    expect(c.rows).toContainEqual({ label: 'Helpers', value: '11 · 1 starting' });
    expect(c.rows).toContainEqual({ label: 'Disposed helpers', value: '1' });
    expect(c.rows.find((r) => r.label === 'Helper 0')?.value).toContain('2 uncommitted, 99+ unpushed');
    expect(c.rows.find((r) => r.label === 'Helper 1')?.value).toContain('couldn’t check');
    expect(c.rows.find((r) => r.label === 'Helper 2')?.value).toContain('clean');
    expect(c.rows.find((r) => r.label === 'Helper 8')?.value).toContain('Work not checked');
    expect(c.notes.join(' ')).toContain('2 helper work checks omitted');
    expect(m.work).toHaveBeenCalledTimes(8);
    expect(m.work.mock.calls.every((call) => call[0].agent.id === 'a1' && call[1].config.parentAgentId === 'a1')).toBe(true);
  });
  it('keeps disposed and live handed-off helpers distinct with their real timestamps', async () => {
    m.helpers.mockResolvedValue([{ projectPath: project.path, config: { ...agent(), id: 'disposed', name: 'Disposed helper', disposedAt: '2026-11-18T12:00:00Z' } }, { projectPath: project.path, config: { ...agent(), id: 'handoff', name: 'Handed helper', handoff: { at: '2026-11-19' } } }]);
    const rows = (await read()).cards.find((c) => c.id === 'orchestrate')!.rows;
    expect(rows.find((r) => r.label === 'Disposed helper')?.value).toContain('Disposed · feature · 2026-11-18T12:00:00Z');
    expect(rows.find((r) => r.label === 'Handed helper')?.value).toContain('Handed off');
  });
  it.each([1024, 1025, 2048])('keeps nested Settings valid for a %i-character MCP name', async (length) => {
    m.mcp.mockResolvedValue([{ name: 'a'.repeat(length) }]);
    const value = await read();
    expect(value.settings?.setup.mcps?.[0].length).toBeLessThanOrEqual(1024);
    if (length > 1024) expect(value.settings?.setup.mcps?.[0]).toContain('[text truncated]');
  });
  it('keeps unreadable global MCP config unknown, preserving other independent cards', async () => {
    m.mcp.mockRejectedValue(new Error('unreadable-global'));
    const value = await read();
    expect(value.cards.find((c) => c.id === 'settings')?.state).toBe('error');
    expect(value.settings?.setup.mcps).toBeNull();
    expect(JSON.stringify(value)).not.toContain('0 configured');
    expect(value.cards.find((c) => c.id === 'connections')?.state).toBe('ok');
  });
  it('accepts a stable registered PTY using the real resolver despite new facade objects per lookup', async () => {
    m.useRealRuntime = true; m.running.mockReturnValue(true);
    m.registration.mockReturnValue({ cwd: '/host/selected', runtime: 'pty', orchestrator: 'codex-cli', nonce: 'run-a' });
    const resolver = await import('./agent-runtime');
    expect(resolver.getAgentRuntime('a1')).not.toBe(resolver.getAgentRuntime('a1'));
    expect((await read()).running).toBe(true);
  });
  it.each(['pty', 'headless'] as const)('refuses a %s registration replacement across an awaited section', async (runtime) => {
    m.useRealRuntime = true; m.running.mockReturnValue(true);
    m.registration.mockReturnValue({ cwd: '/host/selected', runtime, orchestrator: 'codex-cli', nonce: 'run-a' });
    m.canvases.mockImplementation(async () => { m.registration.mockReturnValue({ cwd: '/host/selected', runtime, orchestrator: 'codex-cli', nonce: 'run-b' }); return []; });
    expect(await readRemoteAgentDetails('a1', () => true)).toMatchObject({ status: 409, body: { error: 'agent_run_changed' } });
  });
  it('refuses stopped headless/PTY evidence across an awaited section', async () => {
    m.useRealRuntime = true; m.running.mockReturnValue(true);
    m.registration.mockReturnValue({ cwd: '/host/selected', runtime: 'headless', nonce: 'run-a' });
    m.canvases.mockImplementation(async () => { m.running.mockReturnValue(false); m.registration.mockReturnValue(undefined); return []; });
    expect((await readRemoteAgentDetails('a1', () => true)).status).toBe(409);
  });
});

it.each(['same', 'changed', 'created', 'revoked'] as const)('holds a real selected instruction receipt across later Details card work: %s', async (mode) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-settings-final-'))), file = path.join(root, 'CLAUDE.md');
  if (mode !== 'created') await fs.writeFile(file, 'Selected instructions');
  let allowed = true; const selected = { agent: agent(), project };
  m.target.mockResolvedValue(selected);
  m.settings.mockImplementation(async (_id: string, _authorized: () => boolean, options: { admittedTarget: unknown; receipts: Array<{ current(): boolean }> }) => {
    expect(options.admittedTarget).toBe(selected);
    options.receipts.push(captureInstructionDisplayWitness(root, 'CLAUDE.md'));
    return { status: 200, body: setting() };
  });
  m.connectionFixture.mockImplementation(async () => { if (mode !== 'same') await fs.writeFile(file, 'Changed instructions'); if (mode === 'revoked') allowed = false; return { pairs: [], unreadable: [] }; });
  try {
    const result = await readRemoteAgentDetails('a1', () => allowed);
    expect.soft(result.status).toBe(mode === 'same' ? 200 : mode === 'revoked' ? 403 : 409);
    if (mode === 'same') expect.soft(isRemoteAgentDetails(result.body, 'a1')).toBe(true);
    else expect.soft(JSON.stringify(result.body)).not.toMatch(/cards|Host CLI|Selected|providerId/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('keeps independently known Settings rows when the unchanged v1 contract cannot express unknown runtime', async () => {
  m.settings.mockResolvedValue({ status: 503, body: { error: 'settings_evidence_unavailable' }, display: { id: 'settings', title: 'Settings', state: 'error', summary: 'Some host settings are unavailable', rows: [{ label: 'Next start model', value: 'HOST_SAVED_MODEL' }, { label: 'Next wake', value: 'Unavailable from host settings' }], notes: ['Known host fields remain available independently.'], omitted: 0, observedAt: Date.now() } });
  const result = await read(); expect(result.settings).toBeNull();
  expect(result.cards.find((card) => card.id === 'settings')).toMatchObject({ state: 'error', rows: expect.arrayContaining([{ label: 'Next start model', value: 'HOST_SAVED_MODEL' }, { label: 'Next wake', value: 'Unavailable from host settings' }]) });
});


describe('actual selected Connections receipts at the complete Details boundary', () => {
  it.each(['unchanged', 'binding', 'source', 'primary', 'revoked-and-changed'] as const)('retains actual admitted selected evidence across a later card await: %s', async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-connection-')));
    const getPath = vi.spyOn(app, 'getPath').mockReturnValue(root);
    const { bindingManager } = await import('./clubhouse-mcp/binding-manager');
    const sources = await import('./persisted-bindings');
    const { readConnectionDirectionsForDisplay } = await import('./connection-directions-display');
    m.realConnections = true; resetAllSettingsStoresForTests(); bindingManager._resetForTesting(); sources._resetPersistedBindingSourcesForTesting();
    bindingManager.setConnectionToolsSource(null, null); bindingManager.setConnectionInstructionsSource(null);
    const collect = vi.fn(async () => []);
    sources.registerPersistedBindingSource({ id: 'selected-test-source', collect });
    await sources.rebuildPersistedBindings(); collect.mockClear();
    expect(sources.claimSourceBinding('selected-test-source', { agentId: 'a1', targetId: 'selected-target', targetKind: 'agent', label: 'Selected target before', targetName: 'Selected target before' })).toBe('created');
    const file = path.join(root, 'connection-grants.json');
    const put = (disabledTools: string[]) => fs.writeFile(file, JSON.stringify({ version: 1, directions: [{ from: { agentId: 'a1' }, to: { agentId: 'selected-target' }, disabledTools, link: { createdAt: '2026-11-19T00:00:00Z' } }] }));
    await put([]);
    const admitted: Array<{ current(): boolean }> = [];
    expect(bindingManager.readBindingsForDisplay('a1', { direction: 'outgoing', receipts: admitted }).state).toBe('ok');
    expect(sources.readCachedConnectionSourcesForDisplay('a1', { receipts: admitted }).state).toBe('ok');
    expect(readConnectionDirectionsForDisplay('a1', { receipts: admitted }).state).toBe('ok');
    expect(admitted.every((receipt) => receipt.current())).toBe(true);
    let allowed = true, laterRead = false;
    m.canvases.mockImplementation(async () => {
      laterRead = true;
      // These are real owner/primary changes AFTER the Connections producer
      // returns, not a mocked receipt returning false or an admission hook.
      if (mode === 'binding') bindingManager.updateBinding('a1', 'selected-target', { targetName: 'Selected target after' });
      if (mode === 'source' || mode === 'revoked-and-changed') sources.markSourceRemovedByUser('selected-test-source', 'a1', 'selected-target');
      if (mode === 'primary') await put(['read_output']);
      if (mode === 'revoked-and-changed') allowed = false;
      return [];
    });
    try {
      const response = await readRemoteAgentDetails('a1', () => allowed);
      expect(laterRead).toBe(true); expect(m.connectionFixture).not.toHaveBeenCalled(); expect(collect).not.toHaveBeenCalled();
      expect(admitted.every((receipt) => receipt.current())).toBe(mode === 'unchanged');
      if (mode === 'unchanged') {
        expect(response.status).toBe(200); expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
        expect((response.body as RemoteAgentDetails).cards.find((card) => card.id === 'connections')?.rows.some((row) => row.label === 'Selected target before')).toBe(true);
      } else {
        expect.soft(response.status).toBe(mode === 'revoked-and-changed' ? 403 : 409);
        expect.soft(response.body).toEqual({ error: mode === 'revoked-and-changed' ? 'details_read_refused' : 'connection_evidence_changed' });
        expect.soft(response.body).not.toHaveProperty('cards'); expect.soft(response.body).not.toHaveProperty('providerId'); expect.soft(response.body).not.toHaveProperty('settings');
      }
    } finally {
      m.realConnections = false; sources._resetPersistedBindingSourcesForTesting(); bindingManager._resetForTesting(); resetAllSettingsStoresForTests(); getPath.mockRestore(); await fs.rm(root, { recursive: true, force: true });
    }
  });
});


describe('cold manual Dispatcher link evidence at final Details assembly', () => {
  it.each(['unchanged', 'primary-late', 'owner-only-late', 'revoked-and-primary'] as const)('keeps independent saved and process-known final receipts: %s', async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-manual-link-')));
    const getPath = vi.spyOn(app, 'getPath').mockReturnValue(root), projectPath = path.join(root, 'selected-project');
    const source = await import('./dispatcher-saved-links-display'), owner = await import('./dispatcher-connections');
    const { bindingManager } = await import('./clubhouse-mcp/binding-manager'); const sources = await import('./persisted-bindings');
    m.base = root; m.realConnections = true; resetAllSettingsStoresForTests(); owner._resetDispatcherConnectionsForTesting(); bindingManager._resetForTesting(); sources._resetPersistedBindingSourcesForTesting();
    m.target.mockResolvedValue({ agent: agent(), project: { ...project, path: projectPath } });
    const file = path.join(root, 'dispatcher-connections.json'), pending = path.join(root, 'dispatcher-connections.pending-removals.json');
    const pair = { agentId: 'a1', targetId: 'manual-target' };
    const putLinks = (version = 1, targetId = pair.targetId) => fs.writeFile(file, JSON.stringify({ version, connections: [{ ...pair, targetId, agentProjectPath: projectPath, targetProjectPath: '/other-project', createdBy: 'controller', createdAt: '2026-11-19T00:00:00Z', PRIVATE_ARGS: 'PRIVATE_CONFIG' }], removedByUser: [] }));
    await putLinks();
    const primary: Array<{ current(): boolean }> = [], memory: Array<{ current(): boolean }> = [];
    expect(source.readSavedDispatcherLinksForDisplay('a1', projectPath, { receipts: primary })).toMatchObject({ state: 'ok', value: { total: 1 } });
    expect(owner.readDispatcherLinkMemoryForDisplay('a1', projectPath, [pair], { receipts: memory })).toMatchObject({ state: 'ok', value: { rows: [{ pendingRemoval: { value: false } }] } });
    expect([...primary, ...memory].every((receipt) => receipt.current())).toBe(true);
    let allowed = true, entered = false, removed: boolean | undefined;
    m.canvases.mockImplementation(async () => {
      entered = true;
      if (mode === 'primary-late' || mode === 'revoked-and-primary') await putLinks(1, 'changed-target');
      if (mode === 'owner-only-late') {
        // Actual owner admission/removal. Restore committed semantic fields and
        // delete its saved queue file so ONLY the independent owner receipt
        // changes; no mocked current() result or local fallback is involved.
        await putLinks(2); removed = await owner.recordUserRemoval(pair); await putLinks(); await fs.unlink(pending);
      }
      if (mode === 'revoked-and-primary') allowed = false;
      return [];
    });
    try {
      const response = await readRemoteAgentDetails('a1', () => allowed); expect(entered).toBe(true); expect(m.connectionFixture).not.toHaveBeenCalled();
      if (mode === 'owner-only-late') {
        expect(removed).toBe(true); expect(primary.every((receipt) => receipt.current())).toBe(true); expect(memory.some((receipt) => !receipt.current())).toBe(true);
        expect(source.readSavedDispatcherLinksForDisplay('a1', projectPath)).toMatchObject({ state: 'ok', value: { rows: [{ removalRecorded: { value: false } }] } });
        expect(owner.readDispatcherLinkMemoryForDisplay('a1', projectPath, [pair])).toMatchObject({ state: 'ok', value: { rows: [{ pendingRemoval: { value: true }, removalSaved: { value: true } }] } });
      }
      if (mode === 'primary-late' || mode === 'revoked-and-primary') { expect(primary.some((receipt) => !receipt.current())).toBe(true); expect(memory.every((receipt) => receipt.current())).toBe(true); }
      if (mode === 'unchanged') {
        expect(response.status).toBe(200); expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
        expect((response.body as RemoteAgentDetails).cards.find((card) => card.id === 'connections')?.rows.find((row) => row.label === 'manual-target saved Dispatcher link')?.value).toBe('No removal record in saved settings');
        expect((response.body as RemoteAgentDetails).cards.find((card) => card.id === 'connections')?.rows.find((row) => row.label === 'manual-target Dispatcher availability')?.value).toContain('This agent’s Connect to Dispatcher is off');
        expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_|createdBy|targetProjectPath/);
      } else {
        expect.soft(response.status).toBe(mode === 'revoked-and-primary' ? 403 : 409); expect.soft(response.body).toEqual({ error: mode === 'revoked-and-primary' ? 'details_read_refused' : 'connection_evidence_changed' });
        expect.soft(response.body).not.toHaveProperty('cards'); expect.soft(response.body).not.toHaveProperty('settings'); expect.soft(response.body).not.toHaveProperty('providerId');
      }
    } finally {
      m.realConnections = false; m.base = ''; owner._resetDispatcherConnectionsForTesting(); sources._resetPersistedBindingSourcesForTesting(); bindingManager._resetForTesting(); resetAllSettingsStoresForTests(); getPath.mockRestore(); await fs.rm(root, { recursive: true, force: true });
    }
  });
});
describe('admitted endpoint target fields at complete normal Details assembly', () => {
  it.each(['unchanged', 'related-primary-late', 'revoked-and-related-primary'] as const)('delivers qualified primary fields and preserves final refusal: %s', async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-endpoint-fields-'))), a = path.join(root, 'selected'), b = path.join(root, 'related');
    for (const folder of [a, b]) await fs.mkdir(path.join(folder, '.clubhouse'), { recursive: true });
    m.base = root; m.realConnections = true; m.realWitness = true;
    const selected = { ...agent(), orchestrator: 'codex-cli' as const, worktreePath: a }, selectedProject = { ...project, path: a };
    await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ version: 1, projects: [selectedProject, { id: 'p-related', name: 'Related project', path: b }] }));
    await fs.writeFile(path.join(a, '.clubhouse', 'agents.json'), JSON.stringify([selected]));
    const related = { id: 'qualified-target', name: 'Qualified target', color: 'blue', createdAt: '2026-11-19', orchestrator: 'codex-cli', orchestration: { connectToDispatcher: false }, instructions: 'PRIVATE_RELATED_INSTRUCTIONS', env: { key: 'PRIVATE_RELATED_KEY' } };
    const relatedFile = path.join(b, '.clubhouse', 'agents.json'); await fs.writeFile(relatedFile, JSON.stringify([related]));
    await fs.writeFile(path.join(root, 'dispatcher-connections.json'), JSON.stringify({ version: 1, connections: [{ agentId: 'a1', targetId: related.id, agentProjectPath: a, targetProjectPath: b, createdBy: 'a1', createdAt: '2026-11-19T00:00:00Z' }], removedByUser: [] }));
    m.target.mockResolvedValue({ agent: selected, project: selectedProject });
    const saved = await import('./dispatcher-saved-links-display'), parentReceipts: Array<{ current(): boolean }> = [];
    expect(saved.readSavedDispatcherLinksForDisplay('a1', a, { receipts: parentReceipts })).toMatchObject({ state: 'ok', value: { total: 1 } }); expect(parentReceipts.every((r) => r.current())).toBe(true);
    const module = await import('./remote-connection-card'), original = module.readPassiveConnectionCard;
    let captured: import('../../shared/remote-agent-details').RemoteDetailsCard | undefined, allowed = true, hookReached = false, mutated = false, oldReceiptsCurrent: boolean | undefined;
    let observed: { name: boolean; saved?: string; memory?: string } | undefined;
    const capture = vi.spyOn(module, 'readPassiveConnectionCard').mockImplementation(async (...args) => { await original(...args); captured = args[0]; });
    m.canvases.mockImplementationOnce(async () => {
      hookReached = true; observed = { name: captured?.rows.some((r) => r.label === 'Qualified target') === true, saved: captured?.rows.find((r) => r.label === 'Qualified target saved target')?.value, memory: captured?.rows.find((r) => r.label === 'Qualified target host memory target')?.value };
      if (mode !== 'unchanged') { await fs.writeFile(relatedFile, JSON.stringify([{ ...related, name: 'Changed related primary' }])); mutated = true; }
      oldReceiptsCurrent = parentReceipts.every((r) => r.current()); // Assert OUTSIDE application's section error catch.
      if (mode === 'revoked-and-related-primary') allowed = false;
      return [];
    });
    try {
      const response = await readRemoteAgentDetails('a1', () => allowed);
      expect(hookReached).toBe(true); expect(observed?.name).toBe(true); expect(observed?.saved).toContain('Connect to Dispatcher Off'); expect(observed?.memory).toBe('Host memory not loaded'); expect(oldReceiptsCurrent).toBe(true); expect(mutated).toBe(mode !== 'unchanged');
      if (mutated) expect(JSON.parse(await fs.readFile(relatedFile, 'utf8'))[0].name).toBe('Changed related primary');
      if (mode === 'unchanged') {
        expect(response.status).toBe(200); expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
        const c = (response.body as RemoteAgentDetails).cards.find((c) => c.id === 'connections'); expect(c?.rows.some((r) => r.label === 'Qualified target')).toBe(true); expect(JSON.stringify(c)).not.toMatch(/PRIVATE_|expectedProjectNamespace|rootNamespace|agentProjectPath|targetProjectPath/); expect(JSON.stringify(c)).not.toContain(root);
      } else {
        expect.soft(response.status).toBe(mode === 'revoked-and-related-primary' ? 403 : 409); expect.soft(response.body).not.toHaveProperty('cards'); expect.soft(response.body).not.toHaveProperty('settings'); expect.soft(response.body).not.toHaveProperty('providerId');
      }
    } finally { capture.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('cold selected saved automatic Dispatcher source at whole Details assembly', () => {
  it.each(['on', 'off', 'unknown-controller', 'wrong-role', 'unreadable-controller', 'switch-late-off', 'controller-late-off', 'role-late-off', 'selected-late-off', 'revoked-off'] as const)('uses passive admitted policy/controller and final receipts: %s', async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-automatic-'))), a = path.join(root, 'selected'), d = path.join(root, 'dispatcher');
    const getPath = vi.spyOn(app, 'getPath').mockReturnValue(root);
    const selected = { ...agent(), worktreePath: a, orchestration: { orchestrate: false, connectToDispatcher: true } }, selectedProject = { ...project, path: a };
    const canonical = { ...agent(), id: 'controller1', name: 'Admitted Operations', worktreePath: d, env: { token: 'PRIVATE_CONTROLLER_ENV' } };
    for (const folder of [a, d]) await fs.mkdir(path.join(folder, '.clubhouse'), { recursive: true });
    const selectedFile = path.join(a, '.clubhouse', 'agents.json'), controllerFile = path.join(d, '.clubhouse', 'agents.json');
    await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ version: 1, projects: [selectedProject] })); await fs.writeFile(selectedFile, JSON.stringify([selected])); await fs.writeFile(controllerFile, mode === 'unreadable-controller' ? '{broken' : JSON.stringify([canonical]));
    await fs.writeFile(path.join(root, 'dispatcher-settings.json'), JSON.stringify({ enabled: mode === 'on' }));
    m.base = root; m.realConnections = true; m.realPolicy = true; m.realDispatcher = true; m.realWitness = true; resetAllSettingsStoresForTests();
    m.dispatcher.mockReturnValue({ agentId: mode === 'unknown-controller' ? null : 'controller1', chatAgentId: 'chat1' });
    m.target.mockImplementation(async (id: string) => id === 'a1' ? { agent: selected, project: selectedProject } : { agent: canonical, project: mode === 'wrong-role' ? selectedProject : { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: d } });
    const sources = await import('./persisted-bindings'), { bindingManager } = await import('./clubhouse-mcp/binding-manager'); sources._resetPersistedBindingSourcesForTesting(); bindingManager._resetForTesting();
    const collect = vi.fn(async () => { await fs.writeFile(path.join(root, 'unexpected-marker'), 'called'); return []; }); const stop = sources.registerPersistedBindingSource({ id: 'dispatcher-wires', collect, inspect: collect });
    const module = await import('./remote-connection-card'), original = module.readPassiveConnectionCard; let captured: RemoteAgentDetails['cards'][number] | undefined, reached = false, observed = false, allowed = true;
    const capture = vi.spyOn(module, 'readPassiveConnectionCard').mockImplementation(async (...args) => { await original(...args); captured = args[0]; });
    m.canvases.mockImplementationOnce(async () => {
      reached = true; observed = captured?.rows.some((r) => r.label === 'Admitted Operations' && r.value.includes('two-way records')) === true;
      if (mode === 'switch-late-off') await fs.writeFile(path.join(root, 'dispatcher-settings.json'), JSON.stringify({ enabled: true }));
      if (mode === 'controller-late-off') await fs.writeFile(controllerFile, JSON.stringify([{ ...canonical, disposedAt: '2026-11-19' }]));
      if (mode === 'role-late-off') m.dispatcher.mockReturnValue({ agentId: 'replacement-controller', chatAgentId: 'chat1' });
      if (mode === 'selected-late-off') await fs.writeFile(selectedFile, JSON.stringify([{ ...selected, orchestration: { orchestrate: false, connectToDispatcher: false } }]));
      if (mode === 'revoked-off') allowed = false;
      return [];
    });
    const snapshot = async (folder = root): Promise<unknown> => Object.fromEntries(await Promise.all((await fs.readdir(folder)).sort().map(async (name) => { const f = path.join(folder, name), st = await fs.lstat(f); return [name, st.isDirectory() ? { ino: st.ino, files: await snapshot(f) } : { ino: st.ino, mtime: st.mtimeMs, bytes: (await fs.readFile(f)).toString('base64') }]; })));
    const before = await snapshot();
    try {
      const response = await readRemoteAgentDetails('a1', () => allowed), unknown = ['unknown-controller', 'wrong-role', 'unreadable-controller'].includes(mode), late = mode.endsWith('-late-off');
      expect(reached).toBe(true); expect(observed).toBe(!unknown); expect(collect).not.toHaveBeenCalled(); expect(m.connectionFixture).not.toHaveBeenCalled(); expect(m.target.mock.calls.every(([, , options]) => options?.strict === true)).toBe(true);
      if (mode === 'controller-late-off') expect(JSON.parse(await fs.readFile(controllerFile, 'utf8'))[0].disposedAt).toBe('2026-11-19');
      if (mode === 'selected-late-off') expect(JSON.parse(await fs.readFile(selectedFile, 'utf8'))[0].orchestration.connectToDispatcher).toBe(false);
      if (mode === 'role-late-off') expect(m.dispatcher().agentId).toBe('replacement-controller');
      expect.soft(response.status).toBe(mode === 'revoked-off' ? 403 : late ? 409 : 200);
      if (late || mode === 'revoked-off') { expect.soft(response.body).not.toHaveProperty('cards'); expect.soft(response.body).not.toHaveProperty('settings'); expect.soft(response.body).not.toHaveProperty('providerId'); }
      else {
        expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true); const c = (response.body as RemoteAgentDetails).cards.find((c) => c.id === 'connections');
        if (unknown) expect.soft(c?.notes.join(' ')).toContain('Automatic Dispatcher source details are unavailable');
        else { expect.soft(c?.rows.find((r) => r.label === 'Host Dispatcher')?.value).toBe(mode === 'on' ? 'On' : 'Off'); expect.soft(c?.rows.filter((r) => r.label.endsWith('automatic starting switches'))).toHaveLength(2); }
        expect.soft(JSON.stringify(response.body)).not.toMatch(/PRIVATE_|controllerReceipts|primarySignature|"current":/);
      }
      if (!late) expect.soft(await snapshot()).toEqual(before);
    } finally { capture.mockRestore(); stop(); sources._resetPersistedBindingSourcesForTesting(); bindingManager._resetForTesting(); resetAllSettingsStoresForTests(); getPath.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('whole Details joins configured sources only through admitted endpoint project identity', () => {
  it.each(['cross-project', 'convergent', 'convergent-controller-late', 'cross-project-primary-late', 'cross-project-revoked'] as const)('preserves distinct source associations and final evidence: %s', async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-source-identity-'))), a = path.join(root, 'selected'), b = path.join(root, 'ordinary'), d = path.join(root, 'dispatcher');
    const getPath = vi.spyOn(app, 'getPath').mockReturnValue(root), selected = { ...agent(), worktreePath: a, orchestration: { orchestrate: false, connectToDispatcher: true } }, selectedProject = { ...project, path: a };
    const canonical = { ...agent(), id: 'controller1', name: 'Operations', worktreePath: d, orchestration: { connectToDispatcher: true }, env: { token: 'PRIVATE_ROLE_ENV' } }, ordinary = { ...canonical, name: 'Project agent', worktreePath: b, orchestration: { connectToDispatcher: false } };
    const convergent = mode.startsWith('convergent'), manualProject = convergent ? d : b;
    for (const [folder, config] of [[a, selected], [b, ordinary], [d, canonical]] as const) { await fs.mkdir(path.join(folder, '.clubhouse'), { recursive: true }); await fs.writeFile(path.join(folder, '.clubhouse', 'agents.json'), JSON.stringify([config])); }
    await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ version: 1, projects: [selectedProject, { id: 'related', name: 'Manual endpoint project', path: manualProject }] }));
    await fs.writeFile(path.join(root, 'dispatcher-settings.json'), JSON.stringify({ enabled: false }));
    await fs.writeFile(path.join(root, 'dispatcher-connections.json'), JSON.stringify({ version: 1, connections: [{ agentId: 'a1', targetId: 'controller1', agentProjectPath: a, targetProjectPath: manualProject, createdBy: 'a1', createdAt: '2026-11-19T00:00:00Z' }], removedByUser: [] }));
    m.base = root; m.realConnections = true; m.realPolicy = true; m.realDispatcher = true; m.realWitness = true; resetAllSettingsStoresForTests(); m.dispatcher.mockReturnValue({ agentId: 'controller1', chatAgentId: 'chat1' });
    m.target.mockImplementation(async (id: string) => id === 'a1' ? { agent: selected, project: selectedProject } : { agent: canonical, project: { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: d } });
    const sources = await import('./persisted-bindings'), { bindingManager } = await import('./clubhouse-mcp/binding-manager'); sources._resetPersistedBindingSourcesForTesting(); bindingManager._resetForTesting();
    const collect = vi.fn(async () => { await fs.writeFile(path.join(root, 'unexpected-marker'), 'called'); return []; }); const stop = sources.registerPersistedBindingSource({ id: 'dispatcher-wires', collect, inspect: collect });
    const saved = await import('./dispatcher-saved-links-display'), originalSourceReceipts: Array<{ current(): boolean }> = [];
    expect(saved.readSavedDispatcherLinksForDisplay('a1', a, { receipts: originalSourceReceipts })).toMatchObject({ state: 'ok', value: { total: 1 } });
    const module = await import('./remote-connection-card'), original = module.readPassiveConnectionCard;
    let captured: RemoteAgentDetails['cards'][number] | undefined, allowed = true, reached = false, observed: { automatic: boolean; manual: boolean; combined: number } | undefined;
    const capture = vi.spyOn(module, 'readPassiveConnectionCard').mockImplementation(async (...args) => { await original(...args); captured = args[0]; });
    m.canvases.mockImplementationOnce(async () => {
      reached = true; const rows = captured?.rows ?? [];
      observed = { automatic: rows.some((r) => r.label.startsWith('Operations') && r.value.includes('Connect to Dispatcher (saved policy)')), manual: rows.some((r) => r.label.startsWith(convergent ? 'Operations' : 'Project agent') && r.value.includes('Made by the Dispatcher (saved record')), combined: rows.filter((r) => r.value.includes('Connect to Dispatcher (saved policy)') && r.value.includes('Made by the Dispatcher (saved record')).length };
      if (mode === 'convergent-controller-late') await fs.writeFile(path.join(d, '.clubhouse', 'agents.json'), JSON.stringify([{ ...canonical, disposedAt: '2026-11-19' }]));
      if (mode === 'cross-project-primary-late') await fs.writeFile(path.join(b, '.clubhouse', 'agents.json'), JSON.stringify([{ ...ordinary, name: 'Changed project agent' }]));
      if (mode === 'cross-project-revoked') allowed = false;
      return [];
    });
    try {
      const response = await readRemoteAgentDetails('a1', () => allowed);
      expect(reached).toBe(true); expect(observed).toEqual({ automatic: true, manual: true, combined: convergent ? 1 : 0 }); expect(originalSourceReceipts.every((r) => r.current())).toBe(true); expect(collect).not.toHaveBeenCalled();
      if (mode === 'convergent-controller-late') expect(JSON.parse(await fs.readFile(path.join(d, '.clubhouse', 'agents.json'), 'utf8'))[0].disposedAt).toBe('2026-11-19');
      if (mode === 'cross-project-primary-late') expect(JSON.parse(await fs.readFile(path.join(b, '.clubhouse', 'agents.json'), 'utf8'))[0].name).toBe('Changed project agent');
      const changed = mode.endsWith('-late'); expect.soft(response.status).toBe(mode === 'cross-project-revoked' ? 403 : changed ? 409 : 200);
      if (changed || mode === 'cross-project-revoked') { expect.soft(response.body).not.toHaveProperty('cards'); expect.soft(response.body).not.toHaveProperty('settings'); expect.soft(response.body).not.toHaveProperty('providerId'); }
      else { expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true); expect.soft(JSON.stringify(response.body)).not.toMatch(/PRIVATE_|automaticControllerProjectPath|endpointProjects|identityGroup/); }
    } finally { capture.mockRestore(); stop(); sources._resetPersistedBindingSourcesForTesting(); bindingManager._resetForTesting(); resetAllSettingsStoresForTests(); getPath.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('selected registered Connections pages at final Details assembly', () => {
  it.each(['unchanged', 'related-primary-late', 'selected-removed', 'run-change', 'revoked'] as const)('keeps source continuation and final selected evidence fences: %s', async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-registered-page-'))), a = path.join(root, 'a'), b = path.join(root, 'b');
    for (const folder of [a, b]) await fs.mkdir(path.join(folder, '.clubhouse'), { recursive: true });
    m.base = root; m.realConnections = true; m.realWitness = true;
    const selected = { ...agent(), worktreePath: a, orchestrator: 'codex-cli' as const }, p = { ...project, path: a };
    await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ version: 1, projects: [p, { id: 'other-project', name: 'Other custom project', path: b }] }));
    await fs.writeFile(path.join(a, '.clubhouse', 'agents.json'), JSON.stringify([selected]));
    const relatedFile = path.join(b, '.clubhouse', 'agents.json'), children = Array.from({ length: 9 }, (_, i) => ({ id: 'helper-' + i, name: 'Helper ' + i, parentAgentId: 'a1', parentProjectPath: a, env: { token: 'PRIVATE_CREDENTIAL' } }));
    await fs.writeFile(relatedFile, JSON.stringify(children)); m.target.mockResolvedValue({ agent: selected, project: p });
    let allowed = true, reached = false, observed = false;
    const module = await import('./remote-connection-card'), original = module.readPassiveConnectionCard;
    const capture = vi.spyOn(module, 'readPassiveConnectionCard').mockImplementation(async (...args) => { await original(...args); observed = args[0].rows.some((r) => r.label === 'Helper 8 · Other custom project'); });
    m.canvases.mockImplementationOnce(async () => { reached = true; if (mode === 'related-primary-late') await fs.writeFile(relatedFile, '[]'); if (mode === 'selected-removed') await fs.writeFile(path.join(a, '.clubhouse', 'agents.json'), '[]'); if (mode === 'run-change') m.registration.mockReturnValue({ nonce: 'replacement-run' }); if (mode === 'revoked') allowed = false; return []; });
    try {
      const response = await readRemoteAgentDetails('a1', () => allowed, { card: 'connections', source: 'helpers', offset: 8, projectOffset: 0 });
      expect(reached).toBe(true); expect(observed).toBe(true);
      if (mode === 'unchanged') {
        expect(response.status).toBe(200); expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
        const body = response.body as RemoteAgentDetails, c = body.cards.find((c) => c.id === 'connections'); expect(body.connectionPages).toBe(1);
        expect(c?.connectionPage).toMatchObject({ source: 'helpers', offset: 8, known: 9, next: null }); expect(c?.rows.some((r) => r.label.includes('Helper 0'))).toBe(false); expect(JSON.stringify(c)).not.toMatch(/PRIVATE_|projectPath|namespace/);
      } else {
        expect.soft(response.status).toBe(mode === 'revoked' ? 403 : 409); expect.soft(response.body).not.toHaveProperty('cards'); expect.soft(response.body).not.toHaveProperty('providerId'); expect.soft(response.body).not.toHaveProperty('settings');
      }
    } finally { capture.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('cold saved tool-source connection pages in Details', () => {
  it.each(['unchanged', 'source-late', 'endpoint-late', 'revoked', 'display-reopen', 'display-stable', 'display-reopen-early', 'display-reopen-revoked'] as const)('projects source data without operational collection and retains final evidence: %s', async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-tool-page-'))), a = path.join(root, 'a'), b = path.join(root, 'b');
    for (const folder of [a, b]) await fs.mkdir(path.join(folder, '.clubhouse'), { recursive: true });
    m.base = root; m.realConnections = true; m.realWitness = true;
    const selected = { ...agent(), worktreePath: a, orchestrator: 'codex-cli' as const }, p = { ...project, path: a };
    await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ version: 1, projects: [p, { id: 'p-other', name: 'Other project', path: b }] }));
    await fs.writeFile(path.join(a, '.clubhouse', 'agents.json'), JSON.stringify([selected]));
    const endpoint = path.join(b, '.clubhouse', 'agents.json'); await fs.writeFile(endpoint, JSON.stringify([{ id: 'tool-target', name: 'Qualified tool target', env: { key: 'PRIVATE_ENDPOINT_ENV' } }]));
    const sourceFile = path.join(a, '.clubhouse', '.local', 'orchestrator-connections.json'); await fs.mkdir(path.dirname(sourceFile));
    await fs.writeFile(sourceFile, JSON.stringify({ version: 1, connections: [{ ownerId: 'a1', agentId: 'a1', targetId: 'tool-target', targetKind: 'agent', targetProjectPath: b, scope: 'granted', rawArgs: 'PRIVATE_ARGS', createdAt: '2026-11-20T00:00:00Z' }] }));
    let displayGeneration = 'admitted-display';
    const admittedRuntime = { kind: 'chat', getSessionId: () => 'same-app-session', getNativeSessionId: () => 'same-native-session', getDisplayRunId: () => displayGeneration };
    if (mode.startsWith('display-')) { m.running.mockReturnValue(true); m.runtime.mockReturnValue(admittedRuntime); m.registration.mockReturnValue({ nonce: 'same-registration', runtime: 'chat', orchestrator: 'codex-cli', cwd: a, projectPath: a }); }
    let earlyReached = false;
    if (mode === 'display-reopen-early') m.settings.mockImplementationOnce(async () => { earlyReached = true; displayGeneration = 'reopened-display'; return { status: 200, body: setting() }; });
    m.target.mockResolvedValue({ agent: selected, project: p }); let allowed = true, reached = false, observed = false, scopeObserved = false;
    const module = await import('./remote-connection-card'), original = module.readPassiveConnectionCard;
    const capture = vi.spyOn(module, 'readPassiveConnectionCard').mockImplementation(async (...args) => { await original(...args); observed = args[0].rows.some((r) => r.label === 'Qualified tool target · Project'); scopeObserved = args[0].rows.some((r) => r.value.includes('current grant not evaluated')); });
    m.canvases.mockImplementationOnce(async () => { reached = true; if (mode === 'source-late') await fs.writeFile(sourceFile, '{"version":1,"connections":[]}'); if (mode === 'endpoint-late') await fs.writeFile(endpoint, '[]'); if (mode === 'revoked' || mode === 'display-reopen-revoked') allowed = false; if (mode === 'display-reopen' || mode === 'display-reopen-revoked') displayGeneration = 'reopened-display'; return []; });
    try {
      const response = await readRemoteAgentDetails('a1', () => allowed, { card: 'connections', source: 'tool-records', offset: 0, projectOffset: 0 });
      expect(reached).toBe(true); expect(observed).toBe(true); expect(scopeObserved).toBe(true);
      if (mode.startsWith('display-')) { expect(m.runtime()).toBe(admittedRuntime); expect(admittedRuntime.getSessionId()).toBe('same-app-session'); expect(admittedRuntime.getNativeSessionId()).toBe('same-native-session'); expect(displayGeneration).toBe(mode === 'display-stable' ? 'admitted-display' : 'reopened-display'); if (mode === 'display-reopen-early') expect(earlyReached).toBe(true); }
      if (mode === 'unchanged' || mode === 'display-stable') {
        expect(response.status).toBe(200); expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true); const body = response.body as RemoteAgentDetails;
        expect(body.connectionPageSources).toContain('tool-records'); const c = body.cards.find((c) => c.id === 'connections'); expect(c?.connectionPage).toMatchObject({ source: 'tool-records', known: 1, complete: true, next: null });
        expect(JSON.stringify(c)).not.toMatch(/PRIVATE_|ownerId|projectPath|ProjectPath|rawArgs/); expect(JSON.stringify(c)).not.toContain(root);
      } else { expect.soft(response.status).toBe(mode === 'revoked' || mode === 'display-reopen-revoked' ? 403 : 409); expect.soft(response.body).not.toHaveProperty('cards'); expect.soft(response.body).not.toHaveProperty('settings'); expect.soft(response.body).not.toHaveProperty('providerId'); }
    } finally { capture.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
