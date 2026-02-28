import { useEffect, useRef } from 'react';
import { ProjectRail } from './panels/ProjectRail';
import { ExplorerRail } from './panels/ExplorerRail';
import { AccessoryPanel } from './panels/AccessoryPanel';
import { MainContentView } from './panels/MainContentView';
import { ResizeDivider } from './components/ResizeDivider';
import { usePanelStore } from './stores/panelStore';
import { Dashboard } from './features/projects/Dashboard';
import { GitBanner } from './features/projects/GitBanner';
import { useProjectStore } from './stores/projectStore';
import { useAgentStore } from './stores/agentStore';
import { useUIStore } from './stores/uiStore';
import { useQuickAgentStore } from './stores/quickAgentStore';
import { usePluginStore } from './plugins/plugin-store';
import { handleProjectSwitch, getBuiltinProjectPluginIds } from './plugins/plugin-loader';
import { PluginContentView } from './panels/PluginContentView';
import { HelpView } from './features/help/HelpView';
import { PermissionViolationBanner } from './features/plugins/PermissionViolationBanner';
import { UpdateBanner } from './features/app/UpdateBanner';
import { WhatsNewDialog } from './features/app/WhatsNewDialog';
import { OnboardingModal } from './features/onboarding/OnboardingModal';
import { CommandPalette } from './features/command-palette/CommandPalette';
import { QuickAgentDialog } from './features/agents/QuickAgentDialog';
import { PluginUpdateBanner } from './features/plugins/PluginUpdateBanner';
import { ConfigChangesDialog } from './features/agents/ConfigChangesDialog';
import { initApp } from './app-initializer';
import { initAppEventBridge } from './app-event-bridge';

export function App() {
  // ── Layout state (only selectors needed for rendering) ──────────────────
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const activePluginId = explorerTab.startsWith('plugin:') ? explorerTab.slice('plugin:'.length) : null;
  const activePluginEntry = usePluginStore((s) => activePluginId ? s.plugins[activePluginId] : undefined);
  const isFullWidth = activePluginEntry?.manifest.contributes?.tab?.layout === 'full';

  const explorerWidth = usePanelStore((s) => s.explorerWidth);
  const explorerCollapsed = usePanelStore((s) => s.explorerCollapsed);
  const accessoryWidth = usePanelStore((s) => s.accessoryWidth);
  const accessoryCollapsed = usePanelStore((s) => s.accessoryCollapsed);
  const resizeExplorer = usePanelStore((s) => s.resizeExplorer);
  const resizeAccessory = usePanelStore((s) => s.resizeAccessory);
  const toggleExplorerCollapse = usePanelStore((s) => s.toggleExplorerCollapse);
  const toggleAccessoryCollapse = usePanelStore((s) => s.toggleAccessoryCollapse);

  // ── One-time initialization & event bridge ──────────────────────────────
  useEffect(() => {
    const cleanupInit = initApp();
    const cleanupBridge = initAppEventBridge();
    return () => {
      cleanupInit();
      cleanupBridge();
    };
  }, []);

  // ── Reactive effects (depend on state already subscribed for rendering) ─

  // Load durable agents for all projects so the dashboard shows them
  useEffect(() => {
    const loadDurableAgents = useAgentStore.getState().loadDurableAgents;
    for (const p of projects) {
      loadDurableAgents(p.id, p.path);
    }
  }, [projects]);

  // Load completed quick agents for all projects
  useEffect(() => {
    const loadCompleted = useQuickAgentStore.getState().loadCompleted;
    for (const p of projects) {
      loadCompleted(p.id);
    }
  }, [projects]);

  // Handle plugin lifecycle on project switches
  const prevProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = prevProjectIdRef.current;
    prevProjectIdRef.current = activeProjectId;
    if (activeProjectId && activeProjectId !== prevId) {
      // Restore per-project navigation state, but skip if the user
      // intentionally navigated to settings (e.g. gear icon on Home dashboard)
      const currentTab = useUIStore.getState().explorerTab;
      if (currentTab !== 'settings' && currentTab !== 'help') {
        useUIStore.getState().restoreProjectView(activeProjectId);
      }
      useAgentStore.getState().restoreProjectAgent(activeProjectId);

      const project = projects.find((p) => p.id === activeProjectId);
      if (project) {
        // Load project plugin config then activate
        (async () => {
          try {
            const saved = await window.clubhouse.plugin.storageRead({
              pluginId: '_system',
              scope: 'global',
              key: `project-enabled-${activeProjectId}`,
            }) as string[] | undefined;
            // Merge built-in project-scoped plugins so they're always enabled
            const builtinIds = getBuiltinProjectPluginIds();
            const base = Array.isArray(saved) ? saved : [];
            const merged = [...new Set([...base, ...builtinIds])];
            usePluginStore.getState().loadProjectPluginConfig(activeProjectId, merged);
          } catch { /* no saved config */ }
          await handleProjectSwitch(prevId, activeProjectId, project.path);
        })().catch((err) => console.error('[Plugins] Project switch error:', err));
      }
    }
  }, [activeProjectId, projects]);

  // ── Derived layout state ────────────────────────────────────────────────
  const isAppPlugin = explorerTab.startsWith('plugin:app:');
  const isHelp = explorerTab === 'help';
  const isHome = activeProjectId === null && explorerTab !== 'settings' && !isAppPlugin && !isHelp;
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const CORE_LABELS: Record<string, string> = {
    agents: 'Agents',
    settings: 'Settings',
    help: 'Help',
  };
  const tabLabel = (() => {
    if (!activePluginEntry) return CORE_LABELS[explorerTab] || explorerTab;
    if (explorerTab.startsWith('plugin:app:')) {
      return activePluginEntry.manifest.contributes?.railItem?.label || activePluginEntry.manifest.name || activePluginId;
    }
    return activePluginEntry.manifest.contributes?.tab?.label || activePluginEntry.manifest.name || activePluginId;
  })();

  const titleText = isHome
    ? 'Home'
    : activeProject
      ? `${tabLabel} (${activeProject.displayName || activeProject.name})`
      : tabLabel;

  const isWin = window.clubhouse.platform === 'win32';
  const titleBarClass = `h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center${isWin ? ' win-overlay-padding' : ''}`;

  if (isHome) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <div className={titleBarClass}>
          <span className="text-xs text-ctp-subtext0 select-none" data-testid="title-bar">{titleText}</span>
        </div>
        <PermissionViolationBanner />
        <UpdateBanner />
        <PluginUpdateBanner />
        <div className="flex-1 min-h-0 grid grid-rows-[1fr]" style={{ gridTemplateColumns: 'var(--rail-width, 68px) 1fr' }}>
          <ProjectRail />
          <Dashboard />
        </div>
        <CommandPalette />
        <QuickAgentDialog />
        <WhatsNewDialog />
        <OnboardingModal />
        <ConfigChangesDialog />
      </div>
    );
  }

  if (isAppPlugin) {
    const appPluginId = explorerTab.slice('plugin:app:'.length);
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <div className={titleBarClass}>
          <span className="text-xs text-ctp-subtext0 select-none" data-testid="title-bar">{titleText}</span>
        </div>
        <PermissionViolationBanner />
        <UpdateBanner />
        <PluginUpdateBanner />
        <div className="flex-1 min-h-0 grid grid-rows-[1fr]" style={{ gridTemplateColumns: 'var(--rail-width, 68px) 1fr' }}>
          <ProjectRail />
          <PluginContentView pluginId={appPluginId} mode="app" />
        </div>
        <CommandPalette />
        <QuickAgentDialog />
        <WhatsNewDialog />
        <OnboardingModal />
        <ConfigChangesDialog />
      </div>
    );
  }

  if (isHelp) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <div className={titleBarClass}>
          <span className="text-xs text-ctp-subtext0 select-none" data-testid="title-bar">{titleText}</span>
        </div>
        <PermissionViolationBanner />
        <UpdateBanner />
        <PluginUpdateBanner />
        <div className="flex-1 min-h-0 grid grid-rows-[1fr]" style={{ gridTemplateColumns: 'var(--rail-width, 68px) 1fr' }}>
          <ProjectRail />
          <HelpView />
        </div>
        <CommandPalette />
        <QuickAgentDialog />
        <WhatsNewDialog />
        <OnboardingModal />
        <ConfigChangesDialog />
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
      {/* Title bar */}
      <div className={titleBarClass}>
        <span className="text-xs text-ctp-subtext0 select-none" data-testid="title-bar">{titleText}</span>
      </div>
      {/* Permission violation banner */}
      <PermissionViolationBanner />
      {/* Update banner */}
      <UpdateBanner />
      {/* Plugin update banner */}
      <PluginUpdateBanner />
      {/* Git banner */}
      <GitBanner />
      {/* Main content grid */}
      <div className="flex-1 min-h-0 grid grid-rows-[1fr]" style={{ gridTemplateColumns: 'var(--rail-width, 68px) 1fr' }}>
        <ProjectRail />
        <div className="flex flex-row min-h-0 min-w-0">
          {!explorerCollapsed && (
            <div style={{ width: explorerWidth }} className="flex-shrink-0 min-h-0">
              <ExplorerRail />
            </div>
          )}
          <ResizeDivider
            onResize={resizeExplorer}
            onToggleCollapse={toggleExplorerCollapse}
            collapsed={explorerCollapsed}
            collapseDirection="left"
          />
          {!isFullWidth && !accessoryCollapsed && (
            <div style={{ width: accessoryWidth }} className="flex-shrink-0 min-h-0">
              <AccessoryPanel />
            </div>
          )}
          {!isFullWidth && (
            <ResizeDivider
              onResize={resizeAccessory}
              onToggleCollapse={toggleAccessoryCollapse}
              collapsed={accessoryCollapsed}
              collapseDirection="left"
            />
          )}
          <div className="flex-1 min-w-0 min-h-0">
            <MainContentView />
          </div>
        </div>
      </div>
      <CommandPalette />
      <QuickAgentDialog />
      <WhatsNewDialog />
      <OnboardingModal />
      <ConfigChangesDialog />
    </div>
  );
}
