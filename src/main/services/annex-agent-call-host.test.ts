import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Grant } from '../../shared/agent-grants';
import type { ActionRun } from '../../shared/actions';
import type { DeliveryOutboxItem } from './annex-delivery-store';

const mocks = vi.hoisted(() => ({
  grants: [] as Grant[], link: true, disabled: [] as string[], disposed: false,
  runtime: undefined as undefined | {
    kind: 'chat'; isRunning: () => boolean; getState: () => 'idle' | 'running';
    readTranscript: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn>;
  },
  records: new Map<string, ActionRun>(), record: vi.fn(), ready: true,
  permissionHash: 'approved',
}));
vi.mock('./agent-grants-service', () => ({ effectiveAgentGrants: async () => mocks.grants }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: () => undefined } }));
vi.mock('./agent-config', () => ({
  peekDurableConfigs: async () => [{ id: 'sender' }],
  getDurableConfig: async () => ({ id: 'sender', ...(mocks.disposed && { status: 'disposed' }) }),
}));
vi.mock('./connection-grants-store', () => ({ getConnectionDirection: () => ({ link: mocks.link ? {} : undefined, disabledTools: mocks.disabled }) }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: () => ({ enabled: true, path: '/dispatcher' }), isDispatcherAgentId: () => false, isDispatcherChatAgentId: () => false }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ path: '/project' }] }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => mocks.runtime }));
vi.mock('./actions', () => ({ actionsReady: () => mocks.ready, recordExternalRun: mocks.record }));
vi.mock('./dispatcher-federation-policy', () => ({ federationMessageDirection: () => mocks.link ? {} : undefined, federationRequestRouter: () => undefined }));
vi.mock('./dispatcher-remote-permissions', () => ({ remoteDispatcherPermissionHash: () => mocks.permissionHash }));

import { authorizeQueuedAnnexCall, reportAnnexDeliveryFailure } from './annex-agent-call-host';

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
  mocks.link = true; mocks.disabled = []; mocks.disposed = false;
  mocks.permissionHash = 'approved';
  mocks.grants = [{ action: 'agent.message', target: { kind: 'connected' }, mode: 'allow' }];
  mocks.record.mockImplementation(async (run: ActionRun) => { mocks.records.set(run.id, run); });
});

describe('durable Annex host integration', () => {
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
