import { useEffect } from 'react';
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
import { usePluginStore } from './stores/pluginStore';
import { registerAllPlugins, getPlugin, getAllPlugins } from './plugins';
import { CORE_TAB_IDS } from '../shared/types';

// Register all plugins once at module load
registerAllPlugins();

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const updateAgentStatus = useAgentStore((s) => s.updateAgentStatus);
  const handleHookEvent = useAgentStore((s) => s.handleHookEvent);
  const _agents = useAgentStore((s) => s.agents);
  const loadDurableAgents = useAgentStore((s) => s.loadDurableAgents);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const setSettingsSubPage = useUIStore((s) => s.setSettingsSubPage);
  const isFullWidth = explorerTab === 'hub' || (getPlugin(explorerTab)?.fullWidth === true);
  const loadNotificationSettings = useNotificationStore((s) => s.loadSettings);
  const loadTheme = useThemeStore((s) => s.loadTheme);
  const checkAndNotify = useNotificationStore((s) => s.checkAndNotify);
  const addCompleted = useQuickAgentStore((s) => s.addCompleted);
  const loadCompleted = useQuickAgentStore((s) => s.loadCompleted);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const clearStaleStatuses = useAgentStore((s) => s.clearStaleStatuses);
  const loadPluginConfig = usePluginStore((s) => s.loadPluginConfig);
  const isPluginEnabled = usePluginStore((s) => s.isPluginEnabled);

  useEffect(() => {
    loadProjects();
    loadNotificationSettings();
    loadTheme();
  }, [loadProjects, loadNotificationSettings, loadTheme]);

  useEffect(() => {
    const remove = window.clubhouse.app.onOpenSettings(() => {
      setExplorerTab('settings');
      setSettingsSubPage('notifications');
    });
    return () => remove();
  }, [setExplorerTab, setSettingsSubPage]);

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

  // Load plugin config when project changes
  useEffect(() => {
    if (activeProjectId) {
      const project = projects.find((p) => p.id === activeProjectId);
      if (project) {
        loadPluginConfig(activeProjectId, project.path);
      }
    }
  }, [activeProjectId, projects, loadPluginConfig]);

  // Guard: switch to 'agents' if current tab is a disabled plugin
  useEffect(() => {
    if (!activeProjectId) return;
    const isCoreTab = (CORE_TAB_IDS as readonly string[]).includes(explorerTab);
    if (!isCoreTab && !isPluginEnabled(activeProjectId, explorerTab)) {
      setExplorerTab('agents');
    }
  }, [activeProjectId, explorerTab, isPluginEnabled, setExplorerTab]);

  // Plugin lifecycle: call onProjectLoad for enabled plugins, onProjectUnload on cleanup
  useEffect(() => {
    if (!activeProjectId) return;
    const project = projects.find((p) => p.id === activeProjectId);
    if (!project) return;
    const ctx = { projectId: activeProjectId, projectPath: project.path };
    const enabledPlugins = getAllPlugins().filter(
      (p) => isPluginEnabled(activeProjectId, p.id),
    );
    for (const plugin of enabledPlugins) {
      plugin.onProjectLoad?.(ctx);
    }
    return () => {
      for (const plugin of enabledPlugins) {
        plugin.onProjectUnload?.(ctx);
      }
    };
  }, [activeProjectId, projects, isPluginEnabled]);

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

          addCompleted({
            id: agentId,
            projectId: agent.projectId,
            name: agent.name,
            mission: agent.mission,
            summary,
            filesModified,
            exitCode,
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
      (agentId, event) => {
        handleHookEvent(agentId, event);
        const agent = useAgentStore.getState().agents[agentId];
        const name = agent?.name ?? agentId;
        checkAndNotify(name, event.eventName, event.toolName);

        // Auto-exit quick agents when Claude finishes (Stop event).
        // Short delay lets Claude finish rendering before we send /exit.
        // pty.kill triggers gracefulKill: sends /exit then force-kills after 5s.
        if (event.eventName === 'Stop' && agent?.kind === 'quick') {
          setTimeout(() => {
            window.clubhouse.pty.kill(agentId);
          }, 500);
        }
      }
    );
    return () => removeHookListener();
  }, [handleHookEvent, checkAndNotify]);


  const isHome = activeProjectId === null;
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const pluginLabel = getPlugin(explorerTab)?.label;
  const CORE_LABELS: Record<string, string> = {
    agents: 'Agents',
    hub: 'Hub',
    settings: 'Settings',
  };
  const tabLabel = CORE_LABELS[explorerTab] || pluginLabel || explorerTab;

  const titleText = isHome
    ? 'Home'
    : activeProject
      ? `${tabLabel} (${activeProject.name})`
      : tabLabel;

  if (isHome) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center">
          <span className="text-xs text-ctp-subtext0 select-none">{titleText}</span>
        </div>
        <div className="flex-1 min-h-0 grid grid-cols-[60px_1fr]">
          <ProjectRail />
          <Dashboard />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
      {/* Title bar */}
      <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center">
        <span className="text-xs text-ctp-subtext0 select-none">{titleText}</span>
      </div>
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
