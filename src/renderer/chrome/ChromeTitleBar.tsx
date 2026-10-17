import React from 'react';
import { useUIStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { usePluginStore } from '../plugins/plugin-store';
import { Badge } from '../components/Badge';
import { useChromeStore } from './chromeStore';
import { useProjectTabs, useTabBadge, type TabEntry } from './useProjectTabs';
import { reportChromeFeature } from './telemetry';

/**
 * Title bar for the new chrome (docs/chrome-redesign-spec.md §4.2): the drag
 * region, the sidebar toggle, the active project's tabs and a breadcrumb, with
 * room reserved for the platform window controls.
 *
 * Overflow into a More menu arrives in Phase 3. Until then tabs that do not fit
 * are clipped, which the 8 built-in tabs never are at the 900px minimum width.
 */

const SidebarIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
);

const TitleTab = React.memo(function TitleTab({ tab, isActive, projectId, onSelect }: {
  tab: TabEntry;
  isActive: boolean;
  projectId: string | null;
  onSelect: (id: string) => void;
}) {
  const badge = useTabBadge(tab.id, projectId);
  const disabled = tab.disabled === true;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-disabled={disabled || undefined}
      data-testid={`explorer-tab-${tab.id}`}
      data-active={isActive}
      title={disabled ? tab.disabledReason : tab.label}
      onClick={disabled ? undefined : () => onSelect(tab.id)}
      className={`no-drag flex-shrink-0 h-7 px-2.5 rounded-md flex items-center gap-1.5 text-xs whitespace-nowrap transition-colors duration-100 [&_svg]:w-[15px] [&_svg]:h-[15px] ${
        disabled
          ? 'opacity-40 cursor-not-allowed text-ctp-subtext0'
          : isActive
            ? 'bg-surface-0 text-ctp-text cursor-pointer'
            : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer'
      }`}
    >
      {tab.icon}
      <span>{tab.label}</span>
      {badge && !disabled && <Badge type={badge.type} value={badge.value} inline />}
    </button>
  );
});

/**
 * Breadcrumb text. Mirrors the legacy title (core label or the plugin's
 * tab/rail title, overridden by a plugin's window.setTitle()), shown as
 * "Project / Tab" in a project view (spec §6).
 */
function useBreadcrumb(projectLabel: string | undefined, tabLabel: string | undefined): { parent?: string; current: string } {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const activeAgentName = useAgentStore((s) => (s.activeAgentId ? s.agents[s.activeAgentId]?.name : undefined));
  const appPluginId = explorerTab.startsWith('plugin:app:') ? explorerTab.slice('plugin:app:'.length) : null;
  const projectPluginId = !appPluginId && explorerTab.startsWith('plugin:') ? explorerTab.slice('plugin:'.length) : null;
  const pluginId = appPluginId ?? projectPluginId;
  const dynamicTitle = usePluginStore((s) => (pluginId ? s.pluginTitles[pluginId] : undefined));
  const appPluginLabel = usePluginStore((s) => {
    if (!appPluginId) return undefined;
    const rail = s.plugins[appPluginId]?.manifest.contributes?.railItem;
    return rail?.title || rail?.label || s.plugins[appPluginId]?.manifest.name;
  });
  const projectPluginTitle = usePluginStore((s) => {
    if (!projectPluginId) return undefined;
    const tab = s.plugins[projectPluginId]?.manifest.contributes?.tab;
    return tab?.title || tab?.label;
  });

  if (explorerTab === 'settings') return { current: 'Settings' };
  if (explorerTab === 'help') return { current: 'Help' };
  if (appPluginId) return { current: dynamicTitle || appPluginLabel || appPluginId };
  if (!projectLabel) return { current: 'Clubhouse' };
  if (explorerTab === 'agents') return { parent: projectLabel, current: activeAgentName || 'Agents' };
  return { parent: projectLabel, current: dynamicTitle || projectPluginTitle || tabLabel || projectLabel };
}

export function ChromeTitleBar() {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const sidebarCollapsed = useChromeStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useChromeStore((s) => s.toggleSidebar);
  const { activeProjectId, activeProject, orderedTabs } = useProjectTabs();

  const platform = window.clubhouse.platform;
  const isMac = platform === 'darwin';
  const hasOverlayControls = platform === 'win32';
  const inProjectView = !!activeProjectId && explorerTab !== 'settings' && explorerTab !== 'help' && !explorerTab.startsWith('plugin:app:');
  const projectLabel = activeProject ? (activeProject.displayName || activeProject.name) : undefined;
  const activeTabLabel = orderedTabs.find((t) => t.id === explorerTab)?.label;
  const crumb = useBreadcrumb(projectLabel, activeTabLabel);

  const onSelect = (id: string) => {
    setExplorerTab(id, activeProjectId ?? undefined);
    reportChromeFeature('tab_select');
  };
  const onToggleSidebar = () => {
    toggleSidebar();
    reportChromeFeature('sidebar_toggle');
  };

  return (
    <div
      data-testid="chrome-title-bar"
      className={`h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center gap-1 pr-3 ${
        isMac ? 'pl-[78px]' : 'pl-2'
      }${hasOverlayControls ? ' win-overlay-padding' : ''}`}
    >
      <button
        type="button"
        onClick={onToggleSidebar}
        title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!sidebarCollapsed}
        data-testid="chrome-sidebar-toggle"
        className="no-drag flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
      >
        {SidebarIcon}
      </button>

      {inProjectView && (
        <div role="tablist" aria-label="Project tabs" className="flex items-center gap-0.5 min-w-0 overflow-hidden ml-1">
          {orderedTabs.map((tab) => (
            <TitleTab
              key={tab.id}
              tab={tab}
              isActive={explorerTab === tab.id}
              projectId={activeProjectId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {/* Empty space between tabs and breadcrumb stays draggable. */}
      <div className="flex-1 min-w-[80px] self-stretch" />

      <div className="flex-shrink-0 flex items-center gap-1.5 text-xs min-w-0 max-w-[40%]" data-testid="title-bar">
        {crumb.parent && (
          <>
            <span className="text-ctp-subtext0 truncate">{crumb.parent}</span>
            <span className="text-ctp-overlay0" aria-hidden="true">/</span>
          </>
        )}
        <span className="text-ctp-text font-medium truncate">{crumb.current}</span>
      </div>
    </div>
  );
}
