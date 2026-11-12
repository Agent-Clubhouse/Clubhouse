import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolHandler, McpToolResult } from '../types';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, McpToolHandler>(),
  definitions: new Map<string, unknown>(),
  grants: new Map<string, unknown>(),
  allowed: true,
  settings: { enableServer: true, enableClient: true, loopbackOnly: true, networkEnabled: true, deviceName: 'SECRET_NAME', alias: 'SECRET_ALIAS', reachableAs: 'SECRET_HOST' },
  approve: false,
  ask: vi.fn(),
  describe: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('../../annex-settings', () => ({ getSettings: () => mocks.settings, networkEnabled: () => mocks.settings.networkEnabled }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../settings-audit', () => ({ appendSettingsAudit: mocks.audit }));
vi.mock('../tool-registry', () => ({
  registerGlobalTool: (name: string, definition: unknown, handler: McpToolHandler, options: unknown) => {
    mocks.handlers.set(name, handler); mocks.definitions.set(name, definition); mocks.grants.set(name, options);
  },
}));
vi.mock('../ask-first', () => ({ askFirst: mocks.ask, describeCallsForAsk: mocks.describe }));
vi.mock('../grant-check', () => ({ checkToolGrant: () => mocks.allowed ? { ok: true } : { ok: false, message: 'settings.app.write revoked' } }));

import { readAnnexNetworkSettings, registerAnnexNetworkTools, setAnnexNetworkToolHost } from './annex-network-tools';

const text = (result: McpToolResult) => result.content[0]?.text ?? '';
const invoke = (name: string, args: Record<string, unknown> = {}) => mocks.handlers.get(name)!('agent', args);
const args = (value = false) => ({ loopback_only: value, expected_state: readAnnexNetworkSettings().expected_state, reason: 'Use the approved tunnel.' });
const apply = vi.fn(async (value: boolean, assertAuthorized: () => void) => { assertAuthorized(); mocks.settings.loopbackOnly = value; });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CLUBHOUSE_ANNEX_LOOPBACK_ONLY', '');
  vi.stubEnv('CLUBHOUSE_ANNEX_BIND_ADDRESS', '');
  vi.stubEnv('CLUBHOUSE_ANNEX_EPHEMERAL', '');
  mocks.allowed = true;
  mocks.approve = false;
  mocks.settings.loopbackOnly = true;
  mocks.ask.mockImplementation(async () => mocks.approve ? { kind: 'approved' } : { kind: 'asked', text: 'Not done yet; waiting for user approval.' });
  setAnnexNetworkToolHost({ applyLoopbackOnly: apply });
  registerAnnexNetworkTools();
});
afterEach(() => { vi.unstubAllEnvs(); setAnnexNetworkToolHost(undefined); });

describe('authorized Annex Network settings (#3332)', () => {
  it('returns only bounded booleans/enums and the state token, with effective isolated scope', async () => {
    const result = await invoke('get_annex_network_settings');
    expect(text(result)).not.toContain('SECRET');
    expect(JSON.parse(text(result))).toMatchObject({ loopback_only: true, effective_scope: 'loopback', discovery_enabled: false });
    expect(text(result).length).toBeLessThan(400);
    mocks.settings.loopbackOnly = false;
    vi.stubEnv('CLUBHOUSE_ANNEX_LOOPBACK_ONLY', '1');
    expect(readAnnexNetworkSettings()).toMatchObject({ loopback_only: false, effective_scope: 'loopback', discovery_enabled: false, process_restricted: true });
  });

  it('always asks for each exact scope change, even when the grant is Allow, and only applies after approval', async () => {
    const requested = args();
    expect(text(await invoke('update_annex_network_settings', requested))).toContain('waiting for user approval');
    expect(apply).not.toHaveBeenCalled();
    expect(mocks.ask).toHaveBeenCalledWith('agent', 'update_annex_network_settings', requested, expect.any(Array));
    mocks.approve = true;
    expect(JSON.parse(text(await invoke('update_annex_network_settings', requested)))).toMatchObject({ changed: true, settings: { loopback_only: false } });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(mocks.grants.get('update_annex_network_settings')).toEqual({ grant: { actions: ['settings.app.write'], target: 'app', askHandledByTool: true } });
    expect(mocks.describe.mock.calls[0][1]({ loopback_only: false })).toContain('expands network exposure');
  });

  it('rechecks revoked grants after approval and immediately before the host writes', async () => {
    mocks.ask.mockImplementationOnce(async () => { mocks.allowed = false; return { kind: 'approved' }; });
    expect((await invoke('update_annex_network_settings', args())).isError).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    mocks.allowed = true;
    mocks.approve = true;
    apply.mockImplementationOnce(async (_value, assertAuthorized) => { mocks.allowed = false; assertAuthorized(); });
    expect(text(await invoke('update_annex_network_settings', args()))).toContain('revoked');
    expect(mocks.settings.loopbackOnly).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ key: 'annex.loopbackOnly', outcome: 'refused' }));
  });

  it('rejects stale approvals, unknown fields and isolated-profile expansion without applying anything', async () => {
    const stale = args();
    mocks.settings.networkEnabled = false;
    expect((await invoke('update_annex_network_settings', stale)).isError).toBe(true);
    mocks.settings.networkEnabled = true;
    expect((await invoke('update_annex_network_settings', { ...args(), pin: '1234' })).isError).toBe(true);
    vi.stubEnv('CLUBHOUSE_ANNEX_LOOPBACK_ONLY', '1');
    expect(text(await invoke('update_annex_network_settings', args()))).toContain('isolated network profile');
    expect(apply).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it('reports application failure explicitly rather than claiming success', async () => {
    mocks.approve = true;
    apply.mockRejectedValueOnce(new Error('Saved but server restart failed'));
    const result = await invoke('update_annex_network_settings', args());
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Saved but server restart failed');
  });
});
