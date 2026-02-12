import { useMemo, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { Project, Agent } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';

const STATUS_CONFIG: Record<string, { label: string }> = {
  running: { label: 'Running' },
  sleeping: { label: 'Sleeping' },
  error: { label: 'Error' },
};

function useNavigateToAgent() {
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);

  return useCallback(
    (projectId: string, agentId: string) => {
      setActiveProject(projectId);
      setActiveAgent(agentId);
      setExplorerTab('agents');
    },
    [setActiveProject, setActiveAgent, setExplorerTab]
  );
}

const STATUS_RING_COLOR: Record<string, string> = {
  running: '#22c55e',
  sleeping: '#6c7086',
  error: '#f87171',
};

function AgentAvatar({ agent, size = 'sm' }: { agent: Agent; size?: 'sm' | 'md' }) {
  const detailedStatus = useAgentStore((s) => s.agentDetailedStatus);
  const detailed = detailedStatus[agent.id];
  const isWorking = agent.status === 'running' && detailed?.state === 'working';
  const baseRingColor = STATUS_RING_COLOR[agent.status] || STATUS_RING_COLOR.sleeping;
  const ringColor = agent.status === 'running' && detailed?.state === 'needs_permission' ? '#f97316'
    : agent.status === 'running' && detailed?.state === 'tool_error' ? '#facc15'
    : baseRingColor;

  const outerDim = size === 'sm' ? 'w-7 h-7' : 'w-9 h-9';
  const innerDim = size === 'sm' ? 'w-5 h-5 text-[8px]' : 'w-7 h-7 text-[10px]';
  const iconSize = size === 'sm' ? 8 : 12;

  const inner = agent.kind === 'durable' ? (
    (() => {
      const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);
      return (
        <div
          className={`${innerDim} rounded-full flex items-center justify-center font-bold text-white`}
          style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
        >
          {agent.name.split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
        </div>
      );
    })()
  ) : (
    <div className={`${innerDim} rounded-full flex items-center justify-center bg-surface-2 text-ctp-subtext0`}>
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    </div>
  );

  return (
    <div className={`flex-shrink-0 ${isWorking ? 'animate-pulse-ring' : ''}`}>
      <div
        className={`${outerDim} rounded-full flex items-center justify-center`}
        style={{ border: `2px solid ${ringColor}` }}
      >
        {inner}
      </div>
    </div>
  );
}

/* ─── Global Summary Bar ─── */

function SummaryBar() {
  const agents = useAgentStore((s) => s.agents);
  const detailedStatus = useAgentStore((s) => s.agentDetailedStatus);

  const counts = useMemo(() => {
    const all = Object.values(agents);
    let working = 0, idle = 0, sleeping = 0, errored = 0;
    for (const a of all) {
      if (a.status === 'running') {
        const d = detailedStatus[a.id];
        if (d && d.state === 'working') working++;
        else idle++;
      } else if (a.status === 'sleeping') {
        sleeping++;
      } else if (a.status === 'error') {
        errored++;
      }
    }
    return { working, idle, sleeping, errored, total: all.length };
  }, [agents, detailedStatus]);

  if (counts.total === 0) return null;

  const pills: { label: string; count: number; dot: string; pulse?: boolean }[] = [
    { label: 'Working', count: counts.working, dot: 'bg-blue-400', pulse: true },
    { label: 'Idle', count: counts.idle, dot: 'bg-green-400' },
    { label: 'Sleeping', count: counts.sleeping, dot: 'bg-ctp-subtext0' },
    { label: 'Error', count: counts.errored, dot: 'bg-red-400' },
  ];

  return (
    <div className="flex items-center gap-3 flex-wrap mb-5">
      {pills.map(
        (p) =>
          p.count > 0 && (
            <span
              key={p.label}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-0 text-xs text-ctp-subtext1"
            >
              <span className={`w-2 h-2 rounded-full ${p.dot} ${p.pulse ? 'animate-pulse' : ''}`} />
              {p.count} {p.label}
            </span>
          )
      )}
    </div>
  );
}

/* ─── Needs Attention Box ─── */

function NeedsAttentionBox() {
  const agents = useAgentStore((s) => s.agents);
  const detailedStatus = useAgentStore((s) => s.agentDetailedStatus);
  const projects = useProjectStore((s) => s.projects);
  const navigateToAgent = useNavigateToAgent();

  const attentionAgents = useMemo(() => {
    const result: { agent: Agent; reason: string; projectName: string }[] = [];
    for (const agent of Object.values(agents)) {
      const d = detailedStatus[agent.id];
      let reason: string | null = null;
      if (d?.state === 'needs_permission') reason = 'Needs permission';
      else if (d?.state === 'tool_error') reason = 'Tool failed';
      else if (agent.status === 'error') reason = 'Error';
      if (reason) {
        const proj = projects.find((p) => p.id === agent.projectId);
        result.push({ agent, reason, projectName: proj?.name || 'Unknown' });
      }
    }
    return result;
  }, [agents, detailedStatus, projects]);

  if (attentionAgents.length === 0) return null;

  return (
    <div className="border border-orange-400/40 bg-orange-400/5 rounded-xl p-4 mb-5">
      <h2 className="text-sm font-semibold text-orange-300 mb-2">Needs Attention</h2>
      <div className="flex flex-col gap-1">
        {attentionAgents.map(({ agent, reason, projectName }) => (
          <button
            key={agent.id}
            onClick={() => navigateToAgent(agent.projectId, agent.id)}
            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-orange-400/10 transition-colors cursor-pointer text-left w-full"
          >
            <AgentAvatar agent={agent} size="sm" />
            <span className="text-sm text-ctp-text font-medium truncate">{agent.name}</span>
            <span className="text-xs text-ctp-subtext0 truncate">{projectName}</span>
            <span className="ml-auto text-xs text-orange-400 flex-shrink-0">{reason}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── Agent Row inside Project Card ─── */

function AgentRow({ agent, navigateToAgent }: { agent: Agent; navigateToAgent: (projectId: string, agentId: string) => void }) {
  const detailedStatus = useAgentStore((s) => s.agentDetailedStatus);
  const detailed = detailedStatus[agent.id];

  const statusInfo = STATUS_CONFIG[agent.status] || STATUS_CONFIG.sleeping;
  const hasDetailed = agent.status === 'running' && detailed;
  const statusLabel = hasDetailed ? detailed.message : statusInfo.label;

  return (
    <button
      onClick={() => navigateToAgent(agent.projectId, agent.id)}
      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-1/60 transition-colors cursor-pointer text-left w-full"
    >
      <AgentAvatar agent={agent} size="md" />

      <span className="text-sm text-ctp-text font-medium truncate min-w-0">{agent.name}</span>

      {/* Status label */}
      <span
        className={`text-xs truncate flex-shrink-0 ${
          hasDetailed && detailed.state === 'needs_permission'
            ? 'text-orange-400'
            : hasDetailed && detailed.state === 'tool_error'
              ? 'text-red-400'
              : 'text-ctp-subtext0'
        }`}
      >
        {statusLabel}
      </span>

      {/* Branch */}
      {agent.branch && (
        <span className="text-xs text-ctp-subtext0 truncate flex-shrink-0 ml-auto max-w-[140px]" title={agent.branch}>
          <svg className="inline w-3 h-3 mr-0.5 -mt-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          {agent.branch}
        </span>
      )}
    </button>
  );
}

/* ─── Project Card ─── */

function ProjectCardIcon({ project }: { project: Project }) {
  const projectIcons = useProjectStore((s) => s.projectIcons);
  const iconDataUrl = projectIcons[project.id];
  const hasImage = !!project.icon && !!iconDataUrl;
  const colorInfo = project.color ? AGENT_COLORS.find((c) => c.id === project.color) : null;
  const hex = colorInfo?.hex || '#6366f1';

  if (hasImage) {
    return (
      <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0">
        <img src={iconDataUrl} alt={project.name} className="w-full h-full object-cover" />
      </div>
    );
  }

  return (
    <div
      className="w-10 h-10 rounded-lg flex items-center justify-center text-lg font-bold flex-shrink-0"
      style={{ backgroundColor: `${hex}20`, color: hex }}
    >
      {project.name.charAt(0).toUpperCase()}
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const allAgents = useAgentStore((s) => s.agents);
  const navigateToAgent = useNavigateToAgent();
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);

  const agents = useMemo(
    () => Object.values(allAgents).filter((a) => a.projectId === project.id),
    [allAgents, project.id]
  );

  const durableAgents = agents.filter((a) => a.kind === 'durable');
  const quickAgents = agents.filter((a) => a.kind === 'quick');

  const navigateToTab = useCallback(
    (tab: 'hub' | 'settings') => {
      setActiveProject(project.id);
      setExplorerTab(tab);
    },
    [project.id, setActiveProject, setExplorerTab]
  );

  return (
    <div className="bg-ctp-mantle border border-surface-0 rounded-xl overflow-hidden">
      {/* Card Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <button
          onClick={() => setActiveProject(project.id)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity cursor-pointer"
        >
          <ProjectCardIcon project={project} />
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-ctp-text truncate">{project.name}</h3>
            <p className="text-xs text-ctp-subtext0 truncate mt-0.5">{project.path}</p>
          </div>
        </button>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-xs text-ctp-subtext0 mr-1">
            {agents.length} agent{agents.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => navigateToTab('hub')}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-1 text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
            title="Hub"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L8 8H4l2 6H4l8 8 8-8h-2l2-6h-4L12 2z" />
              <line x1="12" y1="22" x2="12" y2="16" />
            </svg>
          </button>
          <button
            onClick={() => navigateToTab('settings')}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-1 text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
            title="Settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Agent Rows */}
      {agents.length > 0 && (
        <div className="border-t border-surface-0 px-2 py-1.5">
          {durableAgents.map((a) => (
            <AgentRow key={a.id} agent={a} navigateToAgent={navigateToAgent} />
          ))}
          {quickAgents.length > 0 && durableAgents.length > 0 && quickAgents.length <= 3 && (
            quickAgents.map((a) => (
              <AgentRow key={a.id} agent={a} navigateToAgent={navigateToAgent} />
            ))
          )}
          {quickAgents.length > 0 && (durableAgents.length === 0 || quickAgents.length > 3) && (
            <div className="px-3 py-2 text-xs text-ctp-subtext0">
              {quickAgents.length} quick session{quickAgents.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}

      {agents.length === 0 && (
        <div className="border-t border-surface-0 px-5 py-3">
          <span className="text-xs text-ctp-subtext0">No agents configured</span>
        </div>
      )}
    </div>
  );
}

/* ─── Dashboard ─── */

export function Dashboard() {
  const { projects, pickAndAddProject } = useProjectStore();

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold text-ctp-text mb-1">Home</h1>
        <p className="text-sm text-ctp-subtext0 mb-6">
          {projects.length} project{projects.length !== 1 ? 's' : ''}
        </p>

        <SummaryBar />
        <NeedsAttentionBox />

        <div className="flex flex-col gap-4">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}

          {/* Add project card */}
          <button
            onClick={() => pickAndAddProject()}
            className="border border-dashed border-surface-2 rounded-xl p-5
              flex flex-col items-center justify-center gap-2 min-h-[100px]
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
