import { useCallback, useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { RailSection } from './components/RailSection';
import { ProjectPanelLayout } from './components/ProjectPanelLayout';
import { Dashboard } from './features/projects/Dashboard';
import { GitBanner } from './features/projects/GitBanner';
import { useProjectStore } from './stores/projectStore';
import { useAgentStore } from './stores/agentStore';
import { useUIStore } from './stores/uiStore';
import { useQuickAgentStore } from './stores/quickAgentStore';
import { usePluginStore } from './plugins/plugin-store';
import { handleProjectSwitch, getBuiltinProjectPluginIds, pluginSystemReady } from './plugins/plugin-loader';
import { rendererLog } from './plugins/renderer-logger';
import { PluginContentView } from './panels/PluginContentView';
import { HelpView } from './features/help/HelpView';
import { AssistantView } from './features/assistant/AssistantView';
import { PermissionViolationBanner } from './features/plugins/PermissionViolationBanner';
import { UpdateBanner } from './features/app/UpdateBanner';
import { ResumeBanner, ResumeBannerSession } from './features/app/ResumeBanner';
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
import { SatelliteLockOverlay } from './features/annex/SatelliteLockOverlay';
import { SatelliteDashboard } from './features/annex/SatelliteDashboard';
import { useLockStore } from './stores/lockStore';
import { useRemoteProjectStore, isRemoteProjectId, parseNamespacedId } from './stores/remoteProjectStore';
import { AnnexDisabledView } from './panels/AnnexDisabledView';

export function App() {
  // ── Routing state (minimal selectors for view switching) ────────────────
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const activeHostId = useUIStore((s) => s.activeHostId);
  const pluginMatchState = useRemoteProjectStore((s) => s.pluginMatchState);

  // ── Resume banner state ──────────────────────────────────────────────────
  const resumingAgents = useAgentStore((s) => s.resumingAgents);
  const agents = useAgentStore((s) => s.agents);
  const resumeSessions: ResumeBannerSession[] = Object.entries(resumingAgents).map(([agentId, status]) => ({
    agentId,
    agentName: agents[agentId]?.name || agentId,
    status,
  }));

  // ── Annex lock state (individual selectors to avoid reference-inequality re-render loops) ──
  const lockLocked = useLockStore((s) => s.locked);
  const lockPaused = useLockStore((s) => s.paused);
  const lockControllerAlias = useLockStore((s) => s.controllerAlias);
  const lockControllerIcon = useLockStore((s) => s.controllerIcon);
  const lockControllerColor = useLockStore((s) => s.controllerColor);
  const lockControllerFingerprint = useLockStore((s) => s.controllerFingerprint);
  const lockTogglePause = useLockStore((s) => s.togglePause);
  const lockUnlock = useLockStore((s) => s.unlock);

  // ── Banner area height measurement (for positioning the pause floatie) ──
  const bannerObserverRef = useRef<ResizeObserver | null>(null);
  const [bannerHeight, setBannerHeight] = useState(0);
  const bannerRef = useCallback((node: HTMLDivElement | null) => {
    if (bannerObserverRef.current) {
      bannerObserverRef.current.disconnect();
      bannerObserverRef.current = null;
    }
    if (!node) {
      setBannerHeight(0);
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      setBannerHeight(entry.contentRect.height);
    });
    observer.observe(node);
    bannerObserverRef.current = observer;
  }, []);

  // ── One-time initialization & event bridge ──────────────────────────────
  useEffect(() => {
    let cleanupInit: (() => void) | undefined;
    let cancelled = false;
    initApp().then((cleanup) => {
      if (cancelled) {
        cleanup();
      } else {
        cleanupInit = cleanup;
      }
    });
    const cleanupBridge = initAppEventBridge();
    return () => {
      cancelled = true;
      cleanupInit?.();
      cleanupBridge();
    };
  }, []);

  // Annex is now a stable feature — no need to clear stale activeHostId based on experimental flag

  // ── Reactive effects (depend on state already subscribed for routing) ───

  // Load durable agents for all projects so the dashboard shows them
  useEffect(() => {
    const loadDurableAgents = useAgentStore.getState().loadDurableAgents;
    for (const p of projects) {
      loadDurableAgents(p.id, p.path).catch((err) => {
        rendererLog('core:agents', 'error', 'Failed to load durable agents', {
          projectId: p.id,
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      });
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
    let cancelled = false;
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
      const isRemote = isRemoteProjectId(activeProjectId);

      if (project || isRemote) {
        // Load project plugin config then activate
        (async () => {
          // Wait for the plugin system to finish initializing before
          // attempting to load project-scoped plugins. Without this gate,
          // a project switch that fires before init completes would see an
          // empty plugin registry and silently skip community plugins.
          await pluginSystemReady;
          if (cancelled) return;

          if (isRemote) {
            // Remote project: use matched plugins from satellite snapshot
            const parsed = parseNamespacedId(activeProjectId);
            if (parsed) {
              const matchState = useRemoteProjectStore.getState().pluginMatchState[parsed.satelliteId] || [];
              const matchedIds = matchState
                .filter((p) => p.status === 'matched')
                .map((p) => p.id);
              // Merge built-in project-scoped plugins
              let expFlags = {};
              try { expFlags = await window.clubhouse.app.getExperimentalSettings(); } catch { /* ignore */ }
              if (cancelled) return;
              const builtinIds = getBuiltinProjectPluginIds(expFlags);
              const merged = [...new Set([...matchedIds, ...builtinIds])];
              usePluginStore.getState().loadProjectPluginConfig(activeProjectId, merged);
            }
            if (cancelled) return;
            await handleProjectSwitch(prevId, activeProjectId, '__remote__');
          } else {
            // Load persisted per-project plugin config. The storageRead may
            // fail (first launch, corrupt data, IPC error) — that's fine, we
            // fall back to an empty list. But loadProjectPluginConfig MUST run
            // unconditionally so built-in project plugins are always enabled.
            let saved: string[] | undefined;
            try {
              saved = await window.clubhouse.plugin.storageRead({
                pluginId: '_system',
                scope: 'global',
                key: `project-enabled-${activeProjectId}`,
              }) as string[] | undefined;
            } catch { /* no saved config — will use builtin defaults */ }
            if (cancelled) return;
            let expFlags = {};
            try { expFlags = await window.clubhouse.app.getExperimentalSettings(); } catch { /* ignore */ }
            if (cancelled) return;
            const builtinIds = getBuiltinProjectPluginIds(expFlags);
            const base = Array.isArray(saved) ? saved : [];
            const merged = [...new Set([...base, ...builtinIds])];
            usePluginStore.getState().loadProjectPluginConfig(activeProjectId, merged);
            await handleProjectSwitch(prevId, activeProjectId, project!.path);
          }
        })().catch((err) => {
          if (cancelled) return;
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
    return () => { cancelled = true; };
  }, [activeProjectId, projects]);

  // ── Lock overlay action handlers ─────────────────────────────────────────
  const handleLockDisconnect = () => {
    if (lockControllerFingerprint) {
      window.clubhouse.annex.disconnectController(lockControllerFingerprint);
    }
    lockUnlock();
  };
  const handleLockPause = () => {
    const nextPaused = !lockPaused;
    lockTogglePause();
    // Notify controllers so they can show a paused state
    window.clubhouse.annex.notifyPause?.(nextPaused);
  };
  const handleLockDisableAndDisconnect = () => {
    window.clubhouse.annex.disableAndDisconnect();
    lockUnlock();
  };

  // ── Derived routing state ──────────────────────────────────────────────
  const isAppPlugin = explorerTab.startsWith('plugin:app:');
  const isHelp = explorerTab === 'help';
  const isAssistant = explorerTab === 'assistant';
  const isHome = activeProjectId === null && explorerTab !== 'settings' && !isAppPlugin && !isHelp && !isAssistant;

  // Lock overlay element (shared across all return paths)
  const lockOverlay = (
    <SatelliteLockOverlay
      lockState={{
        locked: lockLocked,
        paused: lockPaused,
        controllerAlias: lockControllerAlias,
        controllerIcon: lockControllerIcon,
        controllerColor: lockControllerColor,
        controllerFingerprint: lockControllerFingerprint,
      }}
      onDisconnect={handleLockDisconnect}
      onPause={handleLockPause}
      onDisableAndDisconnect={handleLockDisableAndDisconnect}
      bannerOffset={bannerHeight}
    />
  );

  if (isHome) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        {lockOverlay}
        <TitleBar />
        <div ref={bannerRef}>
          <PermissionViolationBanner />
          <UpdateBanner />
          <ResumeBanner
            sessions={resumeSessions}
            onManualResume={(agentId) => {
              console.log('[ResumeBanner] Manual resume requested for agent:', agentId);
            }}
            onDismiss={() => useAgentStore.getState().clearResumingAgents()}
          />
          <PluginUpdateBanner />
        </div>
        <RailSection>
          {activeHostId
            ? <SatelliteDashboard activeHostId={activeHostId} />
            : <Dashboard />}
        </RailSection>
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

    // When a satellite is active, gate app plugins by annex permission
    let appPluginContent;
    if (activeHostId) {
      const matches = pluginMatchState[activeHostId];
      if (matches !== undefined) {
        const match = matches.find((p) => p.id === appPluginId);
        if (match?.status === 'matched' && match.annexEnabled) {
          appPluginContent = <PluginContentView pluginId={appPluginId} mode="app" />;
        } else {
          appPluginContent = <AnnexDisabledView pluginName={match?.name || appPluginId} />;
        }
      } else {
        // Satellite data not yet loaded — render plugin locally as fallback
        appPluginContent = <PluginContentView pluginId={appPluginId} mode="app" />;
      }
    } else {
      appPluginContent = <PluginContentView pluginId={appPluginId} mode="app" />;
    }

    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        {lockOverlay}
        <TitleBar />
        <div ref={bannerRef}>
          <PermissionViolationBanner />
          <UpdateBanner />
          <ResumeBanner
            sessions={resumeSessions}
            onManualResume={(agentId) => {
              console.log('[ResumeBanner] Manual resume requested for agent:', agentId);
            }}
            onDismiss={() => useAgentStore.getState().clearResumingAgents()}
          />
          <PluginUpdateBanner />
        </div>
        <RailSection>
          {appPluginContent}
        </RailSection>
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
        {lockOverlay}
        <TitleBar />
        <div ref={bannerRef}>
          <PermissionViolationBanner />
          <UpdateBanner />
          <ResumeBanner
            sessions={resumeSessions}
            onManualResume={(agentId) => {
              console.log('[ResumeBanner] Manual resume requested for agent:', agentId);
            }}
            onDismiss={() => useAgentStore.getState().clearResumingAgents()}
          />
          <PluginUpdateBanner />
        </div>
        <RailSection>
          <HelpView />
        </RailSection>
        <CommandPalette />
        <QuickAgentDialog />
        <WhatsNewDialog />
        <OnboardingModal />
        <ConfigChangesDialog />
        <ToastContainer />
      </div>
    );
  }

  if (isAssistant) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        {lockOverlay}
        <TitleBar />
        <div ref={bannerRef}>
          <PermissionViolationBanner />
          <UpdateBanner />
          <ResumeBanner
            sessions={resumeSessions}
            onManualResume={(agentId) => {
              console.log('[ResumeBanner] Manual resume requested for agent:', agentId);
            }}
            onDismiss={() => useAgentStore.getState().clearResumingAgents()}
          />
          <PluginUpdateBanner />
        </div>
        <RailSection>
          <AssistantView />
        </RailSection>
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
      {lockOverlay}
      <TitleBar />
      <div ref={bannerRef}>
        <PermissionViolationBanner />
        <UpdateBanner />
        <ResumeBanner
          sessions={resumeSessions}
          onManualResume={(agentId) => {
            console.log('[ResumeBanner] Manual resume requested for agent:', agentId);
          }}
          onDismiss={() => useAgentStore.getState().clearResumingAgents()}
        />
        <PluginUpdateBanner />
        <GitBanner />
      </div>
      <RailSection>
        <ProjectPanelLayout />
      </RailSection>
      <CommandPalette />
      <QuickAgentDialog />
      <WhatsNewDialog />
      <OnboardingModal />
      <ConfigChangesDialog />
      <ToastContainer />
    </div>
  );
}
