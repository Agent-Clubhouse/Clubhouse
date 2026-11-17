import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Grant } from '../../shared/agent-grants';
import type { ActionRun } from '../../shared/actions';
import type { DeliveryOutboxItem } from './annex-delivery-store';

const mocks = vi.hoisted(() => ({
  savedDispatcher: false, dispatcherEnabled: true, grants: [] as Grant[], link: true, disabled: [] as string[], disposed: false,
  runtime: undefined as undefined | {
    kind: 'chat'; isRunning: () => boolean; getState: () => 'idle' | 'running';
    readTranscript: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn>;
  },
  records: new Map<string, ActionRun>(), record: vi.fn(), ready: true,
  settingsRead: vi.fn(async () => ({ targets: [{ model: 'safe-model' }] })),
  permissionHash: 'approved', member: true, controller: 'controller', hostOff: false, configRead: vi.fn(async () => ({ instructions: { text: 'Rules' } })),
}));
vi.mock('./agent-grants-service', () => ({ effectiveAgentGrants: async () => mocks.grants }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: () => undefined } }));
vi.mock('./agent-config', () => ({
  peekDurableConfigs: async (dir: string) => dir === '/dispatcher' ? (mocks.savedDispatcher ? [{ id: 'saved-controller' }] : []) : [{ id: 'sender' }],
  getDurableConfig: async (_dir: string, id: string) => ({ id, ...(mocks.disposed && { disposedAt: '2026-01-01T00:00:00Z' }) }),
}));
vi.mock('./connection-grants-store', () => ({ getConnectionDirection: () => ({ link: mocks.link ? {} : undefined, disabledTools: mocks.disabled }) }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherPath: () => '/dispatcher', getDispatcherState: () => ({ enabled: mocks.dispatcherEnabled, path: null }), isDispatcherAgentId: () => false, isDispatcherChatAgentId: () => false }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ path: '/project' }] }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => mocks.runtime }));
vi.mock('./actions', () => ({ actionsReady: () => mocks.ready, recordExternalRun: mocks.record }));
vi.mock('./dispatcher-federation-policy', () => ({ federationMessageDirection: () => mocks.link ? {} : undefined, federationRequestRouter: () => undefined }));
vi.mock('./dispatcher-remote-permissions', () => ({ remoteDispatcherPermissionHash: () => mocks.permissionHash }));

vi.mock('./annex-agent-calls', () => ({ isNetworkComputer: () => mocks.member }));
vi.mock('./dispatcher-federation', () => ({ remoteFederationController: () => ({ enabled: true, agentId: mocks.controller }) }));
vi.mock('./agent-config-reader', () => ({ readAgentConfig: mocks.configRead }));
vi.mock('./agent-grants-store', () => ({ getAgentGrantChanges: () => mocks.hostOff ? { changes: [{ action: 'agent.read', target: { kind: 'any' }, mode: 'off' }, { action: 'agent.read', target: { kind: 'connected' }, mode: 'off' }] } : undefined }));

vi.mock('./remote-settings-reader', () => ({ readRemoteSettings: mocks.settingsRead }));
import { isConfigDispatcher, readConfigForRemoteCaller, authorizeQueuedAnnexCall, reportAnnexDeliveryFailure } from './annex-agent-call-host';

const item: DeliveryOutboxItem = {
  id: 'call', machine: 'peer', queuedAt: new Date().toISOString(),
  body: { v: 1, callId: 'call', from: { agentId: 'sender', name: 'Sender' }, to: 'receiver', tool: 'send_message', args: { message: 'SECRET_PAYLOAD' } },
};
const notice = {
  callId: 'call', callerId: 'sender', targetId: 'receiver@peer', tool: 'send_message', state: 'expired' as const,
  queuedAt: new Date(Date.now() - 7 * 86400_000).toISOString(), updatedAt: new Date().toISOString(), attempts: 5, reason: 'expired',
};

beforeEach(() => {
  vi.clearAllMocks(); mocks.records.clear(); mocks.runtime = undefined; mocks.ready = true;
  mocks.savedDispatcher = false; mocks.dispatcherEnabled = true;
  mocks.link = true; mocks.disabled = []; mocks.disposed = false;
  mocks.permissionHash = 'approved'; mocks.member = true; mocks.controller = 'controller'; mocks.hostOff = false;
  mocks.grants = [{ action: 'agent.message', target: { kind: 'connected' }, mode: 'allow' }];
  mocks.record.mockImplementation(async (run: ActionRun) => { mocks.records.set(run.id, run); });
});

describe('durable Annex host integration', () => {
  it('authorizes a saved sleeping Dispatcher while its identity cache is unloaded', async () => {
    mocks.savedDispatcher = true;
    const controller = { ...item, body: { ...item.body, from: { agentId: 'saved-controller', name: 'Controller' } } };
    expect(await authorizeQueuedAnnexCall(controller)).toEqual({ allowed: true });
    mocks.grants = [];
    expect(await authorizeQueuedAnnexCall(controller)).toMatchObject({ allowed: false });
    mocks.grants = [{ action: 'agent.message', target: { kind: 'connected' }, mode: 'allow' }];
    mocks.dispatcherEnabled = false;
    expect(await authorizeQueuedAnnexCall(controller)).toMatchObject({ allowed: false });
    mocks.dispatcherEnabled = true; mocks.disposed = true;
    expect(await authorizeQueuedAnnexCall(controller)).toMatchObject({ allowed: false });
  });
  it('still refuses an unknown sender without saved identity or a disposed sender', async () => {
    expect(await authorizeQueuedAnnexCall({ ...item, body: { ...item.body, from: { agentId: 'unknown', name: 'Unknown' } } })).toMatchObject({ allowed: false });
    mocks.disposed = true;
    expect(await authorizeQueuedAnnexCall(item)).toMatchObject({ allowed: false });
  });
  it('retains an admitted Ask-first remote send across recovery, but never an off or changed grant', async () => {
    const direct = { ...item, remoteDispatcherAuthorization: { policyHash: 'approved' } };
    mocks.grants = [{ action: 'agent.message', target: { kind: 'remote_dispatcher' }, mode: 'ask' }];
    expect(await authorizeQueuedAnnexCall(direct)).toEqual({ allowed: true });
    mocks.permissionHash = 'changed';
    expect(await authorizeQueuedAnnexCall(direct)).toMatchObject({ allowed: false });
    mocks.permissionHash = 'approved'; mocks.grants = [];
    expect(await authorizeQueuedAnnexCall(direct)).toMatchObject({ allowed: false });
    mocks.grants = [{ action: 'agent.message', target: { kind: 'remote_dispatcher' }, mode: 'allow' }]; mocks.link = false;
    expect(await authorizeQueuedAnnexCall(direct)).toMatchObject({ allowed: false });
    mocks.link = true;
    expect(await authorizeQueuedAnnexCall({ ...direct, body: { ...item.body, tool: 'wake_agent' } })).toMatchObject({ allowed: false });
  });
  it('uses a sleeping sender saved permissions and rechecks removed links/tools and Ask-first grants', async () => {
    expect(await authorizeQueuedAnnexCall(item)).toEqual({ allowed: true });
    mocks.link = false;
    expect(await authorizeQueuedAnnexCall(item)).toMatchObject({ allowed: false });
    mocks.link = true; mocks.disabled = ['send_message'];
    expect(await authorizeQueuedAnnexCall(item)).toMatchObject({ allowed: false });
    mocks.disabled = []; mocks.grants[0].mode = 'ask';
    expect(await authorizeQueuedAnnexCall(item)).toMatchObject({ allowed: false });
    mocks.grants = [];
    expect(await authorizeQueuedAnnexCall(item)).toMatchObject({ allowed: false });
  });

  it('records one deterministic, sender-owned terminal receipt and leaves sleeping notices pending', async () => {
    expect(await reportAnnexDeliveryFailure(notice)).toBe(false);
    expect(await reportAnnexDeliveryFailure(notice)).toBe(false);
    expect(mocks.records.size).toBe(1);
    expect(mocks.records.get('annex-delivery:call')).toMatchObject({
      externalSource: 'annex_delivery', owner: { kind: 'agent', agentId: 'sender' }, outcome: 'expired',
      startedAt: Date.parse(notice.updatedAt), steps: [{ agentId: 'receiver@peer', outcome: 'failed' }],
    });
    expect(JSON.stringify([...mocks.records.values()])).not.toContain('SECRET_PAYLOAD');
    await reportAnnexDeliveryFailure({ ...notice, reason: 'SECRET_REMOTE_ERROR' });
    expect(JSON.stringify([...mocks.records.values()])).not.toContain('SECRET_REMOTE_ERROR');
  });

  it('does not re-inject a native notice already persisted under its correlation after a restart', async () => {
    mocks.runtime = {
      kind: 'chat', isRunning: () => true, getState: () => 'idle',
      readTranscript: vi.fn(async () => ({ events: [] })),
      sendMessage: vi.fn(async () => ({ delivery: 'prompt' })),
    };
    expect(await reportAnnexDeliveryFailure(notice)).toBe(true);
    expect(mocks.runtime.sendMessage).toHaveBeenCalledWith(expect.stringContaining('delivery_id=call'), expect.objectContaining({ clientCommandId: 'annex-delivery:call' }));
    mocks.runtime.readTranscript.mockResolvedValue({ events: [{ type: 'user_message', data: { clientCommandId: 'annex-delivery:call' } }] });
    expect(await reportAnnexDeliveryFailure(notice)).toBe(true);
    expect(mocks.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.records.size).toBe(1);
  });

  it('keeps a raced queued notice pending without resending until its dispatch receipt is persisted', async () => {
    mocks.runtime = {
      kind: 'chat', isRunning: () => true, getState: () => 'idle',
      readTranscript: vi.fn(async () => ({ events: [] })),
      sendMessage: vi.fn(async () => ({ delivery: 'queued' })),
    };
    expect(await reportAnnexDeliveryFailure(notice)).toBe(false);
    const message = { type: 'user_message', data: { clientCommandId: 'annex-delivery:call', messageId: 'notice-1', delivery: 'queued' } };
    mocks.runtime.readTranscript.mockResolvedValue({ events: [message] });
    expect(await reportAnnexDeliveryFailure(notice)).toBe(false);
    expect(mocks.runtime.sendMessage).toHaveBeenCalledTimes(1);
    mocks.runtime.readTranscript.mockResolvedValue({ events: [message, { type: 'queue_state', data: { transition: { messageIds: ['notice-1'], status: 'delivered' } } }] });
    expect(await reportAnnexDeliveryFailure(notice)).toBe(true);
    expect(mocks.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('remote configuration host grants', () => {
  it('reads a connected ordinary target under the host agent.read grant', async () => {
    expect((await readConfigForRemoteCaller('peer', 'sender', 'receiver')).isError).toBeFalsy();
    expect(mocks.configRead).toHaveBeenCalledWith('receiver');
  });
  it('allows only the authenticated member controller to read without a connection', async () => {
    mocks.link = false;
    expect((await readConfigForRemoteCaller('peer', 'controller', 'receiver')).isError).toBeFalsy();
    expect((await readConfigForRemoteCaller('peer', 'sender', 'receiver')).isError).toBe(true);
    mocks.controller = 'replacement';
    expect(isConfigDispatcher('peer', 'controller')).toBe(false);
    expect((await readConfigForRemoteCaller('peer', 'controller', 'receiver')).isError).toBe(true);
  });
  it('honors host saved Off for an ordinary agent and the unconnected controller', async () => {
    mocks.hostOff = true;
    expect((await readConfigForRemoteCaller('peer', 'sender', 'receiver')).isError).toBe(true);
    mocks.link = false;
    expect((await readConfigForRemoteCaller('peer', 'controller', 'receiver')).isError).toBe(true);
    expect(mocks.configRead).not.toHaveBeenCalled();
  });
  it('rejects a non-member and rechecks revocation before returning content', async () => {
    mocks.member = false;
    expect((await readConfigForRemoteCaller('peer', 'controller', 'receiver')).isError).toBe(true);
    mocks.member = true;
    mocks.configRead.mockImplementationOnce(async () => { mocks.member = false; return { instructions: { text: 'Private' } }; });
    expect((await readConfigForRemoteCaller('peer', 'controller', 'receiver')).isError).toBe(true);
  });
});

describe('remote settings host grants (#3656)', () => {
  it.each(['read_settings', 'list_settings'] as const)('lets the host agent.read grant decide %s', async (tool) => {
    const args = tool === 'read_settings' ? { select: ['agent.model'] } : {};
    expect((await readConfigForRemoteCaller('peer', 'sender', 'receiver', tool, args)).isError).toBeFalsy();
    expect(mocks.settingsRead).toHaveBeenCalledWith('receiver', tool, args);
    mocks.settingsRead.mockClear(); mocks.hostOff = true;
    expect((await readConfigForRemoteCaller('peer', 'sender', 'receiver', tool, args)).isError).toBe(true);
    expect(mocks.settingsRead).not.toHaveBeenCalled();
    mocks.hostOff = false; mocks.disabled = [tool];
    expect((await readConfigForRemoteCaller('peer', 'sender', 'receiver', tool, args)).isError).toBe(true);
  });

  it('rechecks host revocation before returning any settings bytes', async () => {
    mocks.settingsRead.mockImplementationOnce(async () => { mocks.hostOff = true; return { targets: [{ model: 'PRIVATE' }] }; });
    const result = await readConfigForRemoteCaller('peer', 'sender', 'receiver', 'read_settings', { select: ['agent.model'] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});
