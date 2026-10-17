import { useEffect, useMemo } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useRemoteProjectStore } from '../stores/remoteProjectStore';
import { ResizeDivider } from '../components/ResizeDivider';
import { ProjectPanelLayout } from '../components/ProjectPanelLayout';
import { MainContentView } from '../panels/MainContentView';
import { AccessoryPanel } from '../panels/AccessoryPanel';
import { PluginContentView } from '../panels/PluginContentView';
import { AnnexDisabledView } from '../panels/AnnexDisabledView';
import { HelpView } from '../features/help/HelpView';
import { SatelliteDashboard } from '../features/annex/SatelliteDashboard';
import { ChromeSidebar } from './ChromeSidebar';
import { useChromeStore } from './chromeStore';
import { reportChromeSurface, reportChromeActionFailed, reportChromeView } from './telemetry';

/** Width of the temporary second column for `sidebar-content` tabs until Phase 2a swaps them into the sidebar. */
const LIST_COLUMN_WIDTH = 260;

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
  const explorerTab = useUIStore((s) => s.explorerTab);
  const activePluginId = explorerTab.startsWith('plugin:') ? explorerTab.slice('plugin:'.length) : null;
  const layout = usePluginStore((s) => (activePluginId ? s.plugins[activePluginId]?.manifest.contributes?.tab?.layout : undefined));
  // Tabs with their own list keep a temporary second column in Phase 1.
  const hasListColumn = !!activePluginId && (layout ?? 'sidebar-content') === 'sidebar-content';

  useEffect(() => {
    reportChromeSurface(hasListColumn ? 'sidebar_list' : 'sidebar_agents');
  }, [hasListColumn]);

  return (
    <div className="h-full min-h-0 flex flex-row">
      {hasListColumn && (
        <div style={{ width: LIST_COLUMN_WIDTH }} className="flex-shrink-0 min-h-0">
          <AccessoryPanel />
        </div>
      )}
      <div className="flex-1 min-w-0 min-h-0">
        <MainContentView />
      </div>
    </div>
  );
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

  // There is no Home in the new shell (spec §5.2). With no project selected and
  // nothing else open, select the first project so the window is never empty.
  const firstLocalProjectId = projects[0]?.id ?? null;
  useEffect(() => {
    if (!activeProjectId && !activeHostId && !isSettings && !isHelp && !appPluginId && firstLocalProjectId) {
      useProjectStore.getState().setActiveProject(firstLocalProjectId);
    }
  }, [activeProjectId, activeHostId, isSettings, isHelp, appPluginId, firstLocalProjectId]);

  useEffect(() => {
    if (isSettings) reportChromeSurface('sidebar_settings');
  }, [isSettings]);

  // clubhouse.view for slow-frame and render-error signals (spec §8).
  useEffect(() => {
    reportChromeView(explorerTab);
  }, [explorerTab]);

  const content = useMemo(() => {
    if (isSettings) return <ProjectPanelLayout />;
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
