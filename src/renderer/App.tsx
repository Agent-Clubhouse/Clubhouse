import { useEffect, useRef } from 'react';
import { ProjectRail } from './panels/ProjectRail';
import { MainPanelLayout } from './panels/MainPanelLayout';
import { AppTitleBar } from './components/AppTitleBar';
import { Dashboard } from './features/projects/Dashboard';
import { GitBanner } from './features/projects/GitBanner';
import { useProjectStore } from './stores/projectStore';
import { useAgentStore } from './stores/agentStore';
import { useUIStore } from './stores/uiStore';
import { useQuickAgentStore } from './stores/quickAgentStore';
import { usePluginStore } from './plugins/plugin-store';
import { handleProjectSwitch, getBuiltinProjectPluginIds } from './plugins/plugin-loader';
import { rendererLog } from './plugins/renderer-logger';
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
import { ToastContainer } from './components/ToastContainer';
import { useToastStore } from './stores/toastStore';

export function App() {
  // ── Minimal state for routing ────────────────────────────────────────────
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const explorerTab = useUIStore((s) => s.explorerTab);

  // projects is subscribed here only to drive the side-effects below;
  // all rendering that needs projects (title bar) lives in AppTitleBar.
  const projects = useProjectStore((s) => s.projects);

  // ── One-time initialization & event bridge ──────────────────────────────
  useEffect(() => {
    const cleanupInit = initApp();
    const cleanupBridge = initAppEventBridge();
    return () => {
      cleanupInit();
      cleanupBridge();
    };
  }, []);

  // ── Reactive effects ─────────────────────────────────────────────────────

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
        })().catch((err) => {
          rendererLog('core:plugins', 'error', 'Project switch error', {
            projectId: activeProjectId,
            meta: { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
          });
          useToastStore.getState().addToast(
            'Some plugins failed to load for this project. Try reloading the window.',
            'error',
          );
        });
      }
    }
  }, [activeProjectId, projects]);

  // ── Routing ──────────────────────────────────────────────────────────────
  const isAppPlugin = explorerTab.startsWith('plugin:app:');
  const isHelp = explorerTab === 'help';
  const isHome = activeProjectId === null && explorerTab !== 'settings' && !isAppPlugin && !isHelp;

  if (isHome) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <AppTitleBar />
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
        <ToastContainer />
      </div>
    );
  }

  if (isAppPlugin) {
    const appPluginId = explorerTab.slice('plugin:app:'.length);
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <AppTitleBar />
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
        <ToastContainer />
      </div>
    );
  }

  if (isHelp) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <AppTitleBar />
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
        <ToastContainer />
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden text-ctp-text flex flex-col">
      {/* Title bar */}
      <AppTitleBar />
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
        <MainPanelLayout />
      </div>
      <CommandPalette />
      <QuickAgentDialog />
      <WhatsNewDialog />
      <OnboardingModal />
      <ConfigChangesDialog />
      <ToastContainer />
    </div>
  );
}
