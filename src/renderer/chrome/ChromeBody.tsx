import { useEffect, useMemo } from 'react';
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
import { useChromeStore, syncProjectScopeWithActiveAgent } from './chromeStore';
import { useSidebarMode } from './listTabs';
import { reportChromeSurface, reportChromeActionFailed, reportChromeView } from './telemetry';

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

function NoProjectContent() {
  const pickAndAddProject = useProjectStore((s) => s.pickAndAddProject);
  // Interim first-run state; the designed version lands in Phase 2b (pages/FirstRun).
  return (
    <div className="h-full bg-ctp-base flex justify-center">
      <div className="max-w-md pt-32 px-6 flex flex-col gap-3">
        <h1 className="text-lg font-semibold text-ctp-text">Add your first project</h1>
        <p className="text-sm text-ctp-subtext0 leading-relaxed">
          A project is a folder with a git repository. Each agent you add gets its own branch and worktree inside it.
        </p>
        <div>
          <button
            type="button"
            onClick={() => { pickAndAddProject().catch((err) => reportChromeActionFailed('add_project', err)); }}
            className="mt-1 px-3.5 py-1.5 rounded-md bg-ctp-accent text-white text-sm font-medium cursor-pointer hover:opacity-90"
          >
            Choose a folder…
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectContent() {
  const mode = useSidebarMode();
  useEffect(() => {
    reportChromeSurface(mode === 'list' ? 'sidebar_list' : 'sidebar_agents');
  }, [mode]);
  // A tab's own list lives in the sidebar (spec §4.6), so the pane is just the tab's content.
  return <MainContentView />;
}

export function ChromeBody() {
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const activeHostId = useUIStore((s) => s.activeHostId);
  const sidebarWidth = useChromeStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useChromeStore((s) => s.sidebarCollapsed);
  const resizeSidebar = useChromeStore((s) => s.resizeSidebar);
  const toggleSidebar = useChromeStore((s) => s.toggleSidebar);

  const isSettings = explorerTab === 'settings';
  const isHelp = explorerTab === 'help';
  const appPluginId = explorerTab.startsWith('plugin:app:') ? explorerTab.slice('plugin:app:'.length) : null;

  const lastProjectId = useChromeStore((s) => s.lastProjectId);
  const setLastProjectId = useChromeStore((s) => s.setLastProjectId);

  useEffect(() => syncProjectScopeWithActiveAgent(), []);

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

  useEffect(() => {
    if (isSettings) reportChromeSurface('sidebar_settings');
  }, [isSettings]);

  // clubhouse.view for slow-frame and render-error signals (spec §8).
  useEffect(() => {
    reportChromeView(explorerTab);
  }, [explorerTab]);

  const content = useMemo(() => {
    // The settings navigator is in the sidebar; the pane shows the selected page.
    if (isSettings) return <MainContentView />;
    if (isHelp) return <HelpView />;
    if (appPluginId) return <AppPluginContent pluginId={appPluginId} />;
    if (!activeProjectId) {
      if (activeHostId) return <SatelliteDashboard activeHostId={activeHostId} />;
      return <NoProjectContent />;
    }
    return <ProjectContent />;
  }, [isSettings, isHelp, appPluginId, activeProjectId, activeHostId]);


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
