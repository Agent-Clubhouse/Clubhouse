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
import { useAgentStore, consumeCancelled } from './stores/agentStore';
import { useUIStore } from './stores/uiStore';
import { useNotificationStore } from './stores/notificationStore';
import { useQuickAgentStore } from './stores/quickAgentStore';
import { useThemeStore } from './stores/themeStore';
import { useOrchestratorStore } from './stores/orchestratorStore';
import { useLoggingStore } from './stores/loggingStore';
import { useHeadlessStore } from './stores/headlessStore';
import { useBadgeSettingsStore } from './stores/badgeSettingsStore';
import { initBadgeSideEffects } from './stores/badgeStore';
import { usePluginStore } from './plugins/plugin-store';
import { initializePluginSystem, handleProjectSwitch, getBuiltinProjectPluginIds } from './plugins/plugin-loader';
import { pluginEventBus } from './plugins/plugin-events';
import { PluginContentView } from './panels/PluginContentView';
import { HelpView } from './features/help/HelpView';
import { PermissionViolationBanner } from './features/plugins/PermissionViolationBanner';
import { UpdateBanner } from './features/app/UpdateBanner';
import { WhatsNewDialog } from './features/app/WhatsNewDialog';
import { OnboardingModal } from './features/onboarding/OnboardingModal';
import { CommandPalette } from './features/command-palette/CommandPalette';
import { useCommandPaletteStore } from './stores/commandPaletteStore';
import { useOnboardingStore } from './stores/onboardingStore';
import { useUpdateStore } from './stores/updateStore';
import { initUpdateListener } from './stores/updateStore';

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const updateAgentStatus = useAgentStore((s) => s.updateAgentStatus);
  const handleHookEvent = useAgentStore((s) => s.handleHookEvent);
  const _agents = useAgentStore((s) => s.agents);
  const loadDurableAgents = useAgentStore((s) => s.loadDurableAgents);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const pluginsMap = usePluginStore((s) => s.plugins);
  const isPluginFullWidth = (() => {
    if (!explorerTab.startsWith('plugin:')) return false;
    const pluginId = explorerTab.slice('plugin:'.length);
    const entry = pluginsMap[pluginId];
    return entry?.manifest.contributes?.tab?.layout === 'full';
  })();
  const isFullWidth = isPluginFullWidth;
  const loadNotificationSettings = useNotificationStore((s) => s.loadSettings);
  const loadTheme = useThemeStore((s) => s.loadTheme);
  const checkAndNotify = useNotificationStore((s) => s.checkAndNotify);
  const clearNotification = useNotificationStore((s) => s.clearNotification);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const addCompleted = useQuickAgentStore((s) => s.addCompleted);
  const loadCompleted = useQuickAgentStore((s) => s.loadCompleted);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const clearStaleStatuses = useAgentStore((s) => s.clearStaleStatuses);
  const loadOrchestratorSettings = useOrchestratorStore((s) => s.loadSettings);
  const loadLoggingSettings = useLoggingStore((s) => s.loadSettings);
  const loadHeadlessSettings = useHeadlessStore((s) => s.loadSettings);
  const loadBadgeSettings = useBadgeSettingsStore((s) => s.loadSettings);
  const loadUpdateSettings = useUpdateStore((s) => s.loadSettings);
  const checkWhatsNew = useUpdateStore((s) => s.checkWhatsNew);
  const onboardingCompleted = useOnboardingStore((s) => s.completed);
  const startOnboarding = useOnboardingStore((s) => s.startOnboarding);

  const explorerWidth = usePanelStore((s) => s.explorerWidth);
  const explorerCollapsed = usePanelStore((s) => s.explorerCollapsed);
  const accessoryWidth = usePanelStore((s) => s.accessoryWidth);
  const accessoryCollapsed = usePanelStore((s) => s.accessoryCollapsed);
  const resizeExplorer = usePanelStore((s) => s.resizeExplorer);
  const resizeAccessory = usePanelStore((s) => s.resizeAccessory);
  const toggleExplorerCollapse = usePanelStore((s) => s.toggleExplorerCollapse);
  const toggleAccessoryCollapse = usePanelStore((s) => s.toggleAccessoryCollapse);

  useEffect(() => {
    loadProjects();
    loadNotificationSettings();
    loadTheme();
    loadOrchestratorSettings();
    loadLoggingSettings();
    loadHeadlessSettings();
    loadBadgeSettings();
    loadUpdateSettings();
    initBadgeSideEffects();
    initializePluginSystem().catch((err) => {
      console.error('[Plugins] Failed to initialize plugin system:', err);
    });
  }, [loadProjects, loadNotificationSettings, loadTheme, loadOrchestratorSettings, loadLoggingSettings, loadHeadlessSettings, loadBadgeSettings, loadUpdateSettings]);

  // Listen for update status changes from main process
  useEffect(() => {
    const remove = initUpdateListener();
    return () => remove();
  }, []);

  // Check for What's New dialog after startup
  useEffect(() => {
    const timer = setTimeout(() => {
      checkWhatsNew();
    }, 1000);
    return () => clearTimeout(timer);
  }, [checkWhatsNew]);

  // Show onboarding on first launch
  useEffect(() => {
    if (!onboardingCompleted) {
      const timer = setTimeout(() => {
        startOnboarding();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const remove = window.clubhouse.app.onOpenSettings(() => {
      const state = useUIStore.getState();
      if (state.explorerTab !== 'settings') {
        state.toggleSettings();
      }
    });
    return () => remove();
  }, []);

  useEffect(() => {
    const remove = window.clubhouse.app.onOpenAbout(() => {
      const state = useUIStore.getState();
      if (state.explorerTab !== 'settings') {
        state.openAbout();
      } else {
        state.setSettingsSubPage('about');
      }
    });
    return () => remove();
  }, []);

  // Navigate to agent when notification is clicked
  useEffect(() => {
    const remove = window.clubhouse.app.onNotificationClicked((agentId: string, projectId: string) => {
      useProjectStore.getState().setActiveProject(projectId);
      useUIStore.getState().setExplorerTab('agents', projectId);
      useAgentStore.getState().setActiveAgent(agentId, projectId);
    });
    return () => remove();
  }, []);

  // Clear any active OS notification when the user navigates to the agent's view
  useEffect(() => {
    if (activeAgentId && activeProjectId && explorerTab === 'agents') {
      clearNotification(activeAgentId, activeProjectId);
    }
  }, [activeAgentId, activeProjectId, explorerTab, clearNotification]);

  // Cmd+1-9: switch to Nth project
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const digit = e.key >= '1' && e.key <= '9' ? parseInt(e.key, 10) : 0;
      if (!digit) return;
      const { projects: ps, setActiveProject } = useProjectStore.getState();
      const target = ps[digit - 1];
      if (target) {
        e.preventDefault();
        setActiveProject(target.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Cmd+K: toggle command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useCommandPaletteStore.getState().toggle();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Load durable agents for all projects so the dashboard shows them
  useEffect(() => {
    for (const p of projects) {
      loadDurableAgents(p.id, p.path);
    }
  }, [projects, loadDurableAgents]);

  // Load completed quick agents for all projects
  useEffect(() => {
    for (const p of projects) {
      loadCompleted(p.id);
    }
  }, [projects, loadCompleted]);

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

  // Emit agent:status-changed plugin events when agent statuses change
  const prevAgentStatusesRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const unsub = useAgentStore.subscribe((state) => {
      const prev = prevAgentStatusesRef.current;
      const next: Record<string, string> = {};
      for (const [id, agent] of Object.entries(state.agents)) {
        next[id] = agent.status;
        if (prev[id] && prev[id] !== agent.status) {
          pluginEventBus.emit('agent:status-changed', {
            agentId: id,
            status: agent.status,
            prevStatus: prev[id],
            name: agent.name,
          });
        }
      }
      prevAgentStatusesRef.current = next;
    });
    return unsub;
  }, []);

  // Periodically clear stale detailed statuses (e.g. stuck "Thinking" or "Searching files")
  useEffect(() => {
    const id = setInterval(clearStaleStatuses, 10_000);
    return () => clearInterval(id);
  }, [clearStaleStatuses]);

  useEffect(() => {
    const removeExitListener = window.clubhouse.pty.onExit(
      async (agentId: string, exitCode: number) => {
        const agent = useAgentStore.getState().agents[agentId];
        updateAgentStatus(agentId, 'sleeping', exitCode);

        // Handle quick agent completion FIRST (before plugin events which could throw)
        if (agent?.kind === 'quick' && agent.mission) {
          let summary: string | null = null;
          let filesModified: string[] = [];
          let costUsd: number | undefined;
          let durationMs: number | undefined;
          let toolsUsed: string[] | undefined;

          if (agent.headless) {
            // Headless agents: read enriched data from transcript
            try {
              const transcript = await window.clubhouse.agent.readTranscript(agentId);
              if (transcript) {
                // Parse transcript events to extract summary data
                const events = transcript.split('\n')
                  .filter((line: string) => line.trim())
                  .map((line: string) => {
                    try { return JSON.parse(line); } catch { return null; }
                  })
                  .filter(Boolean);

                // Extract data from transcript events (--verbose format)
                let lastAssistantText = '';
                const tools = new Set<string>();

                for (const evt of events) {
                  // Result event: summary, cost, duration
                  if (evt.type === 'result') {
                    if (typeof evt.result === 'string' && evt.result) {
                      summary = evt.result;
                    }
                    if (evt.total_cost_usd != null) costUsd = evt.total_cost_usd;
                    else if (evt.cost_usd != null) costUsd = evt.cost_usd;
                    if (evt.duration_ms != null) durationMs = evt.duration_ms;
                  }

                  // --verbose: assistant messages contain text and tool_use blocks
                  if (evt.type === 'assistant' && evt.message?.content) {
                    for (const block of evt.message.content) {
                      if (block.type === 'text' && block.text) {
                        lastAssistantText = block.text;
                      }
                      if (block.type === 'tool_use' && block.name) {
                        tools.add(block.name);
                      }
                    }
                  }

                  // Legacy streaming format fallback
                  if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use' && evt.content_block?.name) {
                    tools.add(evt.content_block.name);
                  }
                }

                // Fall back to last assistant text if result was empty
                if (!summary && lastAssistantText.trim()) {
                  const text = lastAssistantText.trim();
                  summary = text.length > 500 ? text.slice(0, 497) + '...' : text;
                }

                if (tools.size > 0) toolsUsed = Array.from(tools);
              }
            } catch {
              // Transcript not available
            }
          } else {
            // PTY agents: read /tmp summary file
            try {
              const result = await window.clubhouse.agent.readQuickSummary(agentId);
              if (result) {
                summary = result.summary;
                filesModified = result.filesModified;
              }
            } catch {
              // Summary not available
            }
          }

          // If the summary was found, treat as success regardless of exit code
          // (we often force-kill quick agents after they finish, giving >128 codes)
          const cancelled = consumeCancelled(agentId);
          const effectiveExitCode = summary ? 0 : exitCode;

          addCompleted({
            id: agentId,
            projectId: agent.projectId,
            name: agent.name,
            mission: agent.mission,
            summary,
            filesModified,
            exitCode: effectiveExitCode,
            completedAt: Date.now(),
            parentAgentId: agent.parentAgentId,
            headless: agent.headless,
            costUsd,
            durationMs,
            toolsUsed,
            orchestrator: agent.orchestrator || 'claude-code',
            model: agent.model,
            cancelled,
          });

          removeAgent(agentId);
        }

        // Emit plugin event after completion logic (wrapped to prevent silent failures)
        try {
          pluginEventBus.emit('agent:completed', { agentId, exitCode, name: agent?.name });
        } catch {
          // Plugin listener error — don't break the app
        }
      }
    );
    return () => removeExitListener();
  }, [updateAgentStatus, addCompleted, removeAgent]);

  useEffect(() => {
    const removeHookListener = window.clubhouse.agent.onHookEvent(
      (agentId: string, event: { kind: string; toolName?: string; toolInput?: Record<string, unknown>; message?: string; toolVerb?: string; timestamp: number }) => {
        handleHookEvent(agentId, event as import('../shared/types').AgentHookEvent);
        const agent = useAgentStore.getState().agents[agentId];
        if (!agent) return;
        const name = agent.name;
        checkAndNotify(name, event.kind, event.toolName, agentId, agent.projectId);

        // Emit plugin events for agent lifecycle
        if (event.kind === 'stop') {
          pluginEventBus.emit('agent:completed', { agentId, name });
        } else {
          pluginEventBus.emit('agent:spawned', { agentId, name, kind: event.kind });
        }

        // Emit agent:hook for all hook events
        pluginEventBus.emit('agent:hook', {
          agentId,
          kind: event.kind,
          toolName: event.toolName,
          timestamp: event.timestamp,
        });

        // Auto-exit quick agents when the agent finishes (stop event).
        // Headless agents exit on their own — skip the kill timer.
        if (event.kind === 'stop' && agent.kind === 'quick' && !agent.headless) {
          // Delay gives the agent time to write the summary file before we send /exit.
          const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
          setTimeout(() => {
            const currentAgent = useAgentStore.getState().agents[agentId];
            if (currentAgent?.status !== 'running') return; // already exited
            if (project) {
              window.clubhouse.agent.killAgent(agentId, project.path);
            } else {
              window.clubhouse.pty.kill(agentId);
            }
          }, 2000);
        }
      }
    );
    return () => removeHookListener();
  }, [handleHookEvent, checkAndNotify]);


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
    if (explorerTab.startsWith('plugin:app:')) {
      const pluginId = explorerTab.slice('plugin:app:'.length);
      const entry = pluginsMap[pluginId];
      return entry?.manifest.contributes?.railItem?.label || entry?.manifest.name || pluginId;
    }
    if (explorerTab.startsWith('plugin:')) {
      const pluginId = explorerTab.slice('plugin:'.length);
      const entry = pluginsMap[pluginId];
      return entry?.manifest.contributes?.tab?.label || entry?.manifest.name || pluginId;
    }
    return CORE_LABELS[explorerTab] || explorerTab;
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
        <div className="flex-1 min-h-0 grid grid-rows-[1fr]" style={{ gridTemplateColumns: 'var(--rail-width, 68px) 1fr' }}>
          <ProjectRail />
          <Dashboard />
        </div>
        <CommandPalette />
        <WhatsNewDialog />
        <OnboardingModal />
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
        <div className="flex-1 min-h-0 grid grid-rows-[1fr]" style={{ gridTemplateColumns: 'var(--rail-width, 68px) 1fr' }}>
          <ProjectRail />
          <PluginContentView pluginId={appPluginId} mode="app" />
        </div>
        <CommandPalette />
        <WhatsNewDialog />
        <OnboardingModal />
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
        <div className="flex-1 min-h-0 grid grid-rows-[1fr]" style={{ gridTemplateColumns: 'var(--rail-width, 68px) 1fr' }}>
          <ProjectRail />
          <HelpView />
        </div>
        <CommandPalette />
        <WhatsNewDialog />
        <OnboardingModal />
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
      <WhatsNewDialog />
      <OnboardingModal />
    </div>
  );
}
