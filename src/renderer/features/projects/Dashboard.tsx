import { useMemo } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { Project, Agent } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';

function AgentAvatar({ agent, size = 'sm' }: { agent: Agent; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-8 h-8 text-xs';
  if (agent.kind === 'durable') {
    const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);
    return (
      <div
        className={`${dim} rounded-full flex items-center justify-center font-bold text-white flex-shrink-0`}
        style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
        title={`${agent.name} (${agent.status})`}
      >
        {agent.name.split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
      </div>
    );
  }
  return (
    <div
      className={`${dim} rounded-full flex items-center justify-center flex-shrink-0 bg-surface-2 text-ctp-subtext0`}
      title={`${agent.name} (${agent.status})`}
    >
      <svg width={size === 'sm' ? 10 : 14} height={size === 'sm' ? 10 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const allAgents = useAgentStore((s) => s.agents);
  const agents = useMemo(
    () => Object.values(allAgents).filter((a) => a.projectId === project.id),
    [allAgents, project.id]
  );
  const setActiveProject = useProjectStore((s) => s.setActiveProject);

  const durableAgents = agents.filter((a) => a.kind === 'durable');
  const quickAgents = agents.filter((a) => a.kind === 'quick');
  const runningCount = agents.filter((a) => a.status === 'running').length;
  const sleepingCount = agents.filter((a) => a.status === 'sleeping').length;

  return (
    <button
      onClick={() => setActiveProject(project.id)}
      className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 text-left
        hover:border-surface-2 hover:bg-surface-0/30 transition-all duration-150 cursor-pointer
        flex flex-col gap-3"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-lg bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-lg font-bold flex-shrink-0">
          {project.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-ctp-text truncate">{project.name}</h3>
          <p className="text-xs text-ctp-subtext0 truncate mt-0.5">{project.path}</p>
        </div>
      </div>

      {/* Agent summary */}
      <div className="flex flex-col gap-1.5">
        {/* Agent avatars */}
        {agents.length > 0 && (
          <div className="flex items-center gap-1">
            {durableAgents.map((a) => (
              <AgentAvatar key={a.id} agent={a} />
            ))}
            {quickAgents.map((a) => (
              <AgentAvatar key={a.id} agent={a} />
            ))}
          </div>
        )}

        {/* Status summary */}
        <div className="flex items-center gap-2 text-xs text-ctp-subtext0">
          {agents.length === 0 ? (
            <span>No agents</span>
          ) : (
            <>
              {runningCount > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                  {runningCount} active
                </span>
              )}
              {sleepingCount > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
                  {sleepingCount} sleeping
                </span>
              )}
              {quickAgents.length > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-surface-2" />
                  {quickAgents.length} quick
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </button>
  );
}

export function Dashboard() {
  const { projects, pickAndAddProject } = useProjectStore();

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-ctp-text mb-1">Home</h1>
        <p className="text-sm text-ctp-subtext0 mb-6">
          {projects.length} project{projects.length !== 1 ? 's' : ''}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}

          {/* Add project card */}
          <button
            onClick={() => pickAndAddProject()}
            className="border border-dashed border-surface-2 rounded-xl p-5
              flex flex-col items-center justify-center gap-2 min-h-[120px]
              text-ctp-subtext0 hover:text-ctp-subtext1 hover:border-ctp-subtext0
              transition-all duration-150 cursor-pointer"
          >
            <span className="text-2xl">+</span>
            <span className="text-sm">Add Project</span>
          </button>
        </div>
      </div>
    </div>
  );
}
