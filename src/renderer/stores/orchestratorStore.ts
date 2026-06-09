import { create } from 'zustand';
import type { ProviderCapabilities, OrchestratorInfo } from '../../shared/types';
import { optimisticUpdate } from './optimistic-update';

/** The only orchestrator whose hook server defaults to ON when unset. */
export const DEFAULT_HOOK_SERVER_ORCHESTRATOR = 'claude-code';

interface OrchestratorState {
  enabled: string[];
  allOrchestrators: OrchestratorInfo[];
  availability: Record<string, { available: boolean; error?: string }>;
  /** Explicit per-orchestrator hook server preferences (absent ⇒ use default). */
  hookServerEnabled: Record<string, boolean>;
  loadSettings: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Resolve the effective hook server state for an orchestrator (applies default). */
  isHookServerEnabled: (id: string) => boolean;
  setHookServerEnabled: (id: string, enabled: boolean) => Promise<void>;
  checkAllAvailability: () => Promise<void>;
  getCapabilities: (orchestratorId: string) => ProviderCapabilities | undefined;
}

export const useOrchestratorStore = create<OrchestratorState>((set, get) => ({
  enabled: ['claude-code'],
  allOrchestrators: [],
  availability: {},
  hookServerEnabled: {},

  loadSettings: async () => {
    try {
      const [settings, orchestrators] = await Promise.all([
        window.clubhouse.app.getOrchestratorSettings(),
        window.clubhouse.agent.getOrchestrators(),
      ]);
      set({
        enabled: settings?.enabled ?? ['claude-code'],
        hookServerEnabled: settings?.hookServerEnabled ?? {},
        allOrchestrators: Array.isArray(orchestrators) ? orchestrators : [],
      });
    } catch {
      // Keep defaults on error
    }
  },

  setEnabled: async (id, enabled) => {
    const current = get().enabled;
    let next: string[];
    if (enabled) {
      next = current.includes(id) ? current : [...current, id];
    } else {
      next = current.filter((e) => e !== id);
      // Don't allow disabling all orchestrators unless the last one is not installed
      if (next.length === 0) {
        const { availability } = get();
        const lastIsUnavailable = availability[id] && !availability[id].available;
        if (!lastIsUnavailable) return;
      }
    }
    await optimisticUpdate(set, get,
      { enabled: next },
      () => window.clubhouse.app.saveOrchestratorSettings({ enabled: next }),
    );
  },

  isHookServerEnabled: (id) => {
    const explicit = get().hookServerEnabled[id];
    if (explicit !== undefined) return explicit;
    return id === DEFAULT_HOOK_SERVER_ORCHESTRATOR;
  },

  setHookServerEnabled: async (id, enabled) => {
    const next = { ...get().hookServerEnabled, [id]: enabled };
    await optimisticUpdate(set, get,
      { hookServerEnabled: next },
      () => window.clubhouse.app.setOrchestratorHookServer(id, enabled),
    );
  },

  checkAllAvailability: async () => {
    const orchestrators = get().allOrchestrators;
    const results: Record<string, { available: boolean; error?: string }> = {};
    await Promise.all(
      orchestrators.map(async (o) => {
        try {
          const result = await window.clubhouse.agent.checkOrchestrator(undefined, o.id);
          results[o.id] = result;
        } catch {
          results[o.id] = { available: false, error: 'Check failed' };
        }
      })
    );
    set({ availability: results });
  },

  getCapabilities: (orchestratorId: string) => {
    return get().allOrchestrators.find((o) => o.id === orchestratorId)?.capabilities;
  },
}));
