import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useMcpBindingStore, initMcpBindingListener } from './mcpBindingStore';
import type { McpBindingEntry } from './mcpBindingStore';

// The setup-renderer.ts mock provides plain functions, not vi.fn(). We need to
// replace them with vi.fn() for our tests.
function installMocks() {
  const origMcp = window.clubhouse.mcpBinding;
  const mocks = {
    getBindings: vi.fn(origMcp.getBindings),
    bind: vi.fn(origMcp.bind),
    unbind: vi.fn(origMcp.unbind),
    registerWebview: vi.fn(origMcp.registerWebview),
    unregisterWebview: vi.fn(origMcp.unregisterWebview),
    onBindingsChanged: vi.fn(origMcp.onBindingsChanged),
  };
  (window.clubhouse as any).mcpBinding = mocks;
  return mocks;
}

describe('mcpBindingStore', () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    useMcpBindingStore.setState({ bindings: [] });
    mocks = installMocks();
  });

  it('starts with empty bindings', () => {
    expect(useMcpBindingStore.getState().bindings).toEqual([]);
  });

  describe('loadBindings', () => {
    it('loads bindings from IPC', async () => {
      const mockBindings: McpBindingEntry[] = [
        { agentId: 'a1', targetId: 'w1', targetKind: 'browser', label: 'Browser' },
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent' },
      ];
      mocks.getBindings.mockResolvedValue(mockBindings);

      await useMcpBindingStore.getState().loadBindings();
      expect(useMcpBindingStore.getState().bindings).toEqual(mockBindings);
    });

    it('handles IPC failure gracefully', async () => {
      mocks.getBindings.mockRejectedValue(new Error('IPC error'));

      await useMcpBindingStore.getState().loadBindings();
      expect(useMcpBindingStore.getState().bindings).toEqual([]);
    });

    it('handles null response', async () => {
      mocks.getBindings.mockResolvedValue(null);

      await useMcpBindingStore.getState().loadBindings();
      expect(useMcpBindingStore.getState().bindings).toEqual([]);
    });
  });

  describe('bind', () => {
    it('optimistically adds binding to store', async () => {
      mocks.bind.mockResolvedValue(undefined);

      await useMcpBindingStore.getState().bind('agent-1', {
        targetId: 'widget-1',
        targetKind: 'browser',
        label: 'My Browser',
      });

      const bindings = useMcpBindingStore.getState().bindings;
      expect(bindings).toHaveLength(1);
      expect(bindings[0].agentId).toBe('agent-1');
      expect(bindings[0].targetId).toBe('widget-1');
    });

    it('calls IPC bind', async () => {
      mocks.bind.mockResolvedValue(undefined);

      const target = { targetId: 'w1', targetKind: 'browser', label: 'B' };
      await useMcpBindingStore.getState().bind('a1', target);

      expect(mocks.bind).toHaveBeenCalledWith('a1', target);
    });
  });

  describe('unbind', () => {
    it('optimistically removes binding from store', async () => {
      useMcpBindingStore.setState({
        bindings: [
          { agentId: 'a1', targetId: 'w1', targetKind: 'browser', label: 'B1' },
          { agentId: 'a1', targetId: 'w2', targetKind: 'browser', label: 'B2' },
        ],
      });
      mocks.unbind.mockResolvedValue(undefined);

      await useMcpBindingStore.getState().unbind('a1', 'w1');

      const bindings = useMcpBindingStore.getState().bindings;
      expect(bindings).toHaveLength(1);
      expect(bindings[0].targetId).toBe('w2');
    });

    it('calls IPC unbind', async () => {
      mocks.unbind.mockResolvedValue(undefined);

      await useMcpBindingStore.getState().unbind('a1', 'w1');

      expect(mocks.unbind).toHaveBeenCalledWith('a1', 'w1');
    });
  });

  describe('initMcpBindingListener', () => {
    it('registers and returns unsubscribe function', () => {
      const unsub = initMcpBindingListener();
      expect(typeof unsub).toBe('function');
      unsub();
    });

    it('validates incoming bindings and filters invalid entries', () => {
      let capturedCallback: ((bindings: unknown[]) => void) | null = null;
      mocks.onBindingsChanged.mockImplementation(
        (cb: (bindings: unknown[]) => void) => {
          capturedCallback = cb;
          return () => {};
        },
      );

      initMcpBindingListener();
      expect(capturedCallback).toBeTruthy();

      // Simulate receiving mixed valid and invalid bindings
      capturedCallback!([
        { agentId: 'a1', targetId: 'w1', targetKind: 'browser', label: 'Valid' },
        { agentId: 'a1', targetId: 'w2', targetKind: 'invalid_kind', label: 'Bad Kind' },
        null,
        { agentId: 'a1' }, // Missing fields
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Also Valid' },
      ]);

      const bindings = useMcpBindingStore.getState().bindings;
      expect(bindings).toHaveLength(2);
      expect(bindings[0].targetKind).toBe('browser');
      expect(bindings[1].targetKind).toBe('agent');
    });

    it('handles empty bindings array', () => {
      let capturedCallback: ((bindings: unknown[]) => void) | null = null;
      mocks.onBindingsChanged.mockImplementation(
        (cb: (bindings: unknown[]) => void) => {
          capturedCallback = cb;
          return () => {};
        },
      );

      initMcpBindingListener();
      capturedCallback!([]);

      expect(useMcpBindingStore.getState().bindings).toEqual([]);
    });

    it('handles null bindings payload', () => {
      let capturedCallback: ((bindings: unknown) => void) | null = null;
      mocks.onBindingsChanged.mockImplementation(
        (cb: (bindings: unknown) => void) => {
          capturedCallback = cb;
          return () => {};
        },
      );

      initMcpBindingListener();
      capturedCallback!(null);

      expect(useMcpBindingStore.getState().bindings).toEqual([]);
    });

    it('accepts all valid targetKind values', () => {
      let capturedCallback: ((bindings: unknown[]) => void) | null = null;
      mocks.onBindingsChanged.mockImplementation(
        (cb: (bindings: unknown[]) => void) => {
          capturedCallback = cb;
          return () => {};
        },
      );

      initMcpBindingListener();
      capturedCallback!([
        { agentId: 'a1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent' },
        { agentId: 'a1', targetId: 't1', targetKind: 'terminal', label: 'Terminal' },
      ]);

      expect(useMcpBindingStore.getState().bindings).toHaveLength(3);
    });
  });
});
