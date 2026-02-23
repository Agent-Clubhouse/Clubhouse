import { create } from 'zustand';
import { useBadgeSettingsStore, ResolvedBadgeSettings } from './badgeSettingsStore';

// ── Badge types ────────────────────────────────────────────────────────

export type BadgeType = 'count' | 'dot';

export type BadgeTarget =
  | { kind: 'explorer-tab'; projectId: string; tabId: string }
  | { kind: 'app-plugin'; pluginId: string };

export interface Badge {
  id: string;
  source: string;
  type: BadgeType;
  value: number;
  target: BadgeTarget;
}

// ── Helpers ────────────────────────────────────────────────────────────

function targetKey(target: BadgeTarget): string {
  if (target.kind === 'explorer-tab') {
    return `explorer-tab:${target.projectId}:${target.tabId}`;
  }
  return `app-plugin:${target.pluginId}`;
}

function badgeId(source: string, target: BadgeTarget): string {
  return `${source}::${targetKey(target)}`;
}

function targetsMatch(a: BadgeTarget, b: BadgeTarget): boolean {
  return targetKey(a) === targetKey(b);
}

// ── Aggregation result ─────────────────────────────────────────────────

export interface BadgeAggregate {
  type: BadgeType;
  value: number;
}

// ── Store interface ────────────────────────────────────────────────────

interface BadgeState {
  badges: Record<string, Badge>;

  // Mutations
  setBadge(source: string, type: BadgeType, value: number, target: BadgeTarget): void;
  clearBadge(id: string): void;
  clearBySource(source: string): void;
  clearByTarget(target: BadgeTarget): void;
  clearProjectBadges(projectId: string): void;
  clearAll(): void;

  // Selectors
  getTabBadge(projectId: string, tabId: string): BadgeAggregate | null;
  getProjectBadge(projectId: string): BadgeAggregate | null;
  getAppPluginBadge(pluginId: string): BadgeAggregate | null;
  getDockCount(): number;
}

// ── Aggregation logic ──────────────────────────────────────────────────

export function aggregateBadges(badges: Badge[]): BadgeAggregate | null {
  if (badges.length === 0) return null;

  const countBadges = badges.filter((b) => b.type === 'count');
  if (countBadges.length > 0) {
    const total = countBadges.reduce((sum, b) => sum + b.value, 0);
    return { type: 'count', value: total };
  }

  // Only dot badges exist
  return { type: 'dot', value: 1 };
}

// ── Memoization caches for badge getters ────────────────────────────────
// These prevent new object refs on every call, which would cause infinite
// re-renders if the getters were used as Zustand selectors.

interface BadgeCacheEntry {
  badges: Record<string, Badge>;
  settings: ResolvedBadgeSettings;
  result: BadgeAggregate | null;
}

interface AppPluginBadgeCacheEntry {
  badges: Record<string, Badge>;
  enabled: boolean;
  pluginBadges: boolean;
  result: BadgeAggregate | null;
}

const _tabBadgeCache = new Map<string, BadgeCacheEntry>();
const _projectBadgeCache = new Map<string, BadgeCacheEntry>();
const _appPluginBadgeCache = new Map<string, AppPluginBadgeCacheEntry>();

// ── Store ──────────────────────────────────────────────────────────────

export const useBadgeStore = create<BadgeState>((set, get) => ({
  badges: {},

  setBadge(source, type, value, target) {
    const id = badgeId(source, target);
    const badge: Badge = { id, source, type, value, target };
    set((s) => ({ badges: { ...s.badges, [id]: badge } }));
  },

  clearBadge(id) {
    set((s) => {
      const { [id]: _, ...rest } = s.badges;
      return { badges: rest };
    });
  },

  clearBySource(source) {
    set((s) => {
      const next: Record<string, Badge> = {};
      for (const [id, badge] of Object.entries(s.badges)) {
        if (badge.source !== source) next[id] = badge;
      }
      return { badges: next };
    });
  },

  clearByTarget(target) {
    set((s) => {
      const next: Record<string, Badge> = {};
      for (const [id, badge] of Object.entries(s.badges)) {
        if (!targetsMatch(badge.target, target)) next[id] = badge;
      }
      return { badges: next };
    });
  },

  clearProjectBadges(projectId) {
    set((s) => {
      const next: Record<string, Badge> = {};
      for (const [id, badge] of Object.entries(s.badges)) {
        if (badge.target.kind === 'explorer-tab' && badge.target.projectId === projectId) continue;
        next[id] = badge;
      }
      return { badges: next };
    });
  },

  clearAll() {
    set({ badges: {} });
  },

  getTabBadge(projectId, tabId) {
    const settings = useBadgeSettingsStore.getState().getProjectSettings(projectId);
    if (!settings.enabled) return null;
    const currentBadges = get().badges;
    const cacheKey = `${projectId}:${tabId}`;
    const cached = _tabBadgeCache.get(cacheKey);
    if (cached && cached.badges === currentBadges && cached.settings === settings) {
      return cached.result;
    }

    let badges = Object.values(currentBadges).filter(
      (b) => b.target.kind === 'explorer-tab' && b.target.projectId === projectId && b.target.tabId === tabId,
    );
    if (!settings.pluginBadges) {
      badges = badges.filter((b) => !b.source.startsWith('plugin:'));
    }
    const result = aggregateBadges(badges);
    _tabBadgeCache.set(cacheKey, { badges: currentBadges, settings, result });
    return result;
  },

  getProjectBadge(projectId) {
    const settings = useBadgeSettingsStore.getState().getProjectSettings(projectId);
    if (!settings.enabled) return null;
    if (!settings.projectRailBadges) return null;
    const currentBadges = get().badges;
    const cached = _projectBadgeCache.get(projectId);
    if (cached && cached.badges === currentBadges && cached.settings === settings) {
      return cached.result;
    }

    let badges = Object.values(currentBadges).filter(
      (b) => b.target.kind === 'explorer-tab' && b.target.projectId === projectId,
    );
    if (!settings.pluginBadges) {
      badges = badges.filter((b) => !b.source.startsWith('plugin:'));
    }
    const result = aggregateBadges(badges);
    _projectBadgeCache.set(projectId, { badges: currentBadges, settings, result });
    return result;
  },

  getAppPluginBadge(pluginId) {
    const { enabled, pluginBadges } = useBadgeSettingsStore.getState();
    if (!enabled) return null;
    if (!pluginBadges) return null;
    const currentBadges = get().badges;
    const cached = _appPluginBadgeCache.get(pluginId);
    if (cached && cached.badges === currentBadges && cached.enabled === enabled && cached.pluginBadges === pluginBadges) {
      return cached.result;
    }

    const badges = Object.values(currentBadges).filter(
      (b) => b.target.kind === 'app-plugin' && b.target.pluginId === pluginId,
    );
    const result = aggregateBadges(badges);
    _appPluginBadgeCache.set(pluginId, { badges: currentBadges, enabled, pluginBadges, result });
    return result;
  },

  getDockCount() {
    const { enabled, pluginBadges } = useBadgeSettingsStore.getState();
    if (!enabled) return 0;
    let total = 0;
    for (const badge of Object.values(get().badges)) {
      if (!pluginBadges && badge.source.startsWith('plugin:')) continue;
      if (badge.type === 'count') total += badge.value;
    }
    return total;
  },
}));

// ── Side effects (auto-clear on navigate, dock sync) ───────────────────
// These are initialized lazily to avoid circular imports.

let sideEffectsInitialized = false;

export function initBadgeSideEffects(): void {
  if (sideEffectsInitialized) return;
  sideEffectsInitialized = true;

  // Lazy imports to avoid circular dependencies
  const { useUIStore } = require('./uiStore');
  const { useProjectStore } = require('./projectStore');

  // Auto-clear on project switch
  let prevProjectId: string | null = useProjectStore.getState().activeProjectId;
  useProjectStore.subscribe((state: { activeProjectId: string | null }) => {
    const nextProjectId = state.activeProjectId;
    if (nextProjectId && nextProjectId !== prevProjectId) {
      useBadgeStore.getState().clearProjectBadges(nextProjectId);
    }
    prevProjectId = nextProjectId;
  });

  // Auto-clear on explorer tab switch
  let prevTab: string = useUIStore.getState().explorerTab;
  useUIStore.subscribe((state: { explorerTab: string }) => {
    const nextTab = state.explorerTab;
    if (nextTab !== prevTab) {
      const projectId = useProjectStore.getState().activeProjectId;

      // Clear explorer-tab badges when switching to that tab
      if (projectId && nextTab !== 'settings' && nextTab !== 'help' && !nextTab.startsWith('plugin:app:')) {
        useBadgeStore.getState().clearByTarget({ kind: 'explorer-tab', projectId, tabId: nextTab });
      }

      // Clear app-plugin badges when switching to that plugin
      if (nextTab.startsWith('plugin:app:')) {
        const pluginId = nextTab.replace('plugin:app:', '');
        useBadgeStore.getState().clearByTarget({ kind: 'app-plugin', pluginId });
      }
    }
    prevTab = nextTab;
  });

  // Dock badge sync
  useBadgeStore.subscribe((state) => {
    const count = state.getDockCount();
    try {
      window.clubhouse?.app?.setDockBadge?.(count);
    } catch {
      // Preload bridge may not be available in tests
    }
  });

  // Core agent badge: show dot on Agents tab when any agent needs attention
  const { useAgentStore } = require('./agentStore');
  useAgentStore.subscribe((state: {
    agents: Record<string, { projectId: string; status: string }>;
    agentDetailedStatus: Record<string, { state: string }>;
  }) => {
    // Group agents by project
    const projectNeedsAttention = new Map<string, boolean>();
    for (const agent of Object.values(state.agents)) {
      if (!projectNeedsAttention.has(agent.projectId)) {
        projectNeedsAttention.set(agent.projectId, false);
      }
      if (agent.status === 'error') {
        projectNeedsAttention.set(agent.projectId, true);
      }
    }
    // Check detailed statuses for needs_permission
    for (const [agentId, detail] of Object.entries(state.agentDetailedStatus)) {
      if (detail.state === 'needs_permission') {
        const agent = state.agents[agentId];
        if (agent) {
          projectNeedsAttention.set(agent.projectId, true);
        }
      }
    }
    // Update badges
    for (const [projectId, needsAttention] of projectNeedsAttention) {
      if (needsAttention) {
        useBadgeStore.getState().setBadge('core:agents', 'dot', 1, {
          kind: 'explorer-tab',
          projectId,
          tabId: 'agents',
        });
      } else {
        useBadgeStore.getState().clearBadge(`core:agents::explorer-tab:${projectId}:agents`);
      }
    }
  });
}
