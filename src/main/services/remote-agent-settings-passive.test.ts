import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import type { DurableAgentConfig } from '../../shared/types';
import { isRemoteAgentSettings } from '../../shared/remote-agent-settings';
const m = vi.hoisted(() => ({ target: vi.fn(), instructions: vi.fn(), current: true, provider: { id: 'claude-code', displayName: 'Host Claude', getCapabilities: () => ({ permissions: true }) } }));
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: m.target, readResolvedAgentConfig: m.instructions }));
vi.mock('./read-only-config-target', () => ({ captureReadOnlyConfigTargetWitness: () => ({ current: () => m.current }) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: async () => ({ id: 'claude-code', displayName: 'Host Claude', getCapabilities: () => ({ permissions: true }) }) }));
vi.mock('../orchestrators', () => ({ getProvider: (id: string) => id === 'claude-code' ? m.provider : undefined }));
vi.mock('./agent-runtime/chat-drivers', () => ({ resolveChatDriver: () => ({}) }));
vi.mock('./managed-agents', () => ({ managedAgents: () => { throw new Error('unmanaged display must not open the catalog'); }, statusFor: vi.fn() }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: async (_kind: string, work: () => Promise<void>) => work() } }));
import { resetAllSettingsStoresForTests } from './settings-store';
import { captureDisplayProvider } from './display-provider';
import { readRemoteAgentSettings } from './remote-agent-settings';
let root: string, agent: DurableAgentConfig;
const files = ['experimental-settings.json', 'chat-runtime-settings.json', 'free-agent-settings.json', 'chat-idle-settings.json'];
const write = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
const disk = () => Object.fromEntries(fs.readdirSync(root).sort().map((name) => { const file = path.join(root, name), stat = fs.statSync(file); return [name, { bytes: fs.readFileSync(file).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; }));
function temps() { for (const name of files) { const file = path.join(root, `.${name}.tmp-${process.pid + 100000}-1`); fs.writeFileSync(file, 'keep aged selected settings temp'); const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(file, old, old); } }
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-settings-endpoint-passive-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); m.current = true;
  agent = { id: 'selected', name: 'Selected', color: '', createdAt: '', orchestrator: 'claude-code', model: 'selected-model', freeAgentMode: true };
  m.target.mockImplementation(async () => ({ agent: structuredClone(agent), project: { id: 'p', name: 'Project', path: root } }));
  m.instructions.mockReset().mockResolvedValue({ instructions: { text: 'Selected line\n', truncated: false } });
});
afterEach(() => { resetAllSettingsStoresForTests(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it.each(files)('keeps cold corrupt %s uncertain without SettingsStore recovery or temp sweeping', async (bad) => {
  for (const file of files) write(file, {}); fs.writeFileSync(path.join(root, bad), '{broken'); temps(); const before = disk();
  const result = await readRemoteAgentSettings(agent.id, () => true);
  expect.soft(result.status).toBe(503); expect.soft(result.body).toEqual({ error: 'settings_evidence_unavailable' });
  expect.soft(JSON.stringify(result.body)).not.toMatch(/selected-model|skip-all|Never sleeps|PRIVATE/); expect.soft(disk()).toEqual(before);
});
it('retains verified missing defaults without materializing any settings file', async () => {
  temps(); const before = disk(); const result = await readRemoteAgentSettings(agent.id, () => true);
  expect.soft(result.status).toBe(200); expect.soft(isRemoteAgentSettings(result.body, agent.id)).toBe(true);
  expect.soft(result.body).toMatchObject({ runtime: 'chat', autoSleep: 'Sleeps after 30 min (host default)' }); expect.soft(disk()).toEqual(before);
});
it('withholds selected runtime evidence changed during the later instructions await', async () => {
  for (const file of files) write(file, {});
  m.instructions.mockImplementation(async () => { write('chat-runtime-settings.json', { 'claude-code': { mode: 'terminal' } }); return { instructions: { text: '', truncated: false } }; });
  const result = await readRemoteAgentSettings(agent.id, () => true);
  expect.soft(result).toMatchObject({ status: 409, body: { error: 'settings_evidence_changed' } }); expect.soft(JSON.stringify(result.body)).not.toMatch(/selected-model|runtime/);
});
it('prioritizes revocation over changed display evidence after an actual settings edit', async () => {
  for (const file of files) write(file, {}); let allowed = true;
  agent.persona = 'qa'; agent.managedMigrationFailure = { at: '2026-11-19', code: 'invalid', message: 'PRIVATE_REASON' };
  m.instructions.mockImplementation(async () => { write('chat-runtime-settings.json', { 'claude-code': { mode: 'terminal' } }); allowed = false; return { instructions: { text: '', truncated: false } }; });
  expect(await readRemoteAgentSettings(agent.id, () => allowed)).toEqual({ status: 403, body: { error: 'settings_read_refused' } });
});

it.each(['available', 'unknown-runtime', 'provider-unavailable', 'instructions-failed'] as const)('keeps selected passive notices independent of provider/setup availability without initializing files: %s', async (mode) => {
  agent.persona = '/PRIVATE/persona'; agent.managedMigrationFailure = { at: '/PRIVATE/time', code: 'invalid', message: 'PRIVATE_REASON /private/secret' };
  if (mode === 'unknown-runtime') fs.writeFileSync(path.join(root, 'chat-runtime-settings.json'), '{broken');
  if (mode === 'provider-unavailable') agent.orchestrator = 'uninstalled-provider';
  if (mode === 'instructions-failed') m.instructions.mockRejectedValue(new Error('PRIVATE_ERROR'));
  temps(); const before = disk();
  const result = await readRemoteAgentSettings(agent.id, () => true);
  expect(result.status).toBe(['unknown-runtime', 'provider-unavailable'].includes(mode) ? 503 : 200);
  expect(result.display?.rows).toContainEqual({ label: 'Legacy setup', value: 'A legacy persona is still recorded for this unmanaged agent.' });
  expect(result.display?.rows).toContainEqual({ label: 'Migration failed', value: 'Clubhouse could not switch this agent to managed when it updated. The saved setup could not be converted.' });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|\/private\//);
  expect(disk()).toEqual(before);
  if (mode === 'provider-unavailable') expect(m.instructions).not.toHaveBeenCalled();
});

it('withholds passive notices if the selected inventory changes during instructions read', async () => {
  agent.persona = 'qa'; agent.managedMigrationFailure = { at: '2026-11-19', code: 'invalid', message: 'PRIVATE_REASON' };
  m.instructions.mockImplementation(async () => { m.current = false; return { instructions: { text: '', truncated: false } }; });
  expect(await readRemoteAgentSettings(agent.id, () => true)).toEqual({ status: 409, body: { error: 'agent_inventory_changed' } });
});

it('preserves explicit terminal and access choices independently of unrelated unreadable globals', async () => {
  for (const file of files) fs.writeFileSync(path.join(root, file), '{broken'); temps(); const before = disk();
  Object.assign(agent, { runtimeMode: 'terminal', access: 'plan', freeAgentMode: false });
  const result = await readRemoteAgentSettings(agent.id, () => true);
  expect.soft(result).toMatchObject({ status: 200, body: { runtime: 'terminal', autoSleep: null } }); expect.soft(isRemoteAgentSettings(result.body, agent.id)).toBe(true); expect.soft(disk()).toEqual(before);
});
it('retains known fields beside unknown runtime in the bounded internal Details projection', async () => {
  fs.writeFileSync(path.join(root, 'chat-runtime-settings.json'), '{broken'); const before = disk();
  const result = await readRemoteAgentSettings(agent.id, () => true);
  expect.soft(result.status).toBe(503); expect.soft(result.display).toMatchObject({ state: 'error', rows: expect.arrayContaining([{ label: 'Next start model', value: 'selected-model' }, { label: 'Next wake', value: 'Unavailable from host settings' }]) });
  expect.soft(JSON.stringify(result.body)).not.toMatch(/selected-model|runtime/); expect.soft(disk()).toEqual(before);
});

it('refuses a foreign admitted provider observation before setup reads rather than borrowing another selected identity', async () => {
  const snapshot = captureDisplayProvider({ agent: { ...agent, id: 'unrelated' }, project: { id: 'p', name: 'Project', path: root } });
  const result = await readRemoteAgentSettings(agent.id, () => true, { admittedProvider: snapshot });
  expect.soft(result).toEqual({ status: 500, body: { error: 'settings_read_failed' } }); expect.soft(m.instructions).not.toHaveBeenCalled();
  expect.soft(JSON.stringify(result)).not.toMatch(/unrelated|selected-model|provider/);
});
