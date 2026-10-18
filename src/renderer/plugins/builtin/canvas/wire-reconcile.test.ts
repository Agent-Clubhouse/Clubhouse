import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { createWireReconciler, MAX_BIND_FAILURES, type WireTargetState } from './wire-reconcile';

const wire = (agentId: string, targetId: string, extra: Partial<McpBindingEntry> = {}): McpBindingEntry =>
  ({ agentId, targetId, targetKind: 'agent', label: targetId, ...extra });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createWireReconciler', () => {
  it('binds a definition that has no live binding, with the full definition (instructions and disabled tools)', () => {
    const bind = vi.fn(async () => {});
    const r = createWireReconciler({ bind });
    const def = wire('a1', 'a2', { instructions: { '*': 'Be brief' }, disabledTools: ['broadcast'] });
    r.reconcile([def], []);
    expect(bind).toHaveBeenCalledWith(def);
  });

  it('leaves wires that already have a binding alone', () => {
    const bind = vi.fn(async () => {});
    createWireReconciler({ bind }).reconcile([wire('a1', 'a2')], [{ agentId: 'a1', targetId: 'a2' }]);
    expect(bind).not.toHaveBeenCalled();
  });

  it('keeps retrying a failing bind at the 60 s cap, reporting once, and binds when it starts working', async () => {
    let failing = true;
    const bind = vi.fn(async () => { if (failing) throw new Error('MCP is off'); });
    const onReport = vi.fn();
    const r = createWireReconciler({ bind, onReport });
    const def = wire('a1', 'a2');
    // Well past the point where it would once have given up.
    for (let tick = 0; tick < 600; tick++) {
      r.reconcile([def], []);
      await vi.advanceTimersByTimeAsync(2000);
    }
    const attempts = bind.mock.calls.length;
    expect(attempts).toBeGreaterThan(MAX_BIND_FAILURES);
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledWith(def, 'bind_failing');

    // MCP comes on: the next attempt (within the 60 s cap) succeeds.
    failing = false;
    for (let tick = 0; tick < 31; tick++) {
      r.reconcile([def], []);
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(bind.mock.calls.length).toBeGreaterThan(attempts);
    await expect(bind.mock.results.at(-1)!.value).resolves.toBeUndefined();
    r.dispose();
  });

  it('never binds a target that does not exist here, and says so once', () => {
    const bind = vi.fn(async () => {});
    const onReport = vi.fn();
    const r = createWireReconciler({ bind, onReport, targetState: () => 'missing' });
    const def = wire('a1', 'gp-from-another-machine', { targetKind: 'group-project' });
    r.reconcile([def], []);
    r.reconcile([def], []);
    expect(bind).not.toHaveBeenCalled();
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledWith(def, 'missing_target');
  });

  it('waits while a target is unknown, then binds once it is known', () => {
    let state: WireTargetState = 'unknown';
    const bind = vi.fn(async () => {});
    const r = createWireReconciler({ bind, targetState: () => state });
    const def = wire('a1', 'gp-1', { targetKind: 'group-project' });
    r.reconcile([def], []);
    expect(bind).not.toHaveBeenCalled();
    state = 'ok';
    r.reconcile([def], []);
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it('starts fresh for a wire that was removed and added back', async () => {
    const onReport = vi.fn();
    const r = createWireReconciler({ bind: vi.fn(async () => {}), onReport, targetState: () => 'missing' });
    const def = wire('a1', 'gp', { targetKind: 'group-project' });
    r.reconcile([def], []);
    r.reconcile([], []);
    r.reconcile([def], []);
    expect(onReport).toHaveBeenCalledTimes(2);
  });
});
