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

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const updateAgentStatus = useAgentStore((s) => s.updateAgentStatus);
  const handleHookEvent = useAgentStore((s) => s.handleHookEvent);
  const agents = useAgentStore((s) => s.agents);
  const loadDurableAgents = useAgentStore((s) => s.loadDurableAgents);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const setSettingsSubPage = useUIStore((s) => s.setSettingsSubPage);
  const isFullWidth = explorerTab === 'terminal' || explorerTab === 'hub';
  const loadNotificationSettings = useNotificationStore((s) => s.loadSettings);
  const checkAndNotify = useNotificationStore((s) => s.checkAndNotify);
  const addCompleted = useQuickAgentStore((s) => s.addCompleted);
  const loadCompleted = useQuickAgentStore((s) => s.loadCompleted);
  const removeAgent = useAgentStore((s) => s.removeAgent);

  useEffect(() => {
    loadProjects();
    loadNotificationSettings();
  }, [loadProjects, loadNotificationSettings]);

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

        // Auto-exit quick agents when Claude finishes (Stop event)
        if (event.eventName === 'Stop' && agent?.kind === 'quick') {
          window.clubhouse.pty.write(agentId, '/exit\n');
        }
      }
    );
    return () => removeHookListener();
  }, [handleHookEvent, checkAndNotify]);

  const isHome = activeProjectId === null;
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const TAB_LABELS: Record<string, string> = {
    agents: 'Agents',
    files: 'Files',
    terminal: 'Terminal',
    git: 'Git',
    hub: 'Hub',
    settings: 'Settings',
  };

  const titleText = isHome
    ? 'Home'
    : activeProject
      ? `${TAB_LABELS[explorerTab] || explorerTab} (${activeProject.name})`
      : TAB_LABELS[explorerTab] || explorerTab;

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
