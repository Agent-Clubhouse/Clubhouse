import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bindingManager } from './binding-manager';

describe('BindingManager', () => {
  beforeEach(() => {
    bindingManager._resetForTesting();
  });

  describe('bind', () => {
    it('creates a binding for an agent', () => {
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'My Browser' });
      const bindings = bindingManager.getBindingsForAgent('agent-1');
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toEqual({
        agentId: 'agent-1',
        targetId: 'widget-1',
        targetKind: 'browser',
        label: 'My Browser',
      });
    });

    it('does not duplicate bindings', () => {
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
      expect(bindingManager.getBindingsForAgent('agent-1')).toHaveLength(1);
    });

    it('allows multiple bindings per agent', () => {
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' });
      expect(bindingManager.getBindingsForAgent('agent-1')).toHaveLength(2);
    });

    it('notifies listeners on change', () => {
      const listener = vi.fn();
      bindingManager.onChange(listener);
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
      expect(listener).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('unbind', () => {
    it('removes a specific binding', () => {
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
      bindingManager.bind('agent-1', { targetId: 'widget-2', targetKind: 'browser', label: 'Browser 2' });
      bindingManager.unbind('agent-1', 'widget-1');
      const bindings = bindingManager.getBindingsForAgent('agent-1');
      expect(bindings).toHaveLength(1);
      expect(bindings[0].targetId).toBe('widget-2');
    });

    it('does nothing for non-existent binding', () => {
      bindingManager.unbind('agent-1', 'widget-1');
      expect(bindingManager.getBindingsForAgent('agent-1')).toHaveLength(0);
    });

    it('notifies listeners', () => {
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
      const listener = vi.fn();
      bindingManager.onChange(listener);
      bindingManager.unbind('agent-1', 'widget-1');
      expect(listener).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('unbindAgent', () => {
    it('removes all bindings for an agent', () => {
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
      bindingManager.bind('agent-1', { targetId: 'widget-2', targetKind: 'browser', label: 'Browser 2' });
      bindingManager.unbindAgent('agent-1');
      expect(bindingManager.getBindingsForAgent('agent-1')).toHaveLength(0);
    });

    it('does not affect other agents', () => {
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
      bindingManager.bind('agent-2', { targetId: 'widget-2', targetKind: 'browser', label: 'Browser 2' });
      bindingManager.unbindAgent('agent-1');
      expect(bindingManager.getBindingsForAgent('agent-2')).toHaveLength(1);
    });

    it('does nothing for non-existent agent', () => {
      const listener = vi.fn();
      bindingManager.onChange(listener);
      bindingManager.unbindAgent('nonexistent');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('unbindTarget', () => {
    it('removes target from all agents', () => {
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
      bindingManager.bind('agent-2', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
      bindingManager.unbindTarget('widget-1');
      expect(bindingManager.getBindingsForAgent('agent-1')).toHaveLength(0);
      expect(bindingManager.getBindingsForAgent('agent-2')).toHaveLength(0);
    });

    it('preserves other bindings', () => {
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'B1' });
      bindingManager.bind('agent-1', { targetId: 'widget-2', targetKind: 'browser', label: 'B2' });
      bindingManager.unbindTarget('widget-1');
      expect(bindingManager.getBindingsForAgent('agent-1')).toHaveLength(1);
      expect(bindingManager.getBindingsForAgent('agent-1')[0].targetId).toBe('widget-2');
    });

    it('notifies affected agents', () => {
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'B' });
      bindingManager.bind('agent-2', { targetId: 'widget-1', targetKind: 'browser', label: 'B' });
      const listener = vi.fn();
      bindingManager.onChange(listener);
      bindingManager.unbindTarget('widget-1');
      expect(listener).toHaveBeenCalledWith('agent-1');
      expect(listener).toHaveBeenCalledWith('agent-2');
    });
  });

  describe('getAllBindings', () => {
    it('returns all bindings across agents', () => {
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'B1' });
      bindingManager.bind('agent-2', { targetId: 'widget-2', targetKind: 'agent', label: 'A2' });
      const all = bindingManager.getAllBindings();
      expect(all).toHaveLength(2);
    });

    it('returns empty array when no bindings', () => {
      expect(bindingManager.getAllBindings()).toHaveLength(0);
    });
  });

  describe('onChange', () => {
    it('returns unsubscribe function', () => {
      const listener = vi.fn();
      const unsubscribe = bindingManager.onChange(listener);
      bindingManager.bind('agent-1', { targetId: 'w1', targetKind: 'browser', label: 'B' });
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      bindingManager.bind('agent-1', { targetId: 'w2', targetKind: 'browser', label: 'B2' });
      expect(listener).toHaveBeenCalledTimes(1); // Not called again
    });

    it('handles listener errors gracefully', () => {
      const badListener = vi.fn(() => { throw new Error('boom'); });
      const goodListener = vi.fn();
      bindingManager.onChange(badListener);
      bindingManager.onChange(goodListener);
      bindingManager.bind('agent-1', { targetId: 'w1', targetKind: 'browser', label: 'B' });
      expect(goodListener).toHaveBeenCalled();
    });

    it('supports multiple listeners simultaneously', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();
      bindingManager.onChange(listener1);
      bindingManager.onChange(listener2);
      bindingManager.onChange(listener3);

      bindingManager.bind('agent-1', { targetId: 'w1', targetKind: 'browser', label: 'B' });
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
      expect(listener3).toHaveBeenCalledTimes(1);
    });
  });

  describe('complex scenarios', () => {
    it('handles bind + unbind + rebind cycle', () => {
      bindingManager.bind('agent-1', { targetId: 'w1', targetKind: 'browser', label: 'B' });
      expect(bindingManager.getBindingsForAgent('agent-1')).toHaveLength(1);

      bindingManager.unbind('agent-1', 'w1');
      expect(bindingManager.getBindingsForAgent('agent-1')).toHaveLength(0);

      bindingManager.bind('agent-1', { targetId: 'w1', targetKind: 'browser', label: 'B' });
      expect(bindingManager.getBindingsForAgent('agent-1')).toHaveLength(1);
    });

    it('handles unbindTarget with no matching bindings', () => {
      bindingManager.bind('agent-1', { targetId: 'w1', targetKind: 'browser', label: 'B' });
      const listener = vi.fn();
      bindingManager.onChange(listener);

      bindingManager.unbindTarget('nonexistent');
      expect(listener).not.toHaveBeenCalled();
      expect(bindingManager.getBindingsForAgent('agent-1')).toHaveLength(1);
    });

    it('multiple agents bound to same target', () => {
      bindingManager.bind('agent-1', { targetId: 'shared', targetKind: 'browser', label: 'B' });
      bindingManager.bind('agent-2', { targetId: 'shared', targetKind: 'browser', label: 'B' });
      bindingManager.bind('agent-3', { targetId: 'shared', targetKind: 'browser', label: 'B' });

      expect(bindingManager.getAllBindings()).toHaveLength(3);

      bindingManager.unbindTarget('shared');
      expect(bindingManager.getAllBindings()).toHaveLength(0);
    });

    it('mixed target kinds per agent', () => {
      bindingManager.bind('agent-1', { targetId: 'browser-1', targetKind: 'browser', label: 'Browser' });
      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'Agent' });
      bindingManager.bind('agent-1', { targetId: 'term-1', targetKind: 'terminal', label: 'Terminal' });

      const bindings = bindingManager.getBindingsForAgent('agent-1');
      expect(bindings).toHaveLength(3);
      expect(bindings.map(b => b.targetKind).sort()).toEqual(['agent', 'browser', 'terminal']);
    });
  });
});
