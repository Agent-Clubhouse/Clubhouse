import { create } from 'zustand';

export interface McpBindingEntry {
  agentId: string;
  targetId: string;
  targetKind: 'browser' | 'agent' | 'terminal';
  label: string;
}

interface McpBindingStoreState {
  bindings: McpBindingEntry[];
  loadBindings: () => Promise<void>;
  bind: (agentId: string, target: { targetId: string; targetKind: string; label: string }) => Promise<void>;
  unbind: (agentId: string, targetId: string) => Promise<void>;
}

export const useMcpBindingStore = create<McpBindingStoreState>((set) => ({
  bindings: [],

  loadBindings: async () => {
    try {
      const bindings = await window.clubhouse.mcpBinding.getBindings();
      set({ bindings: bindings || [] });
    } catch {
      // Keep defaults
    }
  },

  bind: async (agentId, target) => {
    await window.clubhouse.mcpBinding.bind(agentId, target);
    // Optimistic update
    set((state) => ({
      bindings: [...state.bindings, { agentId, ...target } as McpBindingEntry],
    }));
  },

  unbind: async (agentId, targetId) => {
    await window.clubhouse.mcpBinding.unbind(agentId, targetId);
    // Optimistic update
    set((state) => ({
      bindings: state.bindings.filter(
        (b) => !(b.agentId === agentId && b.targetId === targetId),
      ),
    }));
  },
}));

/** Initialize listener for binding changes from main process. */
export function initMcpBindingListener(): () => void {
  return window.clubhouse.mcpBinding.onBindingsChanged((bindings) => {
    const validated = (bindings || []).filter(
      (b): b is McpBindingEntry =>
        b != null &&
        typeof b.agentId === 'string' &&
        typeof b.targetId === 'string' &&
        typeof b.label === 'string' &&
        (b.targetKind === 'browser' || b.targetKind === 'agent' || b.targetKind === 'terminal'),
    );
    useMcpBindingStore.setState({ bindings: validated });
  });
}
