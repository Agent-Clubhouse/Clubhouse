/** Actual Details -> Settings -> passive fields/provider/instruction read composition.
 * Other cards, target admission and runtime are modeled; selected storage is real. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import type { AgentConfigTarget } from './agent-config-reader';
import { isRemoteAgentDetails, type RemoteAgentDetails } from '../../shared/remote-agent-details';
const m = vi.hoisted(() => ({ target: vi.fn(), later: vi.fn(), instructionReturned: false, duringInstruction: vi.fn(), duringTemplate: vi.fn(), managed: false, service: null as { getTemplateForDisplay: (...args: any[]) => Promise<any> } | null, afterSettings: vi.fn(), settingsStatus: 0, provider: { id: 'claude-code', displayName: 'Host Claude', conventions: { legacyInstructionsFile: 'CLAUDE.md', configDir: '.claude', mcpConfigFile: '.mcp.json' }, getCapabilities: () => ({ permissions: true }) } }));
vi.mock('./agent-config-reader', async (original) => { const actual = await original<typeof import('./agent-config-reader')>(); return { ...actual, resolveAgentConfigTarget: m.target, readResolvedAgentConfig: async (...args: Parameters<typeof actual.readResolvedAgentConfig>) => { const result = await actual.readResolvedAgentConfig(...args); m.instructionReturned = true; await m.duringInstruction(); return result; } }; });
vi.mock('./read-only-config-target', () => ({ captureReadOnlyConfigTargetWitness: () => ({ current: () => true }) }));
vi.mock('./read-only-quick-target', () => ({ resolveReadOnlyQuickTarget: async () => null }));
vi.mock('./agent-registry', () => ({ DEFAULT_ORCHESTRATOR: 'claude-code', agentRegistry: { get: () => undefined } }));
vi.mock('./agent-system', () => ({ isAgentRunning: () => false }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => undefined }));
vi.mock('./agent-runtime/chat-drivers', () => ({ resolveChatDriver: () => ({}) }));
vi.mock('../orchestrators', () => ({ getProvider: (id: string) => id === m.provider.id ? m.provider : undefined }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./helper-index', () => ({ listHelpersEverywhere: async () => [] }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: () => ({}), getDispatcherAgentId: () => null, getDispatcherChatAgentId: () => null, isDispatcherIdentityAgentId: () => false }));
vi.mock('./dispatcher/dispatcher-settings', () => ({ isDispatcherEnabled: () => false }));
vi.mock('./dispatcher/dispatcher-agent-card-source', () => ({ readAgentCardView: async () => null }));
vi.mock('./agent-grants-service', () => ({ viewOf: () => ({ rows: [] }) }));
vi.mock('./remote-details-cards', () => ({ readConnectionCard: async () => m.later(), readActionCard: async () => {}, readCanvasCard: async () => {} }));
vi.mock('./remote-session-history', () => ({ readHistoricalSessionCard: async () => {} }));
vi.mock('./clubhouse-mcp/bridge-server', () => ({ getAgentConnection: () => null, getCurrentAgentConnection: () => null }));
vi.mock('./agent-settings-service', () => ({ readMcpConfig: async () => [], readLaunchWrapper: async () => undefined, readDefaultMcps: async () => [] }));
vi.mock('./managed-agents', () => ({ managedAgents: () => {
  if (!m.managed) throw new Error('unmanaged must not initialize managed delivery');
  if (m.service) return m.service;
  return { getTemplateForDisplay: async () => { await m.duringTemplate(); return { name: 'Modeled selected template', source: 'builtin', observedAt: Date.now(), truncated: false }; } };
}, readManagedStatusForDisplay: async () => {
  if (!m.managed) throw new Error('unmanaged must not initialize managed delivery');
  return { state: 'unavailable', inputs: [] };
} }));
vi.mock('./remote-agent-settings', async (original) => {
  const actual = await original<typeof import('./remote-agent-settings')>();
  return { ...actual, readRemoteAgentSettings: async (...args: Parameters<typeof actual.readRemoteAgentSettings>) => { const result = await actual.readRemoteAgentSettings(...args); m.settingsStatus = result.status; await m.afterSettings(); return result; } };
});
import { createManagedAgentsService } from './managed-agents/service';
import { createManagedStateStore } from './managed-agents/state-store';
import { createAssetCatalogStore } from './asset-catalog/store';
import { recordStartRequest, takeStartRequest, _resetStartRequestsForTesting } from './helper-start-requests';
import { resetAllSettingsStoresForTests } from './settings-store';
import { readRemoteAgentDetails } from './remote-agent-details';
let root: string, target: AgentConfigTarget;
const put = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
const disk = () => Object.fromEntries(fs.readdirSync(root).sort().map((name) => { const file = path.join(root, name), stat = fs.statSync(file); return [name, stat.isDirectory() ? fs.readdirSync(file).sort() : { bytes: fs.readFileSync(file).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; }));
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-details-settings-composition-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); _resetStartRequestsForTesting(); m.instructionReturned = false; m.managed = false; m.service = null; m.settingsStatus = 0; m.afterSettings.mockReset().mockResolvedValue(undefined); m.duringInstruction.mockReset().mockResolvedValue(undefined); m.duringTemplate.mockReset().mockResolvedValue(undefined);
  target = { agent: { id: 'selected', name: 'Selected', color: '', createdAt: '', orchestrator: 'claude-code', model: 'HOST_SAVED_MODEL', worktreePath: root }, project: { id: 'p', name: 'Project', path: root } };
  m.target.mockReset().mockImplementation(async () => structuredClone(target)); m.later.mockReset().mockResolvedValue(undefined);
  for (const file of ['experimental-settings.json', 'chat-runtime-settings.json', 'free-agent-settings.json', 'chat-idle-settings.json', 'orchestration-settings.json']) {
    put(file, {}); const temp = path.join(root, `.${file}.tmp-${process.pid + 100000}-1`); fs.writeFileSync(temp, 'keep aged temp'); const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(temp, old, old);
  }
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'PRIVATE_INSTRUCTION_BODY\n');
});
afterEach(() => { _resetStartRequestsForTesting(); resetAllSettingsStoresForTests(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it.each(['same', 'instruction', 'runtime', 'legacy-provider', 'revoked'] as const)('holds actual Settings evidence through final Details assembly: %s', async (mode) => {
  if (mode === 'legacy-provider') { delete target.agent.orchestrator; fs.mkdirSync(path.join(root, '.clubhouse')); fs.writeFileSync(path.join(root, '.clubhouse', 'settings.json'), '{"orchestrator":"claude-code"}'); }
  let allowed = true;
  m.later.mockImplementation(async () => {
    expect(m.instructionReturned).toBe(true);
    if (mode === 'instruction' || mode === 'revoked') fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Changed instruction body');
    if (mode === 'runtime') put('chat-runtime-settings.json', { 'claude-code': { mode: 'terminal' } });
    if (mode === 'legacy-provider') fs.writeFileSync(path.join(root, '.clubhouse', 'settings.json'), '{"orchestrator":"codex-cli"}');
    if (mode === 'revoked') allowed = false;
  });
  const before = disk(), result = await readRemoteAgentDetails('selected', () => allowed);
  expect.soft(result.status).toBe(mode === 'same' ? 200 : mode === 'revoked' ? 403 : 409);
  expect.soft(JSON.stringify(result.body)).not.toContain('PRIVATE_INSTRUCTION_BODY'); expect.soft(m.target).toHaveBeenCalledTimes(1);
  if (mode === 'same') {
    expect.soft(isRemoteAgentDetails(result.body, 'selected')).toBe(true);
    expect.soft((result.body as RemoteAgentDetails).settings).toMatchObject({ runtime: 'chat', model: 'HOST_SAVED_MODEL', setup: { instructions: 'Custom, 1 lines' } }); expect.soft(disk()).toEqual(before);
  } else expect.soft(JSON.stringify(result.body)).not.toMatch(/cards|HOST_SAVED_MODEL|providerId/);
});
it('shows partial known fields without recovering unreadable settings or inventing a runtime', async () => {
  fs.writeFileSync(path.join(root, 'chat-runtime-settings.json'), '{broken'); const before = disk(), result = await readRemoteAgentDetails('selected', () => true);
  expect(m.settingsStatus).toBe(503); expect.soft(result.status).toBe(200); expect.soft(isRemoteAgentDetails(result.body, 'selected')).toBe(true);
  const value = result.body as RemoteAgentDetails; expect.soft(value.settings).toBeNull();
  expect.soft(value.cards.find((c) => c.id === 'settings')).toMatchObject({ state: 'error', rows: expect.arrayContaining([{ label: 'Next start model', value: 'HOST_SAVED_MODEL' }, { label: 'Next wake', value: 'Unavailable from host settings' }]) });
  expect.soft(disk()).toEqual(before);
});

it.each(['instructions', 'template'] as const)('refuses the complete Details response after Settings detects a legacy CLI change during its %s await', async (during) => {
  delete target.agent.orchestrator; fs.mkdirSync(path.join(root, '.clubhouse'));
  const settings = path.join(root, '.clubhouse', 'settings.json'); fs.writeFileSync(settings, '{"orchestrator":"claude-code"}');
  const mutate = async () => { await Promise.resolve(); fs.writeFileSync(settings, '{"orchestrator":"codex-cli"}'); };
  if (during === 'instructions') m.duringInstruction.mockImplementation(mutate);
  else { m.managed = true; target.agent.managed = { version: 1, blocks: [], skills: [], mcps: [], templateId: 'modeled-template' }; m.duringTemplate.mockImplementation(mutate); }
  const result = await readRemoteAgentDetails('selected', () => true);
  expect(m.settingsStatus).toBe(409); expect(fs.readFileSync(settings, 'utf8')).toContain('codex-cli');
  expect.soft(result.status).toBe(409); expect.soft(m.later).not.toHaveBeenCalled(); expect.soft(JSON.stringify(result.body)).not.toMatch(/providerId|cards|claude-code|Host Claude|HOST_SAVED_MODEL/);
});
it.each(['instructions', 'template'] as const)('keeps revocation dominant when the legacy CLI changes during the Settings %s await', async (during) => {
  delete target.agent.orchestrator; fs.mkdirSync(path.join(root, '.clubhouse'));
  const settings = path.join(root, '.clubhouse', 'settings.json'); fs.writeFileSync(settings, '{"orchestrator":"claude-code"}'); let allowed = true;
  const mutate = async () => { await Promise.resolve(); fs.writeFileSync(settings, '{"orchestrator":"codex-cli"}'); allowed = false; };
  if (during === 'instructions') m.duringInstruction.mockImplementation(mutate);
  else { m.managed = true; target.agent.managed = { version: 1, blocks: [], skills: [], mcps: [], templateId: 'modeled-template' }; m.duringTemplate.mockImplementation(mutate); }
  const result = await readRemoteAgentDetails('selected', () => allowed);
  expect(m.settingsStatus).toBe(403); expect.soft(result.status).toBe(403); expect.soft(JSON.stringify(result.body)).not.toMatch(/providerId|cards|claude-code|Host Claude|HOST_SAVED_MODEL/);
});

it('refuses complete Details after Settings detects a global runtime change during its instruction await', async () => {
  m.duringInstruction.mockImplementation(async () => { await Promise.resolve(); put('chat-runtime-settings.json', { 'claude-code': { mode: 'terminal' } }); });
  const result = await readRemoteAgentDetails('selected', () => true);
  expect(m.settingsStatus).toBe(409); expect.soft(result.status).toBe(409); expect.soft(m.later).not.toHaveBeenCalled(); expect.soft(JSON.stringify(result.body)).not.toMatch(/cards|providerId|HOST_SAVED_MODEL/);
});
it('refuses complete Details after Settings detects a real selected template receipt change during its await', async () => {
  m.managed = true; target.agent.managed = { version: 1, blocks: [], skills: [], mcps: [], templateId: 'chosen-template' };
  const dir = path.join(root, 'managed'), file = path.join(dir, 'state.json'); fs.mkdirSync(dir);
  const chosen = { id: 'chosen-template', name: 'Selected template', settings: { privateCredential: 'PRIVATE_TEMPLATE_SETTINGS' } };
  fs.writeFileSync(file, JSON.stringify({ version: 1, templates: { 'chosen-template': chosen } }));
  const service = createManagedAgentsService({ catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }), state: createManagedStateStore(dir), listProjects: async () => [], listAgents: async () => [], getAgent: async () => null, setManagedSetup: vi.fn(), isRunning: () => false });
  let observed = false;
  m.service = { getTemplateForDisplay: async (id, options) => {
    const prior = options.receipts.length, result = await service.getTemplateForDisplay(id, options), receipts = options.receipts.slice(prior);
    expect(receipts.length).toBeGreaterThan(0); expect(receipts.every((receipt: { current(): boolean }) => receipt.current())).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ version: 1, templates: { 'chosen-template': { ...chosen, name: 'Changed template' } } }));
    expect(receipts.some((receipt: { current(): boolean }) => !receipt.current())).toBe(true); observed = true; return result;
  } };
  const result = await readRemoteAgentDetails('selected', () => true);
  expect(observed).toBe(true); expect(m.settingsStatus).toBe(409); expect.soft(result.status).toBe(409); expect.soft(m.later).not.toHaveBeenCalled(); expect.soft(JSON.stringify(result.body)).not.toMatch(/cards|providerId|HOST_SAVED_MODEL|PRIVATE_TEMPLATE/);
});
it('keeps admitted provider evidence guarded when Settings fails unexpectedly before exporting receipts', async () => {
  delete target.agent.orchestrator; fs.mkdirSync(path.join(root, '.clubhouse'));
  const file = path.join(root, '.clubhouse', 'settings.json'); fs.writeFileSync(file, '{"orchestrator":"claude-code"}'); let calls = 0;
  vi.spyOn(m.provider, 'getCapabilities').mockImplementation(() => { if (++calls === 2) { fs.writeFileSync(file, '{"orchestrator":"codex-cli"}'); throw new Error('PRIVATE_CAPABILITY_ERROR'); } return { permissions: true }; });
  const result = await readRemoteAgentDetails('selected', () => true);
  expect(m.settingsStatus).toBe(500); expect.soft(result.status).toBe(409); expect.soft(m.later).not.toHaveBeenCalled(); expect.soft(JSON.stringify(result.body)).not.toMatch(/cards|providerId|HOST_SAVED_MODEL|PRIVATE_CAPABILITY/);
});
it('honors an actual Settings authority refusal even when the modeled authority is restored before the outer continuation', async () => {
  let allowed = true; m.duringInstruction.mockImplementation(async () => { allowed = false; }); m.afterSettings.mockImplementation(async () => { allowed = true; });
  const result = await readRemoteAgentDetails('selected', () => allowed);
  expect(m.settingsStatus).toBe(403); expect(allowed).toBe(true); expect.soft(result.status).toBe(403); expect.soft(m.later).not.toHaveBeenCalled(); expect.soft(JSON.stringify(result.body)).not.toMatch(/cards|providerId|HOST_SAVED_MODEL/);
});

it('retains independent provider evidence over a later card await after Settings fails before receipt export', async () => {
  delete target.agent.orchestrator; fs.mkdirSync(path.join(root, '.clubhouse'));
  const file = path.join(root, '.clubhouse', 'settings.json'); fs.writeFileSync(file, '{"orchestrator":"claude-code"}'); let calls = 0, changed = false;
  vi.spyOn(m.provider, 'getCapabilities').mockImplementation(() => { if (++calls === 2) throw new Error('PRIVATE_CAPABILITY_ERROR'); return { permissions: true }; });
  m.later.mockImplementation(async () => { fs.writeFileSync(file, '{"orchestrator":"codex-cli"}'); changed = true; });
  const result = await readRemoteAgentDetails('selected', () => true);
  expect(m.settingsStatus).toBe(500); expect(changed).toBe(true); expect.soft(result.status).toBe(409); expect.soft(JSON.stringify(result.body)).not.toMatch(/cards|providerId|HOST_SAVED_MODEL|PRIVATE_CAPABILITY/);
});

it('retains known orchestration fields while corrupt host defaults stay unknown without recovery or sweeping', async () => {
  target.agent.orchestration = { orchestrate: true, control: 'ask-before-start' };
  fs.writeFileSync(path.join(root, 'orchestration-settings.json'), '{broken'); fs.writeFileSync(path.join(root, 'orchestration-settings.json.bak'), '{"globalHelperCap":99,"autoHelpers":true}');
  const before = disk(), result = await readRemoteAgentDetails('selected', () => true);
  expect(result.status).toBe(200); const value = result.body as RemoteAgentDetails; expect(isRemoteAgentDetails(value, 'selected')).toBe(true);
  expect(value.cards.find((c) => c.id === 'orchestrate')).toMatchObject({ state: 'error', rows: expect.arrayContaining([{ label: 'Orchestration', value: 'On' }, { label: 'Control', value: 'Ask before starting' }, { label: 'App-wide limit', value: 'Unavailable from host metadata' }, { label: 'Auto provider', value: 'Unavailable from host metadata' }]) });
  expect(disk()).toEqual(before);
});
it('shows selected safe pending tasks and independently retained metadata for withheld text without raw args', async () => {
  recordStartRequest(root, 'selected', 'Owner', { name: 'Visible helper', task: 'Review visible changes' });
  recordStartRequest(root, 'selected', 'Owner', { name: 'Withheld helper', task: 'config["apiKey"]="PRIVATE_TASK";' });
  recordStartRequest(root, 'unrelated', 'PRIVATE_OWNER', { name: 'PRIVATE_HELPER', task: 'PRIVATE_UNRELATED' });
  const result = await readRemoteAgentDetails('selected', () => true); expect(result.status).toBe(200);
  const c = (result.body as RemoteAgentDetails).cards.find((card) => card.id === 'orchestrate')!;
  expect(c.rows).toEqual(expect.arrayContaining([{ label: 'Task', value: 'Review visible changes' }, { label: 'Task', value: 'Task withheld (conservative display policy)' }, { label: 'Waiting to start', value: 'Withheld helper · awaiting approval' }]));
  expect(c.rows.some((row) => row.label === 'Requested / expires')).toBe(true); expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE_|args|apiKey/);
});
it('holds selected pending-request receipts through cancellation during a later Details card await', async () => {
  const request = recordStartRequest(root, 'selected', 'Owner', { name: 'Selected helper', task: 'Review visible changes' }); if (!request.ok) throw new Error('fixture refused');
  m.later.mockImplementation(async () => { takeStartRequest(root, request.request.requestId); });
  const result = await readRemoteAgentDetails('selected', () => true);
  expect(m.settingsStatus).toBe(200); expect.soft(result).toEqual({ status: 409, body: { error: 'orchestration_evidence_changed' } }); expect.soft(JSON.stringify(result.body)).not.toMatch(/cards|providerId|Selected helper/);
});
it('keeps unavailable selected pending starts unknown in the Helpers summary', async () => {
  const request = recordStartRequest(root, 'selected', 'Owner', { name: 'Selected helper', task: 'Review visible changes' });
  if (!request.ok) throw new Error('fixture refused');
  request.request.expiresAt = 'invalid recorded expiry';
  const result = await readRemoteAgentDetails('selected', () => true);
  expect(result.status).toBe(200);
  const c = (result.body as RemoteAgentDetails).cards.find((card) => card.id === 'orchestrate')!;
  expect(c.state).toBe('error'); expect(c.notes.join(' ')).toContain('no empty queue is inferred');
  expect.soft(c.rows).toContainEqual({ label: 'Helpers', value: 'No live helpers · pending starts unavailable' });
  expect.soft(c.rows).not.toContainEqual({ label: 'Helpers', value: 'none' });
});

it.each(['app-cap', 'project-auto'] as const)('retains selected orchestration evidence through a later %s change', async (change) => {
  m.later.mockImplementation(async () => {
    if (change === 'app-cap') put('orchestration-settings.json', { globalHelperCap: 5 });
    else { fs.mkdirSync(path.join(root, '.clubhouse')); fs.writeFileSync(path.join(root, '.clubhouse', 'settings.json'), '{"agentDefaults":{"helperAuto":"off"}}'); }
  });
  const result = await readRemoteAgentDetails('selected', () => true);
  expect(m.settingsStatus).toBe(200); expect.soft(result).toEqual({ status: 409, body: { error: 'orchestration_evidence_changed' } }); expect.soft(JSON.stringify(result.body)).not.toMatch(/cards|providerId|HOST_SAVED_MODEL/);
});
