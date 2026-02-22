import { describe, it, expect, beforeEach, vi } from 'vitest';
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
});
