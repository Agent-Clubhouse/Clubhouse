import { create } from 'zustand';
import type { ProviderCapabilities, OrchestratorInfo } from '../../shared/types';

interface OrchestratorState {
  enabled: string[];
  allOrchestrators: OrchestratorInfo[];
  availability: Record<string, { available: boolean; error?: string }>;
  loadSettings: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  checkAllAvailability: () => Promise<void>;
  getEnabledOrchestrators: () => OrchestratorInfo[];
  getCapabilities: (orchestratorId: string) => ProviderCapabilities | undefined;
}

export const useOrchestratorStore = create<OrchestratorState>((set, get) => ({
  enabled: ['claude-code'],
  allOrchestrators: [],
  availability: {},

  loadSettings: async () => {
    try {
      const [settings, orchestrators] = await Promise.all([
        window.clubhouse.app.getOrchestratorSettings(),
        window.clubhouse.agent.getOrchestrators(),
      ]);
      set({
        enabled: settings?.enabled ?? ['claude-code'],
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
      // Don't allow disabling all orchestrators
      if (next.length === 0) return;
    }
    set({ enabled: next });
    try {
      await window.clubhouse.app.saveOrchestratorSettings({ enabled: next });
    } catch {
      // Revert on error
      set({ enabled: current });
    }
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

  getEnabledOrchestrators: () => {
    const { enabled, allOrchestrators } = get();
    return allOrchestrators.filter((o) => enabled.includes(o.id));
  },

  getCapabilities: (orchestratorId: string) => {
    return get().allOrchestrators.find((o) => o.id === orchestratorId)?.capabilities;
  },
}));
