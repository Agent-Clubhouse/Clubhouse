import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), instructions: vi.fn(), entries: vi.fn(), template: vi.fn(), status: vi.fn(), provider: vi.fn(), chatEnabled: true, driver: true,
}));
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: mocks.resolve, readResolvedAgentConfig: mocks.instructions }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: mocks.provider }));
vi.mock('./free-agent-settings', () => ({ agentAccess: () => 'full_access' }));
vi.mock('./experimental-settings', () => ({ isGraduatedFeatureOn: () => mocks.chatEnabled }));
vi.mock('./settings-store', () => ({ createSettingsStore: () => ({ get: () => ({}) }) }));
vi.mock('./agent-runtime/chat-drivers', () => ({ resolveChatDriver: () => mocks.driver ? {} : undefined }));
vi.mock('./chat-idle-settings', () => ({ chatIdleSettings: { getSettings: () => ({ idleTimeoutMinutes: 60 }) } }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ liveEntries: mocks.entries, getTemplate: mocks.template }), statusFor: mocks.status }));
import { readRemoteAgentSettings } from './remote-agent-settings';
import { isRemoteAgentSettings } from '../../shared/remote-agent-settings';
const config = () => ({ id: 'a1', name: 'Host', color: 'teal', model: 'host-model', idleSleep: 15,
  approvalPolicy: 'on-request', sandbox: 'workspace-write', access: 'full_access',
  managed: { version: 1, templateId: 't', blocks: ['b'], skills: ['s'], mcps: ['m'], updatedBy: 'Host Dispatcher', updatedAt: '2026-11-18T00:00:00Z' },
  env: { API_TOKEN: 'private-token' }, grantRules: [{ secret: 'private-grant' }], worktreePath: '/private/path',
});
beforeEach(() => {
  mocks.chatEnabled = true; mocks.driver = true;
  mocks.resolve.mockResolvedValue({ agent: config(), project: { id: 'p', path: '/host' } });
  mocks.provider.mockResolvedValue({ id: 'claude-code', displayName: 'Claude Code', getCapabilities: () => ({ permissions: true }) });
  mocks.entries.mockResolvedValue({ b: { name: 'Block', content: 'private-instruction' }, s: { name: 'Skill' }, m: { name: 'MCP', env: { TOKEN: 'private-token' } } });
  mocks.template.mockResolvedValue({ name: 'Host template', settings: { env: { TOKEN: 'private-template' } } });
  mocks.status.mockResolvedValue({ waiting: true, changes: ['private-error'] });
  mocks.instructions.mockResolvedValue({ instructions: { text: 'private-instruction\nsecond', truncated: false } });
});
describe('host Settings summary', () => {
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
  it('honors the actual host Chat flag and unavailable driver regardless of the controller', async () => {
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
  it('bounds managed inventory and string lengths', async () => {
    const c = config(); c.managed.skills = Array.from({ length: 101 }, () => 's');
    mocks.resolve.mockResolvedValue({ agent: c, project: { path: '/host' } });
    mocks.provider.mockResolvedValue({ id: 'claude-code', displayName: 'x'.repeat(5000), getCapabilities: () => ({ permissions: true }) });
    const result = await readRemoteAgentSettings('a1', () => true);
    expect(result).toMatchObject({ status: 200, body: { provider: 'x'.repeat(240), setup: { state: 'error' } } });
    expect(mocks.entries).not.toHaveBeenCalled();
  });
});
