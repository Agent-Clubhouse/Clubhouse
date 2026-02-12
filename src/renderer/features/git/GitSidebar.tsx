import { useMemo } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { WorktreeSection } from './WorktreeSection';
import { colorHexMap, getDurableWorktreeAgents } from './git-sidebar-utils';

const gitBranchIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

export function GitSidebar() {
  const { projects, activeProjectId } = useProjectStore();
  const agents = useAgentStore((s) => s.agents);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const durableAgents = useMemo(
    () => getDurableWorktreeAgents(agents, activeProjectId),
    [agents, activeProjectId],
  );

  if (!activeProject) {
    return (
      <div className="p-3 text-ctp-subtext0 text-sm">No active project</div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Main project worktree */}
      <WorktreeSection
        dirPath={activeProject.path}
        label="Main Project"
        defaultExpanded={true}
        icon={gitBranchIcon}
      />

      {/* Agent worktrees */}
      {durableAgents.map((agent) => (
        <WorktreeSection
          key={agent.id}
          dirPath={agent.worktreePath!}
          label={agent.name}
          defaultExpanded={false}
          icon={
            <span className="flex items-center gap-1 flex-shrink-0">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: colorHexMap[agent.color] || '#6366f1' }}
              />
              {agent.emoji && <span className="text-xs">{agent.emoji}</span>}
            </span>
          }
        />
      ))}
    </div>
  );
}
