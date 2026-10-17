import { useEffect, useMemo, useRef } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { useRemoteProjectStore } from '../stores/remoteProjectStore';
import { ResizeDivider } from '../components/ResizeDivider';
import { MainContentView } from '../panels/MainContentView';
import { PluginContentView } from '../panels/PluginContentView';
import { AnnexDisabledView } from '../panels/AnnexDisabledView';
import { HelpView } from '../features/help/HelpView';
import { SatelliteDashboard } from '../features/annex/SatelliteDashboard';
import { ChromeSidebar } from './ChromeSidebar';
import { useChromeStore, syncProjectScopeWithActiveAgent, syncProjectActivityWithAgents } from './chromeStore';
import { useSidebarMode, type SidebarMode } from './listTabs';
import { useChromeScope } from './scope';
import { hostOf } from './hosts';
import { ProjectStartPage } from './pages/ProjectStartPage';
import { FirstRun } from './pages/FirstRun';
import { NewAgentPage } from './pages/NewAgentPage';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { reportChromePage, reportChromeSurface, reportChromeView, type ChromeSurface } from './telemetry';

const SURFACE_FOR_MODE: Record<SidebarMode, ChromeSurface> = {
  tree: 'sidebar_agents',
  list: 'sidebar_list',
  settings: 'sidebar_settings',
  help: 'sidebar_help',
  'agent-settings': 'sidebar_agent_settings',
};

function AppPluginContent({ pluginId }: { pluginId: string }) {
  const activeHostId = useUIStore((s) => s.activeHostId);
  const matches = useRemoteProjectStore((s) => (activeHostId ? s.pluginMatchState[activeHostId] : undefined));
  // Same Annex gating as the legacy shell: on a satellite, only annex-enabled app plugins render.
  if (activeHostId && matches !== undefined) {
    const match = matches.find((p) => p.id === pluginId);
    if (!(match?.status === 'matched' && match.annexEnabled)) {
      return <AnnexDisabledView pluginName={match?.name || pluginId} />;
    }
  }
  return <PluginContentView pluginId={pluginId} mode="app" />;
}

/**
 * The start page shows on the Agents tab while the scope is the project root:
 * its header is selected, or no agent in it is (spec §2), unless a finished
 * quick agent is open.
 */
function useShowsStartPage(projectId: string | null): boolean {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const scope = useChromeScope(projectId ?? undefined);
  const selectedCompletedId = useQuickAgentStore((s) => s.selectedCompletedId);
  return explorerTab === 'agents' && scope?.kind === 'project' && !selectedCompletedId;
}

export function ChromeBody() {
  const projects = useProjectStore((s) => s.projects);
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const activeHostId = useUIStore((s) => s.activeHostId);
  const sidebarWidth = useChromeStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useChromeStore((s) => s.sidebarCollapsed);
  const resizeSidebar = useChromeStore((s) => s.resizeSidebar);
  const toggleSidebar = useChromeStore((s) => s.toggleSidebar);
  const newAgent = useChromeStore((s) => s.newAgent);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);

  const isSettings = explorerTab === 'settings';
  const isHelp = explorerTab === 'help';
  const appPluginId = explorerTab.startsWith('plugin:app:') ? explorerTab.slice('plugin:app:'.length) : null;

  const lastProjectId = useChromeStore((s) => s.lastProjectId);
  const setLastProjectId = useChromeStore((s) => s.setLastProjectId);

  useEffect(() => syncProjectScopeWithActiveAgent(), []);

  // The New agent page covers the pane until something else is opened: another
  // tab, project, agent or host (#2031).
  const navKey = `${explorerTab}|${activeProjectId}|${activeAgentId}|${activeHostId}`;
  const openedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!newAgent) { openedAt.current = null; return; }
    if (openedAt.current === null) openedAt.current = navKey;
    else if (openedAt.current !== navKey) useChromeStore.getState().closeNewAgent();
  }, [newAgent, navKey]);
  const showNewAgent = !!newAgent && !activeHostId;
  useEffect(() => syncProjectActivityWithAgents(), []);

  // The active project decides the host: opening a local agent from the palette
  // or a notification while a satellite is shown brings the sidebar back to
  // Local, and the other way round. A host switch clears the project in the same
  // update (hosts.ts), so this never undoes one.
  useEffect(() => {
    if (!activeProjectId) return;
    const host = hostOf(activeProjectId);
    if (host !== activeHostId) useUIStore.getState().setActiveHost(host);
  }, [activeProjectId, activeHostId]);

  // Remember the most recently active local project.
  useEffect(() => {
    if (activeProjectId && projects.some((p) => p.id === activeProjectId)) setLastProjectId(activeProjectId);
  }, [activeProjectId, projects, setLastProjectId]);

  // There is no Home in the new shell (spec §5.2). With no project selected and
  // nothing else open (startup, or the legacy "Go to Home" shortcut), reopen the
  // most recently active project, falling back to the first one.
  const fallbackProjectId = (lastProjectId && projects.some((p) => p.id === lastProjectId) ? lastProjectId : projects[0]?.id) ?? null;
  useEffect(() => {
    if (!activeProjectId && !activeHostId && !isSettings && !isHelp && !appPluginId && fallbackProjectId) {
      useProjectStore.getState().setActiveProject(fallbackProjectId);
    }
  }, [activeProjectId, activeHostId, isSettings, isHelp, appPluginId, fallbackProjectId]);

  const mode = useSidebarMode();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const startPage = useShowsStartPage(activeProjectId) && !!activeProject;
  // Not before the project list loads, or first run would flash on every launch.
  const firstRun = projectsLoaded && projects.length === 0 && !activeHostId;
  const inPane = !isSettings && !isHelp && !appPluginId;
  const page = showNewAgent ? 'new_agent' : !inPane ? null : activeProjectId ? (startPage ? 'start_page' : null) : (firstRun ? 'first_run' : null);

  // clubhouse.view and clubhouse.ui.surface for slow-frame and render-error
  // signals (spec §8). The start page and first run are panes of their own.
  useEffect(() => {
    if (page) {
      reportChromePage(page);
      return;
    }
    reportChromeView(explorerTab);
    reportChromeSurface(SURFACE_FOR_MODE[mode]);
  }, [page, explorerTab, mode]);

  const content = useMemo(() => {
    if (showNewAgent && newAgent) return <NewAgentPage key={newAgent.seq} request={newAgent} />;
    // The settings navigator is in the sidebar; the pane shows the selected page.
    if (isSettings) return <MainContentView />;
    if (isHelp) return <HelpView />;
    if (appPluginId) return <AppPluginContent pluginId={appPluginId} />;
    if (!activeProjectId) {
      if (activeHostId) return <SatelliteDashboard activeHostId={activeHostId} />;
      // With projects, the fallback above selects one on the next render.
      return firstRun ? <FirstRun /> : null;
    }
    if (startPage && activeProject) return <ProjectStartPage project={activeProject} />;
    // A tab's own list lives in the sidebar (spec §4.6), so the pane is just the tab's content.
    return <MainContentView />;
  }, [showNewAgent, newAgent, isSettings, isHelp, appPluginId, activeProjectId, activeHostId, firstRun, startPage, activeProject]);


  return (
    <div className="flex-1 min-h-0 flex flex-row" data-testid="chrome-body">
      {!sidebarCollapsed && (
        <div style={{ width: sidebarWidth }} className="flex-shrink-0 min-h-0">
          <ChromeSidebar />
        </div>
      )}
      <ResizeDivider
        onResize={resizeSidebar}
        onToggleCollapse={toggleSidebar}
        collapsed={sidebarCollapsed}
        collapseDirection="left"
      />
      <div className="flex-1 min-w-0 min-h-0 bg-ctp-base">
        {content}
      </div>
    </div>
  );
}
