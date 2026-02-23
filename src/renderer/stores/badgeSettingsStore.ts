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

// Memoization cache for getProjectSettings — avoids creating new object refs
// on every call, which would cause infinite re-renders if used as a Zustand selector.
const _projectSettingsCache = new Map<string, { result: ResolvedBadgeSettings; enabled: boolean; pluginBadges: boolean; projectRailBadges: boolean; override: Partial<ResolvedBadgeSettings> | undefined }>();

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

    // Return cached result if inputs haven't changed (prevents new object refs
    // that cause infinite re-renders when used as a Zustand selector).
    const cached = _projectSettingsCache.get(projectId);
    if (
      cached &&
      cached.enabled === enabled &&
      cached.pluginBadges === pluginBadges &&
      cached.projectRailBadges === projectRailBadges &&
      cached.override === overrides
    ) {
      return cached.result;
    }

    const result: ResolvedBadgeSettings = {
      enabled: overrides?.enabled ?? enabled,
      pluginBadges: overrides?.pluginBadges ?? pluginBadges,
      projectRailBadges: overrides?.projectRailBadges ?? projectRailBadges,
    };
    _projectSettingsCache.set(projectId, { result, enabled, pluginBadges, projectRailBadges, override: overrides });
    return result;
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
