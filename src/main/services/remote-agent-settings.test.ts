import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), instructions: vi.fn(), entries: vi.fn(), template: vi.fn(), status: vi.fn(), provider: vi.fn(), chatEnabled: true, driver: true, current: vi.fn(), realWitness: false, base: '', role: null as string | null,
}));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => mocks.base }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: () => mocks.role, getDispatcherChatAgentId: () => null }));
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: mocks.resolve, readResolvedAgentConfig: mocks.instructions }));
vi.mock('./read-only-config-target', async (original) => { const actual = await original<typeof import('./read-only-config-target')>(); return { captureReadOnlyConfigTargetWitness: (...args: Parameters<typeof actual.captureReadOnlyConfigTargetWitness>) => mocks.realWitness ? actual.captureReadOnlyConfigTargetWitness(...args) : { current: mocks.current } }; });
vi.mock('./display-provider', () => ({ captureDisplayProvider: () => { const provider = mocks.provider(); return { provider, selection: { state: 'ok', value: provider.id, inputs: [] }, receipt: { current: () => true } }; } }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: mocks.provider }));
vi.mock('./free-agent-settings', () => ({ readAgentAccessForDisplay: () => ({ state: 'ok', value: 'full_access', inputs: [] }) }));
vi.mock('./chat-runtime-settings', () => ({ readRuntimeModeForDisplay: () => ({ state: 'ok', value: { mode: mocks.chatEnabled ? 'chat' : 'terminal' }, inputs: [] }) }));
vi.mock('./settings-store', () => ({ createSettingsStore: () => ({ get: () => ({}) }) }));
vi.mock('./agent-runtime/chat-drivers', () => ({ resolveChatDriver: () => mocks.driver ? {} : undefined }));
vi.mock('./chat-idle-settings', () => ({ readIdleSleepForDisplay: () => ({ state: 'ok', value: { minutes: 60, source: 'app' }, inputs: [] }) }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({
  openSetupMetadataForDisplay: async () => { const entries = await mocks.entries(); return { head: async (id: string) => entries[id] ?? null, receipt: { current: () => true } }; },
  getTemplateForDisplay: mocks.template,
}), readManagedStatusForDisplay: async () => ({ state: 'ok', value: await mocks.status(), inputs: [], libraryEvidence: { source: 'committed-index', revisionPayloadsVerified: false } }) }));
import { readRemoteAgentSettings } from './remote-agent-settings';
import { isRemoteAgentSettings } from '../../shared/remote-agent-settings';
const config = () => ({ id: 'a1', name: 'Host', color: 'teal', model: 'host-model', idleSleep: 15,
  approvalPolicy: 'on-request', sandbox: 'workspace-write', access: 'full_access',
  managed: { version: 1, templateId: 't', blocks: ['b'], skills: ['s'], mcps: ['m'], updatedBy: 'Host Dispatcher', updatedAt: '2026-11-18T00:00:00Z' },
  env: { API_TOKEN: 'private-token' }, grantRules: [{ secret: 'private-grant' }], worktreePath: '/private/path',
});
beforeEach(() => {
  mocks.chatEnabled = true; mocks.driver = true; mocks.realWitness = false; mocks.role = null; mocks.current.mockReturnValue(true);
  mocks.resolve.mockResolvedValue({ agent: config(), project: { id: 'p', path: '/host' } });
  mocks.provider.mockReturnValue({ id: 'claude-code', displayName: 'Claude Code', getCapabilities: () => ({ permissions: true }) });
  mocks.entries.mockResolvedValue({ b: { name: 'Block', content: 'private-instruction' }, s: { name: 'Skill' }, m: { name: 'MCP', env: { TOKEN: 'private-token' } } });
  mocks.template.mockResolvedValue({ name: 'Host template', settings: { env: { TOKEN: 'private-template' } } });
  mocks.status.mockResolvedValue({ waiting: true, changes: ['private-error'] });
  mocks.instructions.mockResolvedValue({ instructions: { text: 'private-instruction\nsecond', truncated: false } });
});
describe('host Settings summary', () => {
  it.each(['ordinary-same', 'ordinary-removed', 'role-same', 'role-disposed', 'role-cleared', 'role-backup-only', 'role-revoked'] as const)('keeps real primary target admission across asynchronous setup reads: %s', async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-settings-target-final-'))); mocks.base = root; mocks.realWitness = true;
    const role = mode.startsWith('role-'); mocks.role = role ? 'a1' : null;
    const folder = path.join(root, role ? 'dispatcher' : 'project'); await fs.mkdir(path.join(folder, '.clubhouse'), { recursive: true });
    const selected = config(); const project = { id: role ? DISPATCHER_PROJECT_ID : 'p', name: 'Host project', path: folder };
    const file = path.join(folder, '.clubhouse', 'agents.json'); const primary = JSON.stringify([selected]); await fs.writeFile(file, primary);
    await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify([project]));
    mocks.resolve.mockResolvedValue({ agent: selected, project }); let allowed = true;
    mocks.entries.mockImplementation(async () => {
      if (mode === 'ordinary-removed') await fs.writeFile(file, '[]');
      if (mode === 'role-disposed') await fs.writeFile(file, JSON.stringify([{ ...selected, disposedAt: '2026-11-19' }]));
      if (mode === 'role-cleared') mocks.role = null;
      if (mode === 'role-backup-only') await fs.rename(file, `${file}.bak`);
      if (mode === 'role-revoked') allowed = false;
      return {};
    });
    try {
      const response = await readRemoteAgentSettings('a1', () => allowed);
      const same = mode.endsWith('-same');
      expect.soft(response.status).toBe(same ? 200 : mode === 'role-revoked' ? 403 : 409);
      if (same) { expect(isRemoteAgentSettings(response.body, 'a1')).toBe(true); expect(await fs.readFile(file, 'utf8')).toBe(primary); }
      else expect.soft(JSON.stringify(response.body)).not.toMatch(/host-model|setup|Host CLI|private/);
      if (mode === 'role-backup-only') { await expect(fs.access(file)).rejects.toThrow(); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(primary); }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('allowlists bounded metadata without instruction content, paths, provider config or grants', async () => {
    const response = await readRemoteAgentSettings('a1', () => true);
    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith('a1', undefined, { strict: true });
    expect(isRemoteAgentSettings(response.body, 'a1')).toBe(true);
    expect(response.body).toMatchObject({ readOnly: true, providerId: 'claude-code', provider: 'Claude Code', runtime: 'chat', access: 'Full access', executionPolicy: 'on-request · workspace-write',
      setup: { managed: true, template: 'Host template', skills: ['Skill'], mcps: ['MCP'], instructions: '1 block', waiting: true } });
    expect(JSON.stringify(response.body)).not.toMatch(/private-|\/host/);
    expect(mocks.instructions).not.toHaveBeenCalled();
  });
  it('projects host Chat preference and unavailable driver independently of the controller', async () => {
    mocks.chatEnabled = false;
    expect(await readRemoteAgentSettings('a1', () => true)).toMatchObject({ status: 200, body: { runtime: 'terminal', autoSleep: null } });
    mocks.chatEnabled = true; mocks.driver = false;
    expect(await readRemoteAgentSettings('a1', () => true)).toMatchObject({ status: 200, body: { runtime: 'terminal' } });
  });
  it('refuses before any lookup or configuration read', async () => {
    expect((await readRemoteAgentSettings('a1', () => false)).status).toBe(403);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.entries).not.toHaveBeenCalled();
  });
  it('rechecks authorization after async configuration reads, including failures', async () => {
    let allowed = true;
    mocks.entries.mockImplementation(async () => { allowed = false; return {}; });
    expect((await readRemoteAgentSettings('a1', () => allowed)).status).toBe(403);
    allowed = true;
    mocks.entries.mockImplementation(async () => { allowed = false; throw new Error('private-error'); });
    expect((await readRemoteAgentSettings('a1', () => allowed)).status).toBe(403);
  });
  it('keeps basic settings when setup cannot be read and never returns raw errors', async () => {
    mocks.entries.mockRejectedValue(new Error('private-error'));
    expect(await readRemoteAgentSettings('a1', () => true)).toMatchObject({ status: 200, body: { model: 'host-model', setup: { state: 'error' } } });
  });
  it('reads unmanaged instructions only as a bounded count and marks unsupported inventories unknown', async () => {
    mocks.resolve.mockResolvedValue({ agent: { ...config(), managed: undefined }, project: { id: 'p', path: '/host' } });
    const result = await readRemoteAgentSettings('a1', () => true);
    expect(result).toMatchObject({ status: 200, body: { setup: { managed: false, instructions: 'Custom, 2 lines', skills: null, mcps: null } } });
    expect(JSON.stringify(result)).not.toContain('private-instruction');
  });
  it('does not accept names or disclose a response after lookup authorization is revoked', async () => {
    expect((await readRemoteAgentSettings('Host', () => true)).status).toBe(404);
    let allowed = true;
    mocks.resolve.mockImplementation(async () => { allowed = false; throw new Error('private-path'); });
    expect((await readRemoteAgentSettings('a1', () => allowed)).status).toBe(403);
  });
  it('distinguishes missing targets from host lookup failures without leaking their messages', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('No registered agent matches that reference.'));
    expect((await readRemoteAgentSettings('missing', () => true)).status).toBe(404);
    mocks.resolve.mockRejectedValueOnce(new Error('private-path-read-failed'));
    expect(await readRemoteAgentSettings('a1', () => true)).toEqual({ status: 500, body: { error: 'settings_read_failed' } });
  });
  it('withholds Settings after target changes during a setup await and prioritizes revocation', async () => {
    mocks.entries.mockImplementation(async () => { mocks.current.mockReturnValue(false); return {}; });
    const response = await readRemoteAgentSettings('a1', () => true);
    expect(response).toEqual({ status: 409, body: { error: 'agent_inventory_changed' } });
    expect(JSON.stringify(response)).not.toMatch(/Host|host-model|private/);
    let allowed = true; mocks.current.mockReturnValue(true);
    mocks.entries.mockImplementation(async () => { mocks.current.mockReturnValue(false); allowed = false; return {}; });
    expect(await readRemoteAgentSettings('a1', () => allowed)).toEqual({ status: 403, body: { error: 'settings_read_refused' } });
  });
  it('bounds managed inventory and string lengths', async () => {
    const c = config(); c.managed.skills = Array.from({ length: 101 }, () => 's');
    mocks.resolve.mockResolvedValue({ agent: c, project: { path: '/host' } });
    mocks.provider.mockReturnValue({ id: 'claude-code', displayName: 'x'.repeat(5000), getCapabilities: () => ({ permissions: true }) });
    const result = await readRemoteAgentSettings('a1', () => true);
    expect(result).toMatchObject({ status: 200, body: { provider: 'x'.repeat(240), setup: { state: 'error' } } });
    expect(mocks.entries).not.toHaveBeenCalled();
  });
});
