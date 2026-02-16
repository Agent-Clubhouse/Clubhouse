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
import { useOrchestratorStore } from './stores/orchestratorStore';
import { CrossHubCommandCenter } from './features/cross-hub/CrossHubCommandCenter';

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const updateAgentStatus = useAgentStore((s) => s.updateAgentStatus);
  const handleHookEvent = useAgentStore((s) => s.handleHookEvent);
  const _agents = useAgentStore((s) => s.agents);
  const loadDurableAgents = useAgentStore((s) => s.loadDurableAgents);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const isFullWidth = explorerTab === 'hub' || explorerTab === 'terminal';
  const loadNotificationSettings = useNotificationStore((s) => s.loadSettings);
  const loadTheme = useThemeStore((s) => s.loadTheme);
  const checkAndNotify = useNotificationStore((s) => s.checkAndNotify);
  const addCompleted = useQuickAgentStore((s) => s.addCompleted);
  const loadCompleted = useQuickAgentStore((s) => s.loadCompleted);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const clearStaleStatuses = useAgentStore((s) => s.clearStaleStatuses);
  const loadOrchestratorSettings = useOrchestratorStore((s) => s.loadSettings);

  useEffect(() => {
    loadProjects();
    loadNotificationSettings();
    loadTheme();
    loadOrchestratorSettings();
  }, [loadProjects, loadNotificationSettings, loadTheme, loadOrchestratorSettings]);

  useEffect(() => {
    const remove = window.clubhouse.app.onOpenSettings(() => {
      const state = useUIStore.getState();
      if (state.explorerTab !== 'settings') {
        state.toggleSettings();
      }
      state.setSettingsSubPage('notifications');
    });
    return () => remove();
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
      (agentId, event) => {
        handleHookEvent(agentId, event as import('../shared/types').AgentHookEvent);
        const agent = useAgentStore.getState().agents[agentId];
        const name = agent?.name ?? agentId;
        checkAndNotify(name, event.kind, event.toolName);

        // Auto-exit quick agents when the agent finishes (stop event).
        // Delay gives the agent time to write the summary file before we send /exit.
        if (event.kind === 'stop' && agent?.kind === 'quick') {
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


  const isCrossHub = explorerTab === 'cross-hub';
  const isHome = activeProjectId === null && explorerTab !== 'settings' && !isCrossHub;
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const CORE_LABELS: Record<string, string> = {
    agents: 'Agents',
    hub: 'Project Hub',
    'cross-hub': 'Cross-Project Hub',
    terminal: 'Terminal',
    settings: 'Settings',
  };
  const tabLabel = CORE_LABELS[explorerTab] || explorerTab;

  const titleText = isHome
    ? 'Home'
    : isCrossHub
      ? 'Cross-Project Hub'
      : activeProject
        ? `${tabLabel} (${activeProject.displayName || activeProject.name})`
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

  if (isCrossHub) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center">
          <span className="text-xs text-ctp-subtext0 select-none">{titleText}</span>
        </div>
        <div className="flex-1 min-h-0 grid grid-cols-[60px_1fr]">
          <ProjectRail />
          <CrossHubCommandCenter />
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
