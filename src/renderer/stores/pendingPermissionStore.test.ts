import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePendingPermissionStore, selectPendingForAgent } from './pendingPermissionStore';
import type { PendingPermissionInfo } from '../../shared/permission-types';

function makePermission(overrides?: Partial<PendingPermissionInfo>): PendingPermissionInfo {
  return {
    requestId: 'req-1',
    agentId: 'agent-1',
    toolName: 'Skill',
    createdAt: 1_000,
    timeoutMs: 110_000,
    ...overrides,
  };
}

describe('pendingPermissionStore', () => {
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    usePendingPermissionStore.setState({ byRequestId: {} });
    // The baseline preload mock uses plain functions, not spies.
    resolveSpy = vi.spyOn(window.clubhouse.agent, 'resolvePendingPermission');
  });

  it('hydrate replaces the queue wholesale', () => {
    usePendingPermissionStore.getState().addPending(makePermission({ requestId: 'stale' }));

    usePendingPermissionStore.getState().hydrate([
      makePermission({ requestId: 'a' }),
      makePermission({ requestId: 'b' }),
    ]);

    expect(Object.keys(usePendingPermissionStore.getState().byRequestId).sort()).toEqual(['a', 'b']);
  });

  it('addPending and removePending track individual requests', () => {
    const store = usePendingPermissionStore.getState();
    store.addPending(makePermission({ requestId: 'a' }));
    store.addPending(makePermission({ requestId: 'b' }));

    usePendingPermissionStore.getState().removePending('a');

    expect(Object.keys(usePendingPermissionStore.getState().byRequestId)).toEqual(['b']);
  });

  it('removePending is a no-op for an unknown request', () => {
    usePendingPermissionStore.getState().addPending(makePermission({ requestId: 'a' }));
    const before = usePendingPermissionStore.getState().byRequestId;

    usePendingPermissionStore.getState().removePending('nope');

    expect(usePendingPermissionStore.getState().byRequestId).toBe(before);
  });

  it('clearForAgent drops only that agent’s requests', () => {
    const store = usePendingPermissionStore.getState();
    store.addPending(makePermission({ requestId: 'a', agentId: 'agent-1' }));
    store.addPending(makePermission({ requestId: 'b', agentId: 'agent-2' }));

    usePendingPermissionStore.getState().clearForAgent('agent-1');

    expect(Object.keys(usePendingPermissionStore.getState().byRequestId)).toEqual(['b']);
  });

  it('selectPendingForAgent filters by agent and orders oldest first', () => {
    const state = {
      byRequestId: {
        newer: makePermission({ requestId: 'newer', createdAt: 5_000 }),
        older: makePermission({ requestId: 'older', createdAt: 1_000 }),
        other: makePermission({ requestId: 'other', agentId: 'agent-2', createdAt: 2_000 }),
      },
    };

    expect(selectPendingForAgent(state, 'agent-1').map((p) => p.requestId)).toEqual(['older', 'newer']);
  });

  it('resolve forwards the decision to the main process', async () => {
    resolveSpy.mockResolvedValue({ status: 'resolved' });
    usePendingPermissionStore.getState().addPending(makePermission());

    const outcome = await usePendingPermissionStore.getState().resolve('agent-1', 'req-1', 'allow');

    expect(resolveSpy).toHaveBeenCalledWith('agent-1', 'req-1', 'allow');
    expect(outcome).toEqual({ status: 'resolved' });
    expect(usePendingPermissionStore.getState().byRequestId['req-1']).toBeUndefined();
  });

  it('clears the prompt and surfaces the reason when main refuses the decision', async () => {
    resolveSpy.mockResolvedValue({ status: 'rejected', reason: 'expired' });
    usePendingPermissionStore.getState().addPending(makePermission());

    const outcome = await usePendingPermissionStore.getState().resolve('agent-1', 'req-1', 'allow');

    expect(outcome).toEqual({ status: 'rejected', reason: 'expired' });
    // A refused decision means the request is gone or was never ours — either
    // way the dead prompt should not linger.
    expect(usePendingPermissionStore.getState().byRequestId['req-1']).toBeUndefined();
  });

  it('propagates a transport failure to the caller', async () => {
    resolveSpy.mockRejectedValue(new Error('ipc down'));
    usePendingPermissionStore.getState().addPending(makePermission());

    await expect(
      usePendingPermissionStore.getState().resolve('agent-1', 'req-1', 'allow'),
    ).rejects.toThrow('ipc down');

    // Still pending — nothing confirmed it was answered.
    expect(usePendingPermissionStore.getState().byRequestId['req-1']).toBeDefined();
  });
});
