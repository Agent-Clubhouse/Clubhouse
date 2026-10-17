import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { useAgentSettingsTarget } from '../features/agents/agentSettingsPages';
import { usePluginStore } from '../plugins/plugin-store';
import { Badge } from '../components/Badge';
import { useChromeStore } from './chromeStore';
import { useProjectTabs, useTabBadge, type TabEntry } from './useProjectTabs';
import { holdChromeSurface, reportChromeFeature } from './telemetry';
import { computeOverflow } from './titlebar/overflow';
import { titleBarPadding } from './titlebar/platform';
import { useClickOutside } from './sidebar/useClickOutside';
import { Tooltip } from '../components/Tooltip';

/**
 * Title bar for the new chrome (docs/chrome-redesign-spec.md §4.2): the drag
 * region, the sidebar toggle, the active project's tabs and a breadcrumb, with
 * room reserved for the platform window controls.
 *
 * Tabs that don't fit go in a More menu, ordered by recent use, and the active
 * tab always stays in the row. At least 80px between the tabs and the
 * breadcrumb stays empty and draggable (spec §4.7), and below 1100px the
 * breadcrumb drops the project name.
 */

/** Below this window width the breadcrumb shows only the current view. */
export const BREADCRUMB_SHORT_BELOW = 1100;
const TAB_GAP = 2;

const SidebarIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
);

const TitleTab = React.memo(function TitleTab({ tab, isActive, projectId, onSelect, measure }: {
  tab: TabEntry;
  isActive: boolean;
  projectId: string | null;
  onSelect: (id: string) => void;
  /** A copy in the hidden measuring row: no role, test ID or focus. */
  measure?: boolean;
}) {
  const badge = useTabBadge(tab.id, projectId);
  const disabled = tab.disabled === true;
  return (
    <Tooltip content={tab.disabledReason} disabled={measure || !disabled || !tab.disabledReason}>
    <button
      type="button"
      role={measure ? undefined : 'tab'}
      tabIndex={measure ? -1 : undefined}
      aria-selected={measure ? undefined : isActive}
      aria-disabled={disabled || undefined}
      data-testid={measure ? undefined : `explorer-tab-${tab.id}`}
      data-tab-id={measure ? tab.id : undefined}
      data-active={measure ? undefined : isActive}
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
    </Tooltip>
  );
});

function MenuTab({ tab, projectId, onSelect }: { tab: TabEntry; projectId: string | null; onSelect: (id: string) => void }) {
  const badge = useTabBadge(tab.id, projectId);
  const disabled = tab.disabled === true;
  return (
    <Tooltip content={tab.disabledReason} disabled={!disabled || !tab.disabledReason} side="left">
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      data-testid={`explorer-tab-${tab.id}`}
      onClick={disabled ? undefined : () => onSelect(tab.id)}
      className={`w-full px-3 py-1.5 flex items-center gap-2 text-left text-xs [&_svg]:w-[14px] [&_svg]:h-[14px] ${
        disabled ? 'opacity-40 cursor-not-allowed text-ctp-subtext0' : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer'
      }`}
    >
      {tab.icon}
      <span className="truncate">{tab.label}</span>
      {badge && !disabled && <span className="ml-auto"><Badge type={badge.type} value={badge.value} inline /></span>}
    </button>
    </Tooltip>
  );
}

const MoreChevron = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

function MoreMenu({ tabs, projectId, onSelect, buttonRef }: {
  tabs: TabEntry[];
  projectId: string | null;
  onSelect: (id: string) => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, open, close);

  // While the menu is open it is where the user is (spec §8).
  useEffect(() => (open ? holdChromeSurface('more_menu') : undefined), [open]);

  return (
    <div ref={ref} className="relative no-drag flex-shrink-0">
      <button
        ref={buttonRef}
        type="button"
        data-testid="title-more"
        // Overflowed tabs only have explorer-tab-<id> while the menu is open; this
        // lists them so E2E helpers know to open More first (spec §9).
        data-overflow-ids={tabs.map((t) => t.id).join(' ')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${tabs.length} more tab${tabs.length === 1 ? '' : 's'}`}
        onClick={() => { setOpen((o) => !o); if (!open) reportChromeFeature('more_menu_open'); }}
        className="h-7 px-2 rounded-md flex items-center gap-1 text-xs text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer whitespace-nowrap"
      >
        More <span className="text-ctp-overlay1">{tabs.length}</span> {MoreChevron}
      </button>
      {open && (
        <div role="menu" aria-label="More tabs" className="absolute left-0 top-8 z-dropdown min-w-[180px] py-1 rounded-lg border border-surface-1 bg-ctp-mantle shadow-xl">
          {tabs.map((tab) => (
            <MenuTab key={tab.id} tab={tab} projectId={projectId} onSelect={(id) => { setOpen(false); onSelect(id); reportChromeFeature('more_menu_pick'); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/**
 * Measures the room for tabs and each tab's width, from a hidden copy of the
 * row, and works out which fit.
 */
function useTabOverflow(tabs: TabEntry[], activeId: string, mru: readonly string[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [budget, setBudget] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [moreWidth, setMoreWidth] = useState(72);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setBudget(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setBudget(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Labels and badges change widths, so measure after every render; state only
  // changes when a width does.
  useLayoutEffect(() => {
    const row = measureRef.current;
    if (!row) return;
    const next: Record<string, number> = {};
    row.querySelectorAll<HTMLElement>('[data-tab-id]').forEach((el) => { next[el.dataset.tabId!] = el.offsetWidth; });
    setWidths((prev) => {
      const keys = Object.keys(next);
      return keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]) ? prev : next;
    });
    if (moreRef.current && moreRef.current.offsetWidth !== moreWidth && moreRef.current.offsetWidth > 0) setMoreWidth(moreRef.current.offsetWidth);
  });

  const ids = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const { shown, overflow } = useMemo(
    () => computeOverflow(ids, widths, budget, activeId, mru, moreWidth, TAB_GAP),
    [ids, widths, budget, activeId, mru, moreWidth],
  );
  return { containerRef, measureRef, moreRef, shown, overflow };
}

const NO_MRU: string[] = [];

/**
 * Breadcrumb text. Mirrors the legacy title (core label or the plugin's
 * tab/rail title, overridden by a plugin's window.setTitle()), shown as
 * "Project / Tab" in a project view (spec §6).
 */
function useBreadcrumb(projectLabel: string | undefined, tabLabel: string | undefined): { parent?: string; middle?: string; current: string } {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const activeAgentName = useAgentStore((s) => (s.activeAgentId ? s.agents[s.activeAgentId]?.name : undefined));
  const agentSettings = useAgentSettingsTarget(explorerTab);
  const newAgentOpen = useChromeStore((s) => s.newAgent !== null);
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

  if (newAgentOpen) return { current: 'New agent' };
  if (explorerTab === 'settings') return { current: 'Settings' };
  if (explorerTab === 'help') return { current: 'Help' };
  if (appPluginId) return { current: dynamicTitle || appPluginLabel || appPluginId };
  if (!projectLabel) return { current: 'Clubhouse' };
  if (agentSettings) return { parent: projectLabel, middle: agentSettings.name, current: 'Settings' };
  if (explorerTab === 'agents') return { parent: projectLabel, current: activeAgentName || 'Agents' };
  return { parent: projectLabel, current: dynamicTitle || projectPluginTitle || tabLabel || projectLabel };
}

export function ChromeTitleBar() {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const sidebarCollapsed = useChromeStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useChromeStore((s) => s.toggleSidebar);
  const { activeProjectId, activeProject, orderedTabs } = useProjectTabs();
  const mru = useChromeStore((s) => (activeProjectId ? s.tabMru[activeProjectId] : undefined) ?? NO_MRU);
  const touchTab = useChromeStore((s) => s.touchTab);
  const { containerRef, measureRef, moreRef, shown, overflow } = useTabOverflow(orderedTabs, explorerTab, mru);
  const tabsById = useMemo(() => new Map(orderedTabs.map((t) => [t.id, t])), [orderedTabs]);
  const shortBreadcrumb = useWindowWidth() < BREADCRUMB_SHORT_BELOW;

  // The New agent page names its own project, so the title bar shows no tabs (#2031).
  const newAgentOpen = useChromeStore((s) => s.newAgent !== null);
  const inProjectView = !newAgentOpen && !!activeProjectId && explorerTab !== 'settings' && explorerTab !== 'help' && !explorerTab.startsWith('plugin:app:');
  const projectLabel = activeProject ? (activeProject.displayName || activeProject.name) : undefined;
  const activeTabLabel = orderedTabs.find((t) => t.id === explorerTab)?.label;
  const crumb = useBreadcrumb(projectLabel, activeTabLabel);

  // ⌘1–9 select these tabs in order (spec §5.3), wherever the tab sits.
  const setTitleTabs = useChromeStore((s) => s.setTitleTabs);
  useEffect(() => {
    setTitleTabs(orderedTabs.map((t) => ({ id: t.id, disabled: t.disabled })));
  }, [orderedTabs, setTitleTabs]);

  // The More menu lists tabs by recent use (spec §4.2).
  useEffect(() => {
    if (inProjectView && activeProjectId) touchTab(activeProjectId, explorerTab);
  }, [inProjectView, activeProjectId, explorerTab, touchTab]);

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
      className={`h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center gap-1 pr-3 ${titleBarPadding(window.clubhouse.platform)}`}
    >
      <Tooltip content={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} shortcutAction="toggle-sidebar">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!sidebarCollapsed}
        data-testid="chrome-sidebar-toggle"
        className="no-drag flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
      >
        {SidebarIcon}
      </button>
      </Tooltip>

      {/* The tab area takes the free width; what the tabs leave stays draggable. */}
      <div ref={containerRef} className="relative flex-1 min-w-0 self-stretch flex items-center ml-1">
        {inProjectView && (
          <>
            <div role="tablist" aria-label="Project tabs" className="flex items-center gap-0.5 min-w-0">
              {shown.map((id) => {
                const tab = tabsById.get(id);
                return tab ? (
                  <TitleTab key={id} tab={tab} isActive={explorerTab === id} projectId={activeProjectId} onSelect={onSelect} />
                ) : null;
              })}
            </div>
            {overflow.length > 0 && (
              <MoreMenu
                tabs={overflow.map((id) => tabsById.get(id)).filter((t): t is TabEntry => !!t)}
                projectId={activeProjectId}
                onSelect={onSelect}
                buttonRef={moreRef}
              />
            )}
            <div ref={measureRef} aria-hidden="true" className="absolute left-0 top-0 invisible pointer-events-none flex items-center gap-0.5">
              {orderedTabs.map((tab) => (
                <TitleTab key={tab.id} tab={tab} isActive={explorerTab === tab.id} projectId={activeProjectId} onSelect={onSelect} measure />
              ))}
            </div>
          </>
        )}
      </div>

      {/* At least 80px between the tabs and the breadcrumb stays empty and draggable. */}
      <div className="flex-shrink-0 w-[80px] self-stretch" />

      <div className="flex-shrink-0 flex items-center gap-1.5 text-xs min-w-0 max-w-[40%]" data-testid="title-bar">
        {crumb.parent && !shortBreadcrumb && (
          <>
            <span className="text-ctp-subtext0 truncate">{crumb.parent}</span>
            <span className="text-ctp-overlay0" aria-hidden="true">/</span>
          </>
        )}
        {crumb.middle && (
          <>
            <span className="text-ctp-subtext0 truncate">{crumb.middle}</span>
            <span className="text-ctp-overlay0" aria-hidden="true">/</span>
          </>
        )}
        <span className="text-ctp-text font-medium truncate">{crumb.current}</span>
      </div>
    </div>
  );
}
