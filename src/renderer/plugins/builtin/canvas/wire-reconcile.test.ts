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

  it('backs off after failures and gives up after MAX_BIND_FAILURES, reporting once', async () => {
    const bind = vi.fn(async () => { throw new Error('agent not registered'); });
    const onGiveUp = vi.fn();
    const r = createWireReconciler({ bind, onGiveUp });
    const def = wire('a1', 'a2');
    for (let tick = 0; tick < 200; tick++) {
      r.reconcile([def], []);
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(bind).toHaveBeenCalledTimes(MAX_BIND_FAILURES);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledWith(def, 'bind_failed');
    r.dispose();
  });

  it('never binds a target that does not exist here, and says so once', () => {
    const bind = vi.fn(async () => {});
    const onGiveUp = vi.fn();
    const r = createWireReconciler({ bind, onGiveUp, targetState: () => 'missing' });
    const def = wire('a1', 'gp-from-another-machine', { targetKind: 'group-project' });
    r.reconcile([def], []);
    r.reconcile([def], []);
    expect(bind).not.toHaveBeenCalled();
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledWith(def, 'missing_target');
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
    const onGiveUp = vi.fn();
    const r = createWireReconciler({ bind: vi.fn(async () => {}), onGiveUp, targetState: () => 'missing' });
    const def = wire('a1', 'gp', { targetKind: 'group-project' });
    r.reconcile([def], []);
    r.reconcile([], []);
    r.reconcile([def], []);
    expect(onGiveUp).toHaveBeenCalledTimes(2);
  });
});
