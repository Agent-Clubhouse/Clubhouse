import { create } from 'zustand';

export interface McpBindingEntry {
  agentId: string;
  targetId: string;
  targetKind: 'browser' | 'agent' | 'terminal' | 'group-project';
  label: string;
  /** Human-readable name of the source agent (e.g. "scrappy-robin"). */
  agentName?: string;
  /** Human-readable name of the target (e.g. "faithful-urchin" for agents). */
  targetName?: string;
  /** Human-readable project name (e.g. "my-frontend-app"). */
  projectName?: string;
  /**
   * Per-wire custom instructions injected into tool descriptions.
   * Keys are tool suffixes (e.g. "send_message") or "*" for all tools.
   */
  instructions?: Record<string, string>;
  /**
   * Tool suffixes disabled on this wire (e.g. ["read_output", "broadcast"]).
   */
  disabledTools?: string[];
}

interface McpBindingStoreState {
  bindings: McpBindingEntry[];
  loadBindings: () => Promise<void>;
  bind: (agentId: string, target: { targetId: string; targetKind: string; label: string; agentName?: string; targetName?: string; projectName?: string }) => Promise<void>;
  unbind: (agentId: string, targetId: string) => Promise<void>;
  setInstructions: (agentId: string, targetId: string, instructions: Record<string, string>) => Promise<void>;
  setDisabledTools: (agentId: string, targetId: string, disabledTools: string[]) => Promise<void>;
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
    // Optimistic update — deduplicate since main process may have already broadcast
    set((state) => {
      const exists = state.bindings.some(
        (b) => b.agentId === agentId && b.targetId === target.targetId,
      );
      if (exists) return state;
      return { bindings: [...state.bindings, { agentId, ...target } as McpBindingEntry] };
    });
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

  setInstructions: async (agentId, targetId, instructions) => {
    await window.clubhouse.mcpBinding.setInstructions(agentId, targetId, instructions);
    // Optimistic update
    set((state) => ({
      bindings: state.bindings.map((b) =>
        b.agentId === agentId && b.targetId === targetId
          ? { ...b, instructions: Object.keys(instructions).length > 0 ? instructions : undefined }
          : b,
      ),
    }));
  },

  setDisabledTools: async (agentId, targetId, disabledTools) => {
    await window.clubhouse.mcpBinding.setDisabledTools(agentId, targetId, disabledTools);
    // Optimistic update
    set((state) => ({
      bindings: state.bindings.map((b) =>
        b.agentId === agentId && b.targetId === targetId
          ? { ...b, disabledTools: disabledTools.length > 0 ? disabledTools : undefined }
          : b,
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
        (b.targetKind === 'browser' || b.targetKind === 'agent' || b.targetKind === 'terminal' || b.targetKind === 'group-project'),
    );
    useMcpBindingStore.setState({ bindings: validated });
  });
}
