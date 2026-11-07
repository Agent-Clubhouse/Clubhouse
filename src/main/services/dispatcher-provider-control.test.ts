import { beforeEach, expect, it, vi } from 'vitest';
const w = vi.hoisted(() => ({ enabled: true, access: 'open', version: 1, removed: false, disabled: [] as string[], control: 'hands-off', connected: true, helper: false, commits: 0, revoke: false, revokeBinding: false }));
vi.mock('./agent-provider-control', () => ({
  previewAgentProvider: async (_p: string, _t: string, _v: string, actor: any) => { await actor.assertAuthorized(); return { canSave: true }; },
  changeAgentProvider: async (_p: string, _t: string, _v: string, _s: string, actor: any) => { if (w.revoke) w.control = 'ask-everything'; if (w.revokeBinding) w.version++; await actor.assertAuthorized(); w.commits++; return { status: 'changed' }; },
}));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: () => ({ projectPath: '/dispatcher' }) } }));
vi.mock('./clubhouse-mcp/dispatcher-gate', () => ({ isDispatcherAgent: () => w.enabled }));
vi.mock('./clubhouse-mcp/mcp-call-gate', () => ({ mcpCallAccess: () => w.access }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getVersion: () => w.version, getBindingsForAgent: () => [{ targetId: 'target', targetKind: 'agent', disabledTools: w.disabled }] } }));
vi.mock('./persisted-bindings', () => ({ isBindingRemovedByUser: () => w.removed }));
vi.mock('./dispatcher-connections', () => ({ readAgentCensus: async () => ({ agents: new Map([['target', { projectPath: '/project', agent: { id: 'target' }, policy: { control: w.control } }]]) }), isConnectedOrchestrator: () => w.connected && !w.helper }));
vi.mock('./dispatcher-audit', () => ({ appendAudit: vi.fn(async () => true), auditString: (s: string) => s }));
vi.mock('./project-store', () => ({ list: async () => [{ path: '/project', id: 'project' }] }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
import { dispatcherProviderControl } from './dispatcher-provider-control';
const run = () => dispatcherProviderControl('dispatcher', 'target', true, { provider: 'codex-cli', expectedState: 'token' });
beforeEach(() => { Object.assign(w, { enabled: true, access: 'open', version: 1, removed: false, disabled: [], control: 'hands-off', connected: true, helper: false, commits: 0, revoke: false, revokeBinding: false }); });
it.each(['hands-off', 'ask-before-start'])('saves under existing %s control without starting', async (control) => { w.control = control; expect(await run()).toMatchObject({ status: 'changed' }); expect(w.commits).toBe(1); });
it.each([
  ['enabled', false, 'not_dispatcher'], ['access', 'report_only', 'not_dispatcher'], ['removed', true, 'permission_revoked'],
  ['disabled', ['sleep_agent'], 'tool_denied'], ['disabled', ['change_provider'], 'tool_denied'], ['connected', false, 'not_connected_orchestrator'],
  ['helper', true, 'not_connected_orchestrator'], ['control', 'ask-everything', 'control_requires_user'],
] as const)('refuses %s=%s', async (key, value, code) => { Object.assign(w, { [key]: value }); await expect(run()).rejects.toMatchObject({ code }); expect(w.commits).toBe(0); });
it('rechecks the target policy at commit', async () => { w.revoke = true; await expect(run()).rejects.toMatchObject({ code: 'control_requires_user' }); expect(w.commits).toBe(0); });
it('does not expose arbitrary settings, self or unwired targets', async () => {
  await expect(dispatcherProviderControl('dispatcher', 'target', true, { provider: 'codex-cli', expectedState: 'x', model: 'anything' })).rejects.toMatchObject({ code: 'invalid_args' });
  await expect(dispatcherProviderControl('dispatcher', 'dispatcher', false, { provider: 'codex-cli' })).rejects.toMatchObject({ code: 'self_target' });
  await expect(dispatcherProviderControl('dispatcher', 'other', false, { provider: 'codex-cli' })).rejects.toMatchObject({ code: 'permission_revoked' });
});

it('rejects a changed wire version at commit', async () => { w.revokeBinding = true; await expect(run()).rejects.toMatchObject({ code: 'permission_revoked' }); expect(w.commits).toBe(0); });
