import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import * as queue from './annex-permission-queue';

describe('annex-permission-queue', () => {
  beforeEach(() => {
    queue.reset();
  });

  it('createPermission returns requestId and decision promise', () => {
    const { requestId, decision } = queue.createPermission('agent1', 'Bash', { command: 'ls' });
    expect(requestId).toBeDefined();
    expect(typeof requestId).toBe('string');
    expect(decision).toBeInstanceOf(Promise);
  });

  it('resolvePermission resolves the decision promise with allow', async () => {
    const { requestId, decision } = queue.createPermission('agent1', 'Bash');
    const resolved = queue.resolvePermission(requestId, 'allow');
    expect(resolved).toBe(true);
    await expect(decision).resolves.toBe('allow');
  });

  it('resolvePermission resolves the decision promise with deny', async () => {
    const { requestId, decision } = queue.createPermission('agent1', 'Bash');
    const resolved = queue.resolvePermission(requestId, 'deny');
    expect(resolved).toBe(true);
    await expect(decision).resolves.toBe('deny');
  });

  it('resolvePermission returns false for unknown requestId', () => {
    const resolved = queue.resolvePermission('nonexistent', 'allow');
    expect(resolved).toBe(false);
  });

  it('resolvePermission returns false for already resolved request', async () => {
    const { requestId, decision } = queue.createPermission('agent1', 'Bash');
    queue.resolvePermission(requestId, 'allow');
    await decision;
    const resolved = queue.resolvePermission(requestId, 'deny');
    expect(resolved).toBe(false);
  });

  it('listPending shows active permissions', () => {
    queue.createPermission('agent1', 'Bash');
    queue.createPermission('agent2', 'Edit');
    expect(queue.listPending().length).toBe(2);
  });

  it('listPendingForAgent filters by agent', () => {
    queue.createPermission('agent1', 'Bash');
    queue.createPermission('agent2', 'Edit');
    queue.createPermission('agent1', 'Write');
    expect(queue.listPendingForAgent('agent1').length).toBe(2);
    expect(queue.listPendingForAgent('agent2').length).toBe(1);
  });

  it('clearForAgent resolves all pending as timeout', async () => {
    const { decision: d1 } = queue.createPermission('agent1', 'Bash');
    const { decision: d2 } = queue.createPermission('agent1', 'Write');
    const { decision: d3 } = queue.createPermission('agent2', 'Bash');

    queue.clearForAgent('agent1');

    await expect(d1).resolves.toBe('timeout');
    await expect(d2).resolves.toBe('timeout');

    // agent2 should still be pending
    expect(queue.listPending().length).toBe(1);
    expect(queue.listPendingForAgent('agent2').length).toBe(1);

    // Clean up agent2
    queue.clearForAgent('agent2');
    await expect(d3).resolves.toBe('timeout');
  });

  it('timeout resolves decision as timeout', async () => {
    vi.useFakeTimers();
    const { decision } = queue.createPermission('agent1', 'Bash', undefined, undefined, 100);

    vi.advanceTimersByTime(101);
    await expect(decision).resolves.toBe('timeout');
    expect(queue.listPending().length).toBe(0);
    vi.useRealTimers();
  });

  it('onPermissionRequest fires for new requests', () => {
    const listener = vi.fn();
    const unsub = queue.onPermissionRequest(listener);

    queue.createPermission('agent1', 'Bash', { command: 'ls' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      }),
    );

    unsub();
    queue.createPermission('agent2', 'Edit');
    expect(listener).toHaveBeenCalledTimes(1); // Not called again
  });

  it('reset clears everything', async () => {
    const { decision } = queue.createPermission('agent1', 'Bash');
    queue.reset();

    await expect(decision).resolves.toBe('timeout');
    expect(queue.listPending().length).toBe(0);
  });

  describe('race-fix invariants', () => {
    it('PERMISSION_QUEUE_TIMEOUT_MS is strictly less than the orchestrator hook timeout', async () => {
      // The whole point of the race fix: our queue must resolve before the
      // orchestrator's permissionRequest hook timeout fires, so the
      // orchestrator actually receives our 'ask' fallback decision instead
      // of killing the curl child and stalling.
      const { PERMISSION_HOOK_TIMEOUT_SEC } = await import('../orchestrators/types');
      expect(queue.PERMISSION_QUEUE_TIMEOUT_MS).toBeLessThan(PERMISSION_HOOK_TIMEOUT_SEC * 1000);
      expect(queue.PERMISSION_QUEUE_SAFETY_MARGIN_MS).toBeGreaterThan(0);
    });

    it('createPermission defaults to PERMISSION_QUEUE_TIMEOUT_MS when no timeout is passed', async () => {
      vi.useFakeTimers();
      const { decision } = queue.createPermission('agent1', 'Bash');

      // Advance just past the orchestrator hook timeout — by then our queue
      // must already have resolved (otherwise the race is lost).
      vi.advanceTimersByTime(queue.PERMISSION_QUEUE_TIMEOUT_MS + 1);
      await expect(decision).resolves.toBe('timeout');
      vi.useRealTimers();
    });

    it('an explicit timeoutMs overrides the default', async () => {
      vi.useFakeTimers();
      const { decision } = queue.createPermission('agent1', 'Bash', undefined, undefined, 50);
      vi.advanceTimersByTime(51);
      await expect(decision).resolves.toBe('timeout');
      vi.useRealTimers();
    });
  });
});
