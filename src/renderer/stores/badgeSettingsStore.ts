import { create } from 'zustand';

export interface ResolvedBadgeSettings {
  enabled: boolean;
  pluginBadges: boolean;
  projectRailBadges: boolean;
}

interface BadgeSettingsState {
  enabled: boolean;
  pluginBadges: boolean;
  projectRailBadges: boolean;
  projectOverrides: Record<string, Partial<ResolvedBadgeSettings>>;

  loadSettings: () => Promise<void>;
  saveAppSettings: (partial: Partial<ResolvedBadgeSettings>) => Promise<void>;
  getProjectSettings: (projectId: string) => ResolvedBadgeSettings;
  setProjectOverride: (projectId: string, partial: Partial<ResolvedBadgeSettings>) => Promise<void>;
  clearProjectOverride: (projectId: string) => Promise<void>;
}

function persist(state: BadgeSettingsState): void {
  window.clubhouse.app.saveBadgeSettings({
    enabled: state.enabled,
    pluginBadges: state.pluginBadges,
    projectRailBadges: state.projectRailBadges,
    projectOverrides: state.projectOverrides,
  });
}

export const useBadgeSettingsStore = create<BadgeSettingsState>((set, get) => ({
  enabled: false,
  pluginBadges: true,
  projectRailBadges: true,
  projectOverrides: {},

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.app.getBadgeSettings();
      set({
        enabled: settings?.enabled ?? false,
        pluginBadges: settings?.pluginBadges ?? true,
        projectRailBadges: settings?.projectRailBadges ?? true,
        projectOverrides: settings?.projectOverrides ?? {},
      });
    } catch {
      // Keep defaults
    }
  },

  saveAppSettings: async (partial) => {
    const prev = { enabled: get().enabled, pluginBadges: get().pluginBadges, projectRailBadges: get().projectRailBadges };
    set(partial);
    try {
      persist(get());
    } catch {
      set(prev);
    }
  },

  getProjectSettings: (projectId) => {
    const { enabled, pluginBadges, projectRailBadges, projectOverrides } = get();
    const overrides = projectOverrides[projectId];
    return {
      enabled: overrides?.enabled ?? enabled,
      pluginBadges: overrides?.pluginBadges ?? pluginBadges,
      projectRailBadges: overrides?.projectRailBadges ?? projectRailBadges,
    };
  },

  setProjectOverride: async (projectId, partial) => {
    const prevOverrides = get().projectOverrides;
    const existing = prevOverrides[projectId] ?? {};
    const newOverrides = { ...prevOverrides, [projectId]: { ...existing, ...partial } };
    set({ projectOverrides: newOverrides });
    try {
      persist(get());
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },

  clearProjectOverride: async (projectId) => {
    const prevOverrides = get().projectOverrides;
    const { [projectId]: _, ...rest } = prevOverrides;
    set({ projectOverrides: rest });
    try {
      persist(get());
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },
}));
