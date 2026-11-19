/** Actual Details -> Settings -> passive fields/provider/instruction read composition.
 * Other cards, target admission and runtime are modeled; selected storage is real. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import type { AgentConfigTarget } from './agent-config-reader';
import { ORCHESTRATION_DEFAULTS } from '../../shared/orchestration-policy';
import { isRemoteAgentDetails, type RemoteAgentDetails } from '../../shared/remote-agent-details';
const m = vi.hoisted(() => ({ target: vi.fn(), later: vi.fn(), instructionReturned: false, duringInstruction: vi.fn(), duringTemplate: vi.fn(), managed: false, settingsStatus: 0, provider: { id: 'claude-code', displayName: 'Host Claude', conventions: { legacyInstructionsFile: 'CLAUDE.md', configDir: '.claude', mcpConfigFile: '.mcp.json' }, getCapabilities: () => ({ permissions: true }) } }));
vi.mock('./agent-config-reader', async (original) => { const actual = await original<typeof import('./agent-config-reader')>(); return { ...actual, resolveAgentConfigTarget: m.target, readResolvedAgentConfig: async (...args: Parameters<typeof actual.readResolvedAgentConfig>) => { const result = await actual.readResolvedAgentConfig(...args); m.instructionReturned = true; await m.duringInstruction(); return result; } }; });
vi.mock('./read-only-config-target', () => ({ captureReadOnlyConfigTargetWitness: () => ({ current: () => true }) }));
vi.mock('./read-only-quick-target', () => ({ resolveReadOnlyQuickTarget: async () => null }));
vi.mock('./agent-registry', () => ({ DEFAULT_ORCHESTRATOR: 'claude-code', agentRegistry: { get: () => undefined } }));
vi.mock('./agent-system', () => ({ isAgentRunning: () => false }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => undefined }));
vi.mock('./agent-runtime/chat-drivers', () => ({ resolveChatDriver: () => ({}) }));
vi.mock('../orchestrators', () => ({ getProvider: (id: string) => id === m.provider.id ? m.provider : undefined }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./orchestration-policy', () => ({ resolveOrchestrationPolicies: async () => new Map([['selected', ORCHESTRATION_DEFAULTS]]) }));
vi.mock('./orchestration-settings', () => ({ getGlobalHelperCap: () => 20 }));
vi.mock('./helper-index', () => ({ listHelpersEverywhere: async () => [] }));
vi.mock('./helper-start-requests', () => ({ listStartRequests: () => [] }));
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
  return { getTemplateForDisplay: async () => { await m.duringTemplate(); return { name: 'Modeled selected template', source: 'builtin', observedAt: Date.now(), truncated: false }; } };
}, readManagedStatusForDisplay: async () => {
  if (!m.managed) throw new Error('unmanaged must not initialize managed delivery');
  return { state: 'unavailable', inputs: [] };
} }));
vi.mock('./remote-agent-settings', async (original) => {
  const actual = await original<typeof import('./remote-agent-settings')>();
  return { ...actual, readRemoteAgentSettings: async (...args: Parameters<typeof actual.readRemoteAgentSettings>) => { const result = await actual.readRemoteAgentSettings(...args); m.settingsStatus = result.status; return result; } };
});
import { resetAllSettingsStoresForTests } from './settings-store';
import { readRemoteAgentDetails } from './remote-agent-details';
let root: string, target: AgentConfigTarget;
const put = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
const disk = () => Object.fromEntries(fs.readdirSync(root).sort().map((name) => { const file = path.join(root, name), stat = fs.statSync(file); return [name, stat.isDirectory() ? fs.readdirSync(file).sort() : { bytes: fs.readFileSync(file).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; }));
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-details-settings-composition-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); m.instructionReturned = false; m.managed = false; m.settingsStatus = 0; m.duringInstruction.mockReset().mockResolvedValue(undefined); m.duringTemplate.mockReset().mockResolvedValue(undefined);
  target = { agent: { id: 'selected', name: 'Selected', color: '', createdAt: '', orchestrator: 'claude-code', model: 'HOST_SAVED_MODEL', worktreePath: root }, project: { id: 'p', name: 'Project', path: root } };
  m.target.mockReset().mockImplementation(async () => structuredClone(target)); m.later.mockReset().mockResolvedValue(undefined);
  for (const file of ['experimental-settings.json', 'chat-runtime-settings.json', 'free-agent-settings.json', 'chat-idle-settings.json']) {
    put(file, {}); const temp = path.join(root, `.${file}.tmp-${process.pid + 100000}-1`); fs.writeFileSync(temp, 'keep aged temp'); const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(temp, old, old);
  }
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'PRIVATE_INSTRUCTION_BODY\n');
});
afterEach(() => { resetAllSettingsStoresForTests(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
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
  expect.soft(result.status).toBe(200); expect.soft(isRemoteAgentDetails(result.body, 'selected')).toBe(true);
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
  expect.soft(result.status).toBe(409); expect.soft(JSON.stringify(result.body)).not.toMatch(/providerId|cards|claude-code|Host Claude|HOST_SAVED_MODEL/);
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
