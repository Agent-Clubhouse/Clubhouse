import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useAnnexClientStore, type SatelliteConnection } from '../stores/annexClientStore';
import { useRemoteProjectStore, satellitePrefix } from '../stores/remoteProjectStore';
import { useCommandPaletteStore } from '../stores/commandPaletteStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useOrderedShallow } from '../hooks/useOrderedShallow';
import type { PluginRegistryEntry } from '../../shared/plugin-types';
import type { Agent } from '../../shared/types';
import { sanitizeSvg } from '../utils/sanitize-svg';
import { ProjectTree } from './sidebar/ProjectTree';
import { NeedsYou, NeedsYouStrip } from './sidebar/NeedsYou';
import { ListBody } from './sidebar/ListBody';
import { SettingsNav } from './sidebar/SettingsNav';
import { SidebarBreadcrumb } from './sidebar/SidebarBreadcrumb';
import { useSidebarMode } from './listTabs';
import { SCOPE_FOLLOWING_TABS } from './scope';
import { ChromeAgentDialogs, useChromeDialogStore } from './sidebar/ChromeAgentDialogs';
import { selectNeedsAttention, selectRemoteNeedsAttention, mergeNeedsAttention } from './sidebar/treeModel';
import { HostSwitcher, LOCAL_HOST } from './sidebar/HostSwitcher';
import { useClickOutside } from './sidebar/useClickOutside';
import { hostOf, switchHost } from './hosts';
import { useChromeStore } from './chromeStore';
import { reportChromeFeature, reportChromeActionFailed } from './telemetry';

/**
 * Sidebar for the new chrome (docs/chrome-redesign-spec.md §2, §4.2): the host
 * switcher, Canvas and Review, search and New, “Needs you” across hosts, the
 * active host's project tree (or a tab's list, or Settings), and a footer.
 *
 * Legacy test IDs are kept where the element means the same thing (§9):
 * `project-<id>`, `agent-item-<id>`, `agent-list`, `nav-add-project`,
 * `nav-help`, `nav-settings`.
 */

const PLUGIN_FALLBACK_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

/** App-level items that get the inline buttons; every other top rail item goes in the overflow menu. */
const INLINE_APP_ITEMS = ['canvas', 'review'];

const NO_COMPLETED: Record<string, never[]> = {};

const railIcon = (entry: PluginRegistryEntry) => {
  const icon = entry.manifest.contributes!.railItem!.icon;
  return icon ? <span className="flex items-center" dangerouslySetInnerHTML={{ __html: sanitizeSvg(icon) }} /> : PLUGIN_FALLBACK_ICON;
};


function MenuButton({ label, testId, children, items, disabled }: {
  label: string;
  testId: string;
  children: React.ReactNode;
  items: Array<{ label: string; onSelect: () => void }>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, open, close);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="h-7 px-2.5 rounded-md flex items-center gap-1.5 text-xs font-medium text-ctp-accent bg-ctp-accent/15 hover:bg-ctp-accent/25 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        title={label}
      >
        {children}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-8 z-dropdown min-w-[180px] py-1 rounded-lg border border-surface-1 bg-ctp-mantle shadow-xl">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); item.onSelect(); }}
              className="w-full px-3 py-1.5 text-left text-xs text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AppRow({ inline, overflow, explorerTab, onOpen }: {
  inline: PluginRegistryEntry[];
  overflow: PluginRegistryEntry[];
  explorerTab: string;
  onOpen: (id: string) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setMoreOpen(false), []);
  useClickOutside(moreRef, moreOpen, close);
  if (inline.length === 0 && overflow.length === 0) return null;
  return (
    <nav aria-label="App views" className="flex-shrink-0 px-2 pb-2 flex items-center gap-1.5">
      {inline.map((entry) => {
        const rail = entry.manifest.contributes!.railItem!;
        const active = explorerTab === `plugin:app:${entry.manifest.id}`;
        return (
          <button
            key={entry.manifest.id}
            type="button"
            title={rail.title || rail.label}
            data-testid={`app-row-${entry.manifest.id}`}
            data-active={active}
            onClick={() => onOpen(entry.manifest.id)}
            className={`flex-1 min-w-0 h-[30px] px-2 rounded-md border flex items-center gap-1.5 text-[13px] font-medium cursor-pointer [&_svg]:w-[15px] [&_svg]:h-[15px] ${
              active ? 'border-surface-2 bg-surface-0 text-ctp-text' : 'border-surface-0 text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text'
            }`}
          >
            {railIcon(entry)}
            <span className="truncate">{rail.label}</span>
          </button>
        );
      })}
      {overflow.length > 0 && (
        <div ref={moreRef} className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            title="More app views"
            aria-label="More app views"
            onClick={() => setMoreOpen((o) => !o)}
            className="h-[30px] w-[30px] rounded-md border border-surface-0 flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0/60 hover:text-ctp-text cursor-pointer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
          </button>
          {moreOpen && (
            <div role="menu" className="absolute right-0 top-9 z-dropdown min-w-[180px] py-1 rounded-lg border border-surface-1 bg-ctp-mantle shadow-xl">
              {overflow.map((entry) => (
                <button
                  key={entry.manifest.id}
                  type="button"
                  role="menuitem"
                  onClick={() => { setMoreOpen(false); onOpen(entry.manifest.id); }}
                  className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-xs text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer [&_svg]:w-[14px] [&_svg]:h-[14px]"
                >
                  {railIcon(entry)}
                  {entry.manifest.contributes!.railItem!.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}

export function ChromeSidebar() {
  const projects = useProjectStore((s) => s.projects);
  const projectIcons = useProjectStore((s) => s.projectIcons);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const pickAndAddProject = useProjectStore((s) => s.pickAndAddProject);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const toggleHelp = useUIStore((s) => s.toggleHelp);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const agents = useAgentStore(useOrderedShallow((s) => s.agents));
  const detailed = useAgentStore((s) => s.agentDetailedStatus);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const completedByProject = useQuickAgentStore((s) => s.completedAgents);
  const selectedCompletedId = useQuickAgentStore((s) => s.selectedCompletedId);
  const plugins = usePluginStore((s) => s.plugins);
  const appEnabled = usePluginStore((s) => s.appEnabled);
  const setProjectCollapsed = useChromeStore((s) => s.setProjectCollapsed);
  const setProjectScope = useChromeStore((s) => s.setProjectScope);
  const projectScopeId = useChromeStore((s) => s.projectScopeId);
  const mode = useSidebarMode();
  const listLabel = usePluginStore((s) => {
    if (!explorerTab.startsWith('plugin:')) return undefined;
    const tab = s.plugins[explorerTab.slice('plugin:'.length)]?.manifest.contributes?.tab;
    return tab?.label;
  });
  const forgetProjects = useChromeStore((s) => s.forgetProjects);
  const activeHostId = useUIStore((s) => s.activeHostId);
  const satellites = useAnnexClientStore((s) => s.satellites);
  const satelliteProjects = useRemoteProjectStore((s) => s.satelliteProjects);
  const remoteAgents = useRemoteProjectStore((s) => s.remoteAgents);
  const remoteDetailed = useRemoteProjectStore((s) => s.remoteAgentDetailedStatus);
  const remoteProjectIcons = useRemoteProjectStore((s) => s.remoteProjectIcons);
  const isRemoteHost = activeHostId !== null;

  // A satellite that was unpaired can't stay the host (as in the legacy rail).
  useEffect(() => {
    if (activeHostId && satellites.length > 0 && !satellites.some((s) => s.id === activeHostId)) switchHost(null);
  }, [activeHostId, satellites]);

  // An unpaired satellite's pins, collapsed state and folds go with it. Only on
  // unpairing: a satellite that goes offline keeps them for when it is back.
  const prevSatelliteIdsRef = useRef<string[] | null>(null);
  useEffect(() => {
    const ids = satellites.map((s) => s.id);
    const prev = prevSatelliteIdsRef.current;
    if (prev) {
      const current = new Set(ids);
      for (const id of prev) if (!current.has(id)) useChromeStore.getState().forgetProjectsWithPrefix(satellitePrefix(id));
    }
    if (ids.length > 0 || prev) prevSatelliteIdsRef.current = ids;
  }, [satellites]);

  // When a project is removed, drop its pin, collapsed state and folds. Compared
  // against the previous non-empty list so the empty list at startup prunes nothing.
  const prevProjectIdsRef = useRef<string[] | null>(null);
  useEffect(() => {
    const ids = projects.map((p) => p.id);
    const prev = prevProjectIdsRef.current;
    if (ids.length > 0 || prev) {
      if (prev) {
        const current = new Set(ids);
        const removed = prev.filter((id) => !current.has(id));
        if (removed.length > 0) forgetProjects(removed);
      }
      prevProjectIdsRef.current = ids;
    }
  }, [projects, forgetProjects]);

  // App-level plugin items, same visibility rule as the legacy rail.
  const { inlineItems, overflowItems, bottomItems } = useMemo(() => {
    const items = appEnabled
      .map((id) => plugins[id])
      .filter((entry): entry is PluginRegistryEntry => {
        if (!entry) return false;
        if (entry.manifest.scope !== 'app' && entry.manifest.scope !== 'dual') return false;
        if (entry.status === 'incompatible') return false;
        return !!entry.manifest.contributes?.railItem;
      });
    const top = items.filter((e) => (e.manifest.contributes!.railItem!.position ?? 'top') === 'top');
    return {
      inlineItems: INLINE_APP_ITEMS.map((id) => top.find((e) => e.manifest.id === id)).filter((e): e is PluginRegistryEntry => !!e),
      overflowItems: top.filter((e) => !INLINE_APP_ITEMS.includes(e.manifest.id)),
      bottomItems: items.filter((e) => e.manifest.contributes!.railItem!.position === 'bottom'),
    };
  }, [appEnabled, plugins]);

  // The tree shows the active host: local projects, or a satellite's (spec §2, hosts option 1).
  const treeProjects = useMemo(
    () => (activeHostId ? satelliteProjects[activeHostId] ?? [] : projects),
    [activeHostId, satelliteProjects, projects],
  );
  const treeAgents = isRemoteHost ? remoteAgents : agents;
  const treeDetailed = isRemoteHost ? remoteDetailed : detailed;
  const localProjectIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);
  const agentsByProject = useMemo(() => {
    const ids = new Set(treeProjects.map((p) => p.id));
    const map: Record<string, Agent[]> = {};
    for (const agent of Object.values(treeAgents)) {
      if (!ids.has(agent.projectId) || agent.kind === 'companion') continue;
      (map[agent.projectId] ??= []).push(agent);
    }
    return map;
  }, [treeAgents, treeProjects]);

  // Needs you covers every host, so a blocked agent anywhere is one click away.
  const needs = useMemo(() => mergeNeedsAttention(
    selectNeedsAttention(agents, detailed, localProjectIds),
    selectRemoteNeedsAttention(satellites, satelliteProjects, remoteAgents, remoteDetailed),
  ), [agents, detailed, localProjectIds, satellites, satelliteProjects, remoteAgents, remoteDetailed]);
  const needsByHost = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of needs) counts[item.hostId ?? LOCAL_HOST] = (counts[item.hostId ?? LOCAL_HOST] ?? 0) + 1;
    return counts;
  }, [needs]);
  const projectNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const p of projects) names[p.id] = p.displayName || p.name;
    for (const list of Object.values(satelliteProjects)) for (const p of list) names[p.id] = p.displayName || p.name;
    return names;
  }, [projects, satelliteProjects]);
  const reviewEnabled = inlineItems.some((e) => e.manifest.id === 'review');

  const openAppItem = useCallback((id: string) => {
    setExplorerTab(`plugin:app:${id}`);
    reportChromeFeature('app_item_open');
  }, [setExplorerTab]);

  const isProjectTab = explorerTab !== 'settings' && explorerTab !== 'help' && !explorerTab.startsWith('plugin:app:');

  // Selecting a project header makes the project root the scope (spec §4.5).
  // The project's remembered agent is cleared too, so the project-switch effect
  // (App.tsx restoreProjectAgent) doesn't reselect it and end the project scope.
  const selectProject = useCallback((projectId: string) => {
    setActiveProject(projectId);
    setActiveAgent(null, projectId);
    setProjectScope(projectId);
    setProjectCollapsed(projectId, false);
    if (!isProjectTab) useUIStore.getState().restoreProjectView(projectId);
    reportChromeFeature('project_select');
  }, [setActiveProject, setActiveAgent, setProjectScope, setProjectCollapsed, isProjectTab]);

  // Selecting an agent makes its worktree the scope. On a tab that follows the
  // scope (Terminal, Files, Git) the tab stays; otherwise the agent opens.
  // An agent on another host switches the host first (a remote Needs you row).
  const openAgent = useCallback((agent: Agent, keepTab: boolean) => {
    useQuickAgentStore.getState().selectCompleted(null);
    switchHost(hostOf(agent.projectId));
    setProjectScope(null);
    const sameProject = useProjectStore.getState().activeProjectId === agent.projectId;
    if (!sameProject) setActiveProject(agent.projectId);
    // Recording the tab for the project keeps the project-switch effect from restoring another one.
    const tab = keepTab && sameProject && SCOPE_FOLLOWING_TABS.has(explorerTab) ? explorerTab : 'agents';
    setExplorerTab(tab, agent.projectId);
    setActiveAgent(agent.id, agent.projectId);
  }, [setActiveProject, setProjectScope, setExplorerTab, setActiveAgent, explorerTab]);

  const selectAgent = useCallback((agent: Agent) => {
    openAgent(agent, true);
    reportChromeFeature('agent_select');
  }, [openAgent]);

  const projectEnabled = usePluginStore((s) => s.projectEnabled);
  const terminalProjectIds = useMemo(
    () => new Set(Object.entries(projectEnabled).filter(([, ids]) => ids.includes('terminal')).map(([id]) => id)),
    [projectEnabled],
  );
  // The hover card's Open terminal: the agent, on the Terminal tab (its scope).
  const openTerminal = useCallback((agent: Agent) => {
    openAgent(agent, false);
    useUIStore.getState().setExplorerTab('plugin:terminal', agent.projectId);
  }, [openAgent]);

  const selectNeedsYou = useCallback((agent: Agent) => {
    // needs_you_remote_select: the agent runs on a satellite, whichever host is shown.
    const remote = hostOf(agent.projectId) !== null;
    openAgent(agent, false);
    reportChromeFeature(remote ? 'needs_you_remote_select' : 'needs_you_select');
  }, [openAgent]);

  const onSwitchHost = useCallback((hostId: string | null) => {
    switchHost(hostId);
    reportChromeFeature('host_switch');
  }, []);
  const onRetryHost = useCallback((sat: SatelliteConnection) => {
    void useAnnexClientStore.getState().retry(sat.fingerprint);
    reportChromeFeature('host_retry');
  }, []);
  const openAnnexSettings = useCallback((page: 'annex' | 'annex-control') => {
    const ui = useUIStore.getState();
    ui.setSettingsContext('app');
    ui.setSettingsSubPage(page);
    if (ui.explorerTab !== 'settings') ui.toggleSettings();
    reportChromeFeature('host_settings_open');
  }, []);

  const selectCompleted = useCallback((projectId: string, completedId: string) => {
    setProjectScope(null);
    if (useProjectStore.getState().activeProjectId !== projectId) setActiveProject(projectId);
    setExplorerTab('agents', projectId);
    setActiveAgent(null, projectId);
    useQuickAgentStore.getState().selectCompleted(completedId);
  }, [setProjectScope, setActiveProject, setExplorerTab, setActiveAgent]);

  const dismissCompleted = useCallback((projectId: string, completedId: string) => {
    useQuickAgentStore.getState().dismissCompleted(projectId, completedId);
    reportChromeFeature('completed_dismiss');
  }, []);
  const clearCompleted = useCallback((projectId: string) => {
    useQuickAgentStore.getState().clearCompleted(projectId);
    reportChromeFeature('completed_clear');
  }, []);

  const onReorder = useCallback((ids: string[]) => {
    reorderProjects(ids).catch((err) => reportChromeActionFailed('reorder_projects', err));
    reportChromeFeature('project_reorder');
  }, [reorderProjects]);

  const onNewAgent = useCallback((projectId: string) => {
    useChromeDialogStore.getState().openNewAgent(projectId);
    reportChromeFeature('new_agent_open');
  }, []);

  const addProject = () => {
    pickAndAddProject().catch((err) => reportChromeActionFailed('add_project', err));
  };

  const newItems = activeProjectId ? [
    { label: 'Durable agent…', onSelect: () => useChromeDialogStore.getState().openNewAgent(activeProjectId) },
    { label: 'Agent from a template…', onSelect: () => useChromeDialogStore.getState().openGallery(activeProjectId) },
    { label: 'Quick agent…', onSelect: () => useUIStore.getState().openQuickAgentDialog() },
  ] : [];

  // The breadcrumb, or Esc inside the sidebar, returns from a list or Settings to Agents (spec §4.6).
  const backToAgents = () => (mode === 'settings' ? useUIStore.getState().toggleSettings() : setExplorerTab('agents', activeProjectId ?? undefined));
  const onSidebarKeyDown = (e: React.KeyboardEvent) => {
    if (mode === 'tree' || e.key !== 'Escape' || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    // Esc in a field belongs to the field (clearing a search, closing a picker).
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [aria-expanded="true"]')) return;
    e.preventDefault();
    backToAgents();
  };

  return (
    <aside
      data-testid="chrome-sidebar"
      onKeyDown={onSidebarKeyDown}
      aria-label="Sidebar"
      className="h-full min-h-0 flex flex-col bg-ctp-mantle border-r border-surface-0 overflow-hidden"
    >
      <div className="flex-shrink-0 pt-2" />
      <HostSwitcher
        satellites={satellites}
        activeHostId={activeHostId}
        needsByHost={needsByHost}
        onSwitch={onSwitchHost}
        onRetry={onRetryHost}
        onPair={() => openAnnexSettings('annex-control')}
        onAnnexSettings={() => openAnnexSettings('annex')}
      />
      <div className="flex-shrink-0 px-2 pb-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => { useCommandPaletteStore.getState().open(); reportChromeFeature('search_open'); }}
          data-testid="chrome-search"
          className="flex-1 min-w-0 h-7 px-2 rounded-md bg-surface-0 flex items-center gap-2 text-xs text-ctp-overlay1 hover:text-ctp-subtext1 cursor-pointer"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
          <span>Search</span>
          <kbd className="ml-auto text-xs text-ctp-overlay1">{window.clubhouse.platform === 'darwin' ? '⌘K' : 'Ctrl+K'}</kbd>
        </button>
        <MenuButton label="New agent" testId="chrome-new" items={newItems} disabled={!activeProjectId || isRemoteHost}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          New
        </MenuButton>
      </div>

      <AppRow inline={inlineItems} overflow={overflowItems} explorerTab={explorerTab} onOpen={openAppItem} />

      {mode !== 'tree' && (
        <>
          <SidebarBreadcrumb current={mode === 'settings' ? 'Settings' : listLabel ?? 'List'} onBack={backToAgents} />
          <NeedsYouStrip items={needs} onSelect={selectNeedsYou} onReview={reviewEnabled ? () => openAppItem('review') : undefined} />
          {mode === 'settings' ? <SettingsNav /> : <ListBody explorerTab={explorerTab} projectId={activeProjectId} />}
        </>
      )}

      {mode === 'tree' && (
        <NeedsYou
          items={needs}
          projectNames={projectNames}
          activeAgentId={activeAgentId}
          onSelect={selectNeedsYou}
          onReview={reviewEnabled ? () => openAppItem('review') : undefined}
        />
      )}

      <div className={`flex-1 min-h-0 flex-col ${mode === 'tree' ? 'flex' : 'hidden'}`}>
        <ProjectTree
          projectScopeId={projectScopeId}
          projects={treeProjects}
          projectIcons={isRemoteHost ? remoteProjectIcons : projectIcons}
          agentsByProject={agentsByProject}
          detailed={treeDetailed}
          completedByProject={isRemoteHost ? NO_COMPLETED : completedByProject}
          activeProjectId={isProjectTab ? activeProjectId : null}
          activeAgentId={isProjectTab ? activeAgentId : null}
          selectedCompletedId={selectedCompletedId}
          onReorder={isRemoteHost ? undefined : onReorder}
          onSelectProject={selectProject}
          onNewAgent={isRemoteHost ? undefined : onNewAgent}
          onSelectAgent={selectAgent}
          onOpenTerminal={isRemoteHost ? undefined : openTerminal}
          terminalProjectIds={terminalProjectIds}
          onSelectCompleted={selectCompleted}
          onDismissCompleted={dismissCompleted}
          onClearCompleted={clearCompleted}
        />
      </div>

      <div className="flex-shrink-0 h-10 border-t border-surface-0 flex items-center gap-1 px-2">
        <button
          type="button"
          onClick={addProject}
          title="Add project"
          data-testid="nav-add-project"
          className="h-7 px-2 rounded-md flex items-center gap-1.5 text-xs text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          Add project
        </button>
        <span className="flex-1" />
        {bottomItems.map((entry) => {
          const rail = entry.manifest.contributes!.railItem!;
          return (
            <button
              key={entry.manifest.id}
              type="button"
              title={rail.title || rail.label}
              aria-label={rail.label}
              onClick={() => openAppItem(entry.manifest.id)}
              className="w-7 h-7 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer [&_svg]:w-[15px] [&_svg]:h-[15px]"
            >
              {railIcon(entry)}
            </button>
          );
        })}
        <button
          type="button"
          onClick={toggleHelp}
          title="Help"
          aria-label="Help"
          data-testid="nav-help"
          data-active={explorerTab === 'help'}
          className="w-7 h-7 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" />
          </svg>
        </button>
        <button
          type="button"
          onClick={toggleSettings}
          title="Settings"
          aria-label="Settings"
          data-testid="nav-settings"
          data-active={explorerTab === 'settings'}
          className="w-7 h-7 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      <ChromeAgentDialogs />
    </aside>
  );
}
