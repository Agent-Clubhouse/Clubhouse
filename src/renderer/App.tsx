import { useEffect } from 'react';
import { ProjectRail } from './panels/ProjectRail';
import { ExplorerRail } from './panels/ExplorerRail';
import { AccessoryPanel } from './panels/AccessoryPanel';
import { MainContentView } from './panels/MainContentView';
import { Dashboard } from './features/projects/Dashboard';
import { GitBanner } from './features/projects/GitBanner';
import { useProjectStore } from './stores/projectStore';
import { useAgentStore } from './stores/agentStore';

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const updateAgentStatus = useAgentStore((s) => s.updateAgentStatus);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    const removeExitListener = window.clubhouse.pty.onExit(
      (agentId: string, exitCode: number) => {
        updateAgentStatus(agentId, 'stopped', exitCode);
      }
    );
    return () => removeExitListener();
  }, [updateAgentStatus]);

  const isHome = activeProjectId === null;

  if (isHome) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0" />
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
      <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0" />
      {/* Git banner */}
      <GitBanner />
      {/* Main content grid */}
      <div className="flex-1 min-h-0 grid grid-cols-[60px_200px_280px_1fr]">
        <ProjectRail />
        <ExplorerRail />
        <AccessoryPanel />
        <MainContentView />
      </div>
    </div>
  );
}
