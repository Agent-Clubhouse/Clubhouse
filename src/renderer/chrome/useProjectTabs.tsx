import { ReactNode, useCallback, useMemo, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useRemoteProjectStore, isRemoteProjectId, parseNamespacedId, type PluginMatchResult } from '../stores/remoteProjectStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useBadgeStore, aggregateBadges } from '../stores/badgeStore';
import { useBadgeSettingsStore } from '../stores/badgeSettingsStore';
import { sanitizeSvg } from '../utils/sanitize-svg';

/**
 * The per-project tab list: the core Agents tab plus every enabled project or
 * dual-scope plugin that contributes a `tab`. Shared by the legacy explorer
 * column and the new chrome's title bar so both show the same tabs, badges and
 * saved order.
 */

const EMPTY_STRING_ARRAY: string[] = [];

export interface TabEntry { id: string; label: string; icon: ReactNode; disabled?: boolean; disabledReason?: string }

const TAB_ORDER_KEY_PREFIX = 'clubhouse_explorer_tab_order_';

export function loadTabOrder(projectId: string): string[] | null {
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY_PREFIX + projectId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveTabOrder(projectId: string, order: string[]): void {
  try {
    localStorage.setItem(TAB_ORDER_KEY_PREFIX + projectId, JSON.stringify(order));
  } catch (err) {
    console.warn('[ExplorerRail] Failed to persist tab order to localStorage (quota?):', err instanceof Error ? err.message : err);
  }
}

export const CORE_TABS: TabEntry[] = [
  {
    id: 'agents',
    label: 'Agents',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="4" />
        <circle cx="9" cy="16" r="1.5" fill="currentColor" />
        <circle cx="15" cy="16" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
];

export const PLUGIN_FALLBACK_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

/** Aggregated badge for one tab of one project, honoring badge settings. */
export function useTabBadge(tabId: string, projectId: string | null) {
  const badges = useBadgeStore((s) => s.badges);
  const bsEnabled = useBadgeSettingsStore((s) => s.enabled);
  const bsPluginBadges = useBadgeSettingsStore((s) => s.pluginBadges);
  const bsProjectOverride = useBadgeSettingsStore((s) => projectId ? s.projectOverrides[projectId] : undefined);
  return useMemo(() => {
    if (!projectId) return null;
    const enabled = bsProjectOverride?.enabled ?? bsEnabled;
    if (!enabled) return null;
    let filtered = Object.values(badges).filter(
      (b) => b.target.kind === 'explorer-tab' && b.target.projectId === projectId && b.target.tabId === tabId,
    );
    const pluginBadges = bsProjectOverride?.pluginBadges ?? bsPluginBadges;
    if (!pluginBadges) {
      filtered = filtered.filter((b) => !b.source.startsWith('plugin:'));
    }
    return aggregateBadges(filtered);
  }, [badges, projectId, tabId, bsEnabled, bsPluginBadges, bsProjectOverride]);
}

export function useProjectTabs() {
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const satelliteProjects = useRemoteProjectStore((s) => s.satelliteProjects);
  const activeProject = useMemo(() => {
    if (!activeProjectId) return undefined;
    if (isRemoteProjectId(activeProjectId)) {
      for (const rps of Object.values(satelliteProjects)) {
        const found = rps.find((p) => p.id === activeProjectId);
        if (found) return found;
      }
      return undefined;
    }
    return projects.find((p) => p.id === activeProjectId);
  }, [activeProjectId, projects, satelliteProjects]);
  const allPlugins = usePluginStore((s) => s.plugins);
  const appEnabled = usePluginStore((s) => s.appEnabled);
  const isRemote = activeProjectId ? isRemoteProjectId(activeProjectId) : false;
  const enabledPluginIds = usePluginStore(
    (s) => (activeProjectId && !isRemote ? s.projectEnabled[activeProjectId] : undefined) ?? EMPTY_STRING_ARRAY,
  );

  // For remote projects, derive plugin tabs from pluginMatchState
  const pluginMatchState = useRemoteProjectStore((s) => s.pluginMatchState);
  const remotePluginMatches: PluginMatchResult[] = useMemo(() => {
    if (!isRemote || !activeProjectId) return [];
    const parsed = parseNamespacedId(activeProjectId);
    if (!parsed) return [];
    return pluginMatchState[parsed.satelliteId] || [];
  }, [isRemote, activeProjectId, pluginMatchState]);

  // Memoize plugin tab data to avoid new arrays every render.
  // Build a stable key from enabled IDs + their activation status so the memo
  // only recalculates when the actual plugin list or statuses change.
  const pluginTabKey = useMemo(
    () => isRemote
      ? remotePluginMatches.map((p) => `${p.id}:${p.status}`).join(',')
      : enabledPluginIds.map((id) => `${id}:${allPlugins[id]?.status ?? ''}`).join(',') + '|' + appEnabled.join(','),
    [isRemote, enabledPluginIds, allPlugins, remotePluginMatches, appEnabled],
  );

  const pluginEntries: TabEntry[] = useMemo(() => {
    if (isRemote) {
      // For remote projects, show plugin tabs from the satellite's installed plugins
      return remotePluginMatches
        .filter((p) => {
          const contributes = p.contributes as { tab?: { label: string; icon?: string } } | undefined;
          return (p.scope === 'project' || p.scope === 'dual') && contributes?.tab;
        })
        .map((p) => {
          const contributes = p.contributes as { tab: { label: string; icon?: string } };
          // Plugins with the annex permission and matching versions are fully available.
          // Non-annex plugins are clickable (dimmed) — MainContentView shows a placeholder.
          // Missing/version_mismatch plugins remain disabled.
          const isMissing = p.status === 'missing' || p.status === 'version_mismatch';
          const isDimmed = !isMissing && !p.annexEnabled;
          const isAvailable = p.status === 'matched' && p.annexEnabled;
          return {
            id: `plugin:${p.id}`,
            label: contributes.tab.label,
            icon: contributes.tab.icon
              ? <span className={isAvailable ? '' : 'opacity-60'} dangerouslySetInnerHTML={{ __html: sanitizeSvg(contributes.tab.icon) }} />
              : <span className={isAvailable ? '' : 'opacity-60'}>{PLUGIN_FALLBACK_ICON}</span>,
            disabled: isMissing,
            disabledReason: p.status === 'missing'
              ? `${p.name} is not installed on this machine`
              : p.status === 'version_mismatch'
                ? `${p.name} version mismatch (local: ${p.localVersion}, remote: ${p.remoteVersion})`
                : isDimmed
                  ? `${p.name} is not annex enabled`
                  : undefined,
          };
        });
    }
    return enabledPluginIds
      .map((id) => allPlugins[id])
      .filter((entry) => {
        if (!entry) return false;
        if (entry.manifest.scope !== 'project' && entry.manifest.scope !== 'dual') return false;
        if (entry.status !== 'activated') return false;
        if (!entry.manifest.contributes?.tab) return false;
        // Dual-scope plugins must also be enabled at app level (app-first gate)
        if (entry.manifest.scope === 'dual' && !appEnabled.includes(entry.manifest.id)) return false;
        return true;
      })
      .map((entry) => ({
        id: `plugin:${entry.manifest.id}`,
        label: entry.manifest.contributes!.tab!.label,
        icon: entry.manifest.contributes!.tab!.icon
          ? <span dangerouslySetInnerHTML={{ __html: sanitizeSvg(entry.manifest.contributes!.tab!.icon) }} />
          : PLUGIN_FALLBACK_ICON,
      }));
  }, [pluginTabKey]);

  const rawTabs: TabEntry[] = useMemo(
    () => [...CORE_TABS, ...pluginEntries],
    [pluginEntries],
  );

  // Order version counter forces re-render after drag-drop reorder
  const [orderVersion, setOrderVersion] = useState(0);

  const orderedTabs = useMemo(() => {
    if (!activeProjectId) return rawTabs;
    const saved = loadTabOrder(activeProjectId);
    if (!saved) return rawTabs;

    const tabMap = new Map(rawTabs.map((t) => [t.id, t]));
    const ordered: TabEntry[] = [];

    // Pull tabs in saved order (skip IDs no longer present)
    for (const id of saved) {
      const tab = tabMap.get(id);
      if (tab) {
        ordered.push(tab);
        tabMap.delete(id);
      }
    }

    // Append any new tabs not in saved order
    for (const tab of tabMap.values()) {
      ordered.push(tab);
    }

    return ordered;
  }, [activeProjectId, rawTabs, orderVersion]);

  /** Persist a new tab order for the active project. */
  const setTabOrder = useCallback((ids: string[]) => {
    if (activeProjectId) saveTabOrder(activeProjectId, ids);
    setOrderVersion((v) => v + 1);
  }, [activeProjectId]);

  return { activeProjectId, activeProject, orderedTabs, setTabOrder };
}
