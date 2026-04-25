import { describe, it, expect, vi } from 'vitest';
import { optimisticUpdate } from './optimistic-update';

interface TestState {
  count: number;
  name: string;
  items: string[];
}

function createMockStore(initial: TestState) {
  let state = { ...initial };
  const set = vi.fn((partial: Partial<TestState>) => {
    state = { ...state, ...partial };
  });
  const get = () => state;
  return { set, get };
}

describe('optimisticUpdate', () => {
  it('applies the update optimistically', async () => {
    const { set, get } = createMockStore({ count: 0, name: 'a', items: [] });
    const ipcCall = vi.fn().mockResolvedValue(undefined);

    await optimisticUpdate(set, get, { count: 1 }, ipcCall);

    expect(get().count).toBe(1);
    expect(set).toHaveBeenCalledWith({ count: 1 });
  });

  it('calls the IPC function after applying update', async () => {
    const { set, get } = createMockStore({ count: 0, name: 'a', items: [] });
    const callOrder: string[] = [];

    const ipcCall = vi.fn().mockImplementation(async () => {
      callOrder.push('ipc');
    });
    set.mockImplementation((partial: Partial<TestState>) => {
      callOrder.push('set');
      Object.assign(get(), partial);
    });

    await optimisticUpdate(set, get, { count: 1 }, ipcCall);

    expect(callOrder).toEqual(['set', 'ipc']);
  });

  it('reverts on IPC failure', async () => {
    const { set, get } = createMockStore({ count: 5, name: 'a', items: [] });
    const ipcCall = vi.fn().mockRejectedValue(new Error('IPC failed'));

    await optimisticUpdate(set, get, { count: 10 }, ipcCall);

    // Should have reverted to 5
    expect(get().count).toBe(5);
    // Two set calls: optimistic update + revert
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenNthCalledWith(1, { count: 10 });
    expect(set).toHaveBeenNthCalledWith(2, { count: 5 });
  });

  it('does not revert on IPC success', async () => {
    const { set, get } = createMockStore({ count: 0, name: 'a', items: [] });
    const ipcCall = vi.fn().mockResolvedValue(undefined);

    await optimisticUpdate(set, get, { count: 42 }, ipcCall);

    expect(get().count).toBe(42);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('only snapshots and reverts the fields being updated', async () => {
    const { set, get } = createMockStore({ count: 0, name: 'original', items: ['a'] });
    const ipcCall = vi.fn().mockRejectedValue(new Error('fail'));

    await optimisticUpdate(set, get, { count: 99 }, ipcCall);

    // count should revert
    expect(get().count).toBe(0);
    // name and items should be unchanged
    expect(get().name).toBe('original');
    expect(get().items).toEqual(['a']);
    // Revert call should only include the snapshotted field
    expect(set).toHaveBeenNthCalledWith(2, { count: 0 });
  });

  it('handles multi-field updates and rollbacks', async () => {
    const { set, get } = createMockStore({ count: 1, name: 'old', items: ['x'] });
    const ipcCall = vi.fn().mockRejectedValue(new Error('fail'));

    await optimisticUpdate(set, get, { count: 2, name: 'new' }, ipcCall);

    expect(get().count).toBe(1);
    expect(get().name).toBe('old');
    expect(set).toHaveBeenNthCalledWith(2, { count: 1, name: 'old' });
  });

  it('snapshots state before the optimistic set', async () => {
    const { set: originalSet, get } = createMockStore({ count: 0, name: 'a', items: [] });

    // Track what state was when ipcCall runs
    let stateAtIpcCall: TestState | undefined;
    const ipcCall = vi.fn().mockImplementation(async () => {
      stateAtIpcCall = { ...get() };
    });

    await optimisticUpdate(originalSet, get, { count: 7 }, ipcCall);

    // At IPC call time, optimistic update should already be applied
    expect(stateAtIpcCall?.count).toBe(7);
  });

  it('works with reference-type values (objects/arrays)', async () => {
    const origItems = ['a', 'b'];
    const { set, get } = createMockStore({ count: 0, name: 'a', items: origItems });
    const ipcCall = vi.fn().mockRejectedValue(new Error('fail'));

    await optimisticUpdate(set, get, { items: ['x', 'y', 'z'] }, ipcCall);

    // Should revert to the original array reference
    expect(get().items).toBe(origItems);
  });

  it('preserves concurrent mutations on rollback when using optimisticUpdate (CQ-C03)', async () => {
    const { set, get } = createMockStore({ count: 0, name: 'original', items: [] });

    // IPC that triggers a concurrent optimistic mutation during the await
    const ipcCall = vi.fn().mockImplementation(async () => {
      // Concurrent optimisticUpdate changes 'name' while our IPC is in flight
      await optimisticUpdate(set, get, { name: 'concurrently-changed' }, async () => {});
      throw new Error('IPC failed');
    });

    await optimisticUpdate(set, get, { count: 99 }, ipcCall);

    // count should revert (no concurrent change to this key)
    expect(get().count).toBe(0);
    // name should be preserved — it was changed by a concurrent optimistic update
    expect(get().name).toBe('concurrently-changed');
  });

  it('skips rollback entirely when all keys were concurrently modified via optimisticUpdate', async () => {
    const { set, get } = createMockStore({ count: 0, name: 'a', items: [] });

    const ipcCall = vi.fn().mockImplementation(async () => {
      // Concurrent optimistic update overwrites the same key
      await optimisticUpdate(set, get, { count: 42 }, async () => {});
      throw new Error('IPC failed');
    });

    await optimisticUpdate(set, get, { count: 99 }, ipcCall);

    // count was concurrently changed to 42 — rollback should NOT clobber it
    expect(get().count).toBe(42);
  });

  it('partially rolls back when some keys were concurrently modified via optimisticUpdate', async () => {
    const { set, get } = createMockStore({ count: 0, name: 'old', items: [] });

    const ipcCall = vi.fn().mockImplementation(async () => {
      // Concurrent optimistic update changes 'name' but not 'count'
      await optimisticUpdate(set, get, { name: 'concurrent' }, async () => {});
      throw new Error('IPC failed');
    });

    await optimisticUpdate(set, get, { count: 10, name: 'optimistic' }, ipcCall);

    // count should revert — no concurrent change
    expect(get().count).toBe(0);
    // name should keep the concurrent value — not reverted
    expect(get().name).toBe('concurrent');
  });

  // ── LB-SM-001: round-trip tests ──────────────────────────────────────────────
  // These tests verify that rollback works correctly when the store state is
  // cloned (as happens during Electron IPC round-trips), breaking reference
  // equality between the applied update value and the current state value.

  it('reverts correctly when primitive values are cloned (LB-SM-001)', async () => {
    let state: TestState = { count: 5, name: 'original', items: [] };
    const set = (partial: Partial<TestState>) => {
      // Clone on every set — simulates IPC round-trip serialization
      state = JSON.parse(JSON.stringify({ ...state, ...partial }));
    };
    const get = () => state;

    const ipcCall = vi.fn().mockRejectedValue(new Error('IPC failed'));
    await optimisticUpdate(set, get, { count: 10, name: 'updated' }, ipcCall);

    expect(get().count).toBe(5);
    expect(get().name).toBe('original');
  });

  it('reverts correctly when object values are cloned during IPC round-trip (LB-SM-001)', async () => {
    let state: TestState = { count: 0, name: 'a', items: ['a', 'b'] };
    const set = (partial: Partial<TestState>) => {
      // Deep clone on every set — simulates structured-clone over Electron IPC
      state = JSON.parse(JSON.stringify({ ...state, ...partial }));
    };
    const get = () => state;

    const ipcCall = vi.fn().mockRejectedValue(new Error('IPC failed'));
    await optimisticUpdate(set, get, { items: ['x', 'y'] }, ipcCall);

    // After IPC failure, items should be reverted to original value
    expect(get().items).toEqual(['a', 'b']);
  });

  it('does not revert when IPC succeeds even after clone (LB-SM-001)', async () => {
    let state: TestState = { count: 0, name: 'a', items: ['a', 'b'] };
    const set = (partial: Partial<TestState>) => {
      state = JSON.parse(JSON.stringify({ ...state, ...partial }));
    };
    const get = () => state;

    const ipcCall = vi.fn().mockResolvedValue(undefined);
    await optimisticUpdate(set, get, { items: ['x', 'y'] }, ipcCall);

    // Update should stick on success
    expect(get().items).toEqual(['x', 'y']);
  });

  it('preserves concurrent mutation when both stores clone on set (LB-SM-001)', async () => {
    let state: TestState = { count: 0, name: 'old', items: [] };
    const set = (partial: Partial<TestState>) => {
      state = JSON.parse(JSON.stringify({ ...state, ...partial }));
    };
    const get = () => state;

    const ipcCall = vi.fn().mockImplementation(async () => {
      await optimisticUpdate(set, get, { count: 42 }, async () => {});
      throw new Error('IPC failed');
    });

    await optimisticUpdate(set, get, { count: 99 }, ipcCall);

    // Concurrent write wins — original update should not be rolled back
    expect(get().count).toBe(42);
  });
});
