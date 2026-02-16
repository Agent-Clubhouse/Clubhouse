import { useEffect, useRef } from 'react';
import { ProjectRail } from './panels/ProjectRail';
import { ExplorerRail } from './panels/ExplorerRail';
import { AccessoryPanel } from './panels/AccessoryPanel';
import { MainContentView } from './panels/MainContentView';
import { Dashboard } from './features/projects/Dashboard';
import { GitBanner } from './features/projects/GitBanner';
import { useProjectStore } from './stores/projectStore';
import { useAgentStore } from './stores/agentStore';
import { useUIStore } from './stores/uiStore';
import { useNotificationStore } from './stores/notificationStore';
import { useQuickAgentStore } from './stores/quickAgentStore';
import { useThemeStore } from './stores/themeStore';
import { useOrchestratorStore } from './stores/orchestratorStore';
import { useLoggingStore } from './stores/loggingStore';
import { usePluginStore } from './plugins/plugin-store';
import { initializePluginSystem, handleProjectSwitch, getBuiltinProjectPluginIds } from './plugins/plugin-loader';
import { pluginEventBus } from './plugins/plugin-events';
import { PluginContentView } from './panels/PluginContentView';
import { HelpView } from './features/help/HelpView';
import { PermissionViolationBanner } from './features/plugins/PermissionViolationBanner';

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
  const addCompleted = useQuickAgentStore((s) => s.addCompleted);
  const loadCompleted = useQuickAgentStore((s) => s.loadCompleted);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const clearStaleStatuses = useAgentStore((s) => s.clearStaleStatuses);
  const loadOrchestratorSettings = useOrchestratorStore((s) => s.loadSettings);
  const loadLoggingSettings = useLoggingStore((s) => s.loadSettings);

  useEffect(() => {
    loadProjects();
    loadNotificationSettings();
    loadTheme();
    loadOrchestratorSettings();
    loadLoggingSettings();
    initializePluginSystem().catch((err) => {
      console.error('[Plugins] Failed to initialize plugin system:', err);
    });
  }, [loadProjects, loadNotificationSettings, loadTheme, loadOrchestratorSettings, loadLoggingSettings]);

  useEffect(() => {
    const remove = window.clubhouse.app.onOpenSettings(() => {
      const state = useUIStore.getState();
      if (state.explorerTab !== 'settings') {
        state.toggleSettings();
      }
    });
    return () => remove();
  }, []);

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
      // Restore per-project navigation state
      useUIStore.getState().restoreProjectView(activeProjectId);
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

        // Emit plugin event for agent completion
        pluginEventBus.emit('agent:completed', { agentId, exitCode, name: agent?.name });

        // Handle quick agent completion
        if (agent?.kind === 'quick' && agent.mission) {
          let summary: string | null = null;
          let filesModified: string[] = [];

          try {
            const result = await window.clubhouse.agent.readQuickSummary(agentId);
            if (result) {
              summary = result.summary;
              filesModified = result.filesModified;
            }
          } catch {
            // Summary not available
          }

          // If the summary was found, treat as success regardless of exit code
          // (we often force-kill quick agents after they finish, giving >128 codes)
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
          });

          removeAgent(agentId);
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
        checkAndNotify(name, event.kind, event.toolName);

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
        // Delay gives the agent time to write the summary file before we send /exit.
        if (event.kind === 'stop' && agent.kind === 'quick') {
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

  if (isHome) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center">
          <span className="text-xs text-ctp-subtext0 select-none" data-testid="title-bar">{titleText}</span>
        </div>
        <PermissionViolationBanner />
        <div className="flex-1 min-h-0 grid grid-cols-[60px_1fr]">
          <ProjectRail />
          <Dashboard />
        </div>
      </div>
    );
  }

  if (isAppPlugin) {
    const appPluginId = explorerTab.slice('plugin:app:'.length);
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center">
          <span className="text-xs text-ctp-subtext0 select-none" data-testid="title-bar">{titleText}</span>
        </div>
        <PermissionViolationBanner />
        <div className="flex-1 min-h-0 grid grid-cols-[60px_1fr]">
          <ProjectRail />
          <PluginContentView pluginId={appPluginId} mode="app" />
        </div>
      </div>
    );
  }

  if (isHelp) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center">
          <span className="text-xs text-ctp-subtext0 select-none" data-testid="title-bar">{titleText}</span>
        </div>
        <PermissionViolationBanner />
        <div className="flex-1 min-h-0 grid grid-cols-[60px_1fr]">
          <ProjectRail />
          <HelpView />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
      {/* Title bar */}
      <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center">
        <span className="text-xs text-ctp-subtext0 select-none" data-testid="title-bar">{titleText}</span>
      </div>
      {/* Permission violation banner */}
      <PermissionViolationBanner />
      {/* Git banner */}
      <GitBanner />
      {/* Main content grid */}
      <div className={`flex-1 min-h-0 grid ${isFullWidth ? 'grid-cols-[60px_200px_1fr]' : 'grid-cols-[60px_200px_280px_1fr]'}`}>
        <ProjectRail />
        <ExplorerRail />
        {!isFullWidth && <AccessoryPanel />}
        <MainContentView />
      </div>
    </div>
  );
}
