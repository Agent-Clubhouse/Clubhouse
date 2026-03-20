import { create } from 'zustand';

export interface McpBindingEntry {
  agentId: string;
  targetId: string;
  targetKind: 'browser' | 'agent' | 'terminal';
  label: string;
  /** Human-readable name of the source agent (e.g. "scrappy-robin"). */
  agentName?: string;
  /** Human-readable name of the target (e.g. "faithful-urchin" for agents). */
  targetName?: string;
}

interface McpBindingStoreState {
  bindings: McpBindingEntry[];
  loadBindings: () => Promise<void>;
  bind: (agentId: string, target: { targetId: string; targetKind: string; label: string; agentName?: string; targetName?: string }) => Promise<void>;
  unbind: (agentId: string, targetId: string) => Promise<void>;
  registerWebview: (widgetId: string, webContentsId: number) => Promise<void>;
  unregisterWebview: (widgetId: string) => Promise<void>;
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

  registerWebview: async (widgetId, webContentsId) => {
    try {
      await window.clubhouse.mcpBinding.registerWebview(widgetId, String(webContentsId));
    } catch {
      // MCP not enabled — ignore
    }
  },

  unregisterWebview: async (widgetId) => {
    try {
      await window.clubhouse.mcpBinding.unregisterWebview(widgetId);
    } catch {
      // MCP not enabled — ignore
    }
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
