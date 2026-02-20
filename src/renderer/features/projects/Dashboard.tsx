import { useMemo, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { Project, Agent, CompletedQuickAgent } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';

/* ─── Helpers ─── */

function useNavigateToAgent() {
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);

  return useCallback(
    (projectId: string, agentId: string) => {
      setActiveProject(projectId);
      setActiveAgent(agentId, projectId);
      setExplorerTab('agents', projectId);
    },
    [setActiveProject, setActiveAgent, setExplorerTab]
  );
}

function useNavigateToProject() {
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const setSettingsContext = useUIStore((s) => s.setSettingsContext);

  return useMemo(() => ({
    toProject: (projectId: string) => {
      setActiveProject(projectId);
    },
    toHub: (projectId: string) => {
      setActiveProject(projectId);
      setExplorerTab('plugin:hub', projectId);
    },
    toSettings: (projectId: string) => {
      setActiveProject(projectId);
      setExplorerTab('settings');
      setSettingsContext(projectId);
    },
  }), [setActiveProject, setExplorerTab, setSettingsContext]);
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

const STATUS_RING_COLOR: Record<string, string> = {
  running: '#22c55e',
  sleeping: '#6c7086',
  error: '#f87171',
};

/* ─── Agent Avatar (compact) ─── */

function AgentAvatar({ agent, size = 'sm' }: { agent: Agent; size?: 'sm' | 'md' }) {
  const detailedStatus = useAgentStore((s) => s.agentDetailedStatus);
  const detailed = detailedStatus[agent.id];
  const isWorking = agent.status === 'running' && detailed?.state === 'working';
  const baseRingColor = STATUS_RING_COLOR[agent.status] || STATUS_RING_COLOR.sleeping;
  const ringColor = agent.status === 'running' && detailed?.state === 'needs_permission' ? '#f97316'
    : agent.status === 'running' && detailed?.state === 'tool_error' ? '#facc15'
    : baseRingColor;

  const outerDim = size === 'sm' ? 'w-7 h-7' : 'w-8 h-8';
  const innerDim = size === 'sm' ? 'w-5 h-5 text-[8px]' : 'w-6 h-6 text-[9px]';
  const iconSize = size === 'sm' ? 8 : 10;

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
    <div className={`relative flex-shrink-0 ${isWorking ? 'animate-pulse-ring' : ''}`}>
      <div
        className={`${outerDim} rounded-full flex items-center justify-center`}
        style={{ border: `2px solid ${ringColor}` }}
      >
        {inner}
      </div>
    </div>
  );
}

/* ─── Stat Card ─── */

function StatCard({ label, value, icon, color }: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="flex-1 min-w-0 bg-ctp-mantle border border-surface-0 rounded-xl p-4 flex items-center gap-3">
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: color ? `${color}15` : undefined, color: color || undefined }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold text-ctp-text leading-tight">{value}</div>
        <div className="text-xs text-ctp-subtext0 truncate">{label}</div>
      </div>
    </div>
  );
}

/* ─── Stats Overview ─── */

function StatsOverview() {
  const agents = useAgentStore((s) => s.agents);
  const detailedStatus = useAgentStore((s) => s.agentDetailedStatus);
  const projects = useProjectStore((s) => s.projects);
  const completedAgents = useQuickAgentStore((s) => s.completedAgents);

  const stats = useMemo(() => {
    const allAgents = Object.values(agents);
    let working = 0, attention = 0;
    for (const a of allAgents) {
      if (a.status === 'running') {
        const d = detailedStatus[a.id];
        if (d?.state === 'working') working++;
        if (d?.state === 'needs_permission' || d?.state === 'tool_error') attention++;
      }
      if (a.status === 'error') attention++;
    }

    // Count completed today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    let completedToday = 0;
    for (const records of Object.values(completedAgents)) {
      for (const r of records) {
        if (r.completedAt >= todayMs) completedToday++;
      }
    }

    return { projects: projects.length, working, attention, completedToday };
  }, [agents, detailedStatus, projects, completedAgents]);

  return (
    <div className="grid grid-cols-4 gap-3 mb-6">
      <StatCard
        label="Projects"
        value={stats.projects}
        color="#a78bfa"
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        }
      />
      <StatCard
        label="Working"
        value={stats.working}
        color="#34d399"
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        }
      />
      <StatCard
        label="Attention"
        value={stats.attention}
        color={stats.attention > 0 ? '#fb923c' : '#6c7086'}
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        }
      />
      <StatCard
        label="Done today"
        value={stats.completedToday}
        color="#60a5fa"
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        }
      />
    </div>
  );
}

/* ─── Needs Attention ─── */

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
    <div className="border border-orange-400/30 bg-orange-400/5 rounded-xl overflow-hidden mb-6">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-orange-400/15">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fb923c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="text-sm font-semibold text-orange-300">
          {attentionAgents.length} agent{attentionAgents.length !== 1 ? 's' : ''} need{attentionAgents.length === 1 ? 's' : ''} attention
        </span>
      </div>
      <div className="divide-y divide-orange-400/10">
        {attentionAgents.map(({ agent, reason, projectName }) => (
          <button
            key={agent.id}
            onClick={() => navigateToAgent(agent.projectId, agent.id)}
            className="flex items-center gap-3 px-4 py-2.5 hover:bg-orange-400/5 transition-colors cursor-pointer text-left w-full"
          >
            <AgentAvatar agent={agent} size="sm" />
            <span className="text-sm text-ctp-text font-medium truncate">{agent.name}</span>
            <span className="text-xs text-ctp-subtext0 truncate">{projectName}</span>
            <span className="ml-auto text-xs text-orange-400 flex-shrink-0 font-medium">{reason}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── Project Card (redesigned) ─── */

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
  const detailedStatus = useAgentStore((s) => s.agentDetailedStatus);
  const navigate = useNavigateToProject();
  const navigateToAgent = useNavigateToAgent();

  const agents = useMemo(
    () => Object.values(allAgents).filter((a) => a.projectId === project.id),
    [allAgents, project.id]
  );

  const durableAgents = agents.filter((a) => a.kind === 'durable');
  const quickAgents = agents.filter((a) => a.kind === 'quick');

  const agentSummary = useMemo(() => {
    let working = 0, idle = 0, sleeping = 0, errored = 0;
    for (const a of agents) {
      if (a.status === 'running') {
        const d = detailedStatus[a.id];
        if (d?.state === 'working') working++;
        else idle++;
      } else if (a.status === 'sleeping') sleeping++;
      else if (a.status === 'error') errored++;
    }
    return { working, idle, sleeping, errored, total: agents.length };
  }, [agents, detailedStatus]);

  const statusDots = useMemo(() => {
    const dots: { color: string; pulse: boolean; label: string; count: number }[] = [];
    if (agentSummary.working > 0) dots.push({ color: 'bg-green-400', pulse: true, label: 'working', count: agentSummary.working });
    if (agentSummary.idle > 0) dots.push({ color: 'bg-blue-400', pulse: false, label: 'idle', count: agentSummary.idle });
    if (agentSummary.errored > 0) dots.push({ color: 'bg-red-400', pulse: false, label: 'error', count: agentSummary.errored });
    if (agentSummary.sleeping > 0) dots.push({ color: 'bg-ctp-subtext0/50', pulse: false, label: 'sleeping', count: agentSummary.sleeping });
    return dots;
  }, [agentSummary]);

  return (
    <div className="bg-ctp-mantle border border-surface-0 rounded-xl overflow-hidden hover:border-surface-2 transition-colors">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <button
          onClick={() => navigate.toProject(project.id)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity cursor-pointer"
        >
          <ProjectCardIcon project={project} />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-ctp-text truncate">{project.displayName || project.name}</h3>
            <p className="text-xs text-ctp-subtext0 truncate mt-0.5">{project.path}</p>
          </div>
        </button>

        {/* Status pills */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {statusDots.map((d) => (
            <span
              key={d.label}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-0 text-[10px] text-ctp-subtext1"
              title={`${d.count} ${d.label}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${d.color} ${d.pulse ? 'animate-pulse' : ''}`} />
              {d.count}
            </span>
          ))}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 flex-shrink-0 ml-1">
          <button
            onClick={() => navigate.toHub(project.id)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-1 text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
            title="Open Hub"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </button>
          <button
            onClick={() => navigate.toSettings(project.id)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-1 text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
            title="Project Settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Agent rows */}
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
            quickAgents.length <= 3 ? (
              quickAgents.map((a) => (
                <AgentRow key={a.id} agent={a} navigateToAgent={navigateToAgent} />
              ))
            ) : (
              <div className="px-3 py-2 text-xs text-ctp-subtext0">
                {quickAgents.length} quick session{quickAgents.length !== 1 ? 's' : ''}
              </div>
            )
          )}
        </div>
      )}

      {agents.length === 0 && (
        <div className="border-t border-surface-0 px-5 py-3">
          <span className="text-xs text-ctp-subtext0">No agents yet</span>
        </div>
      )}
    </div>
  );
}

/* ─── Agent Row ─── */

const STATUS_CONFIG: Record<string, { label: string }> = {
  running: { label: 'Running' },
  sleeping: { label: 'Sleeping' },
  error: { label: 'Error' },
};

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

/* ─── Recent Activity ─── */

function RecentActivity() {
  const projects = useProjectStore((s) => s.projects);
  const completedAgents = useQuickAgentStore((s) => s.completedAgents);
  const navigateProject = useNavigateToProject();

  const recentItems = useMemo(() => {
    const all: (CompletedQuickAgent & { projectName: string })[] = [];
    for (const proj of projects) {
      const records = completedAgents[proj.id] || [];
      for (const r of records) {
        all.push({ ...r, projectName: proj.name });
      }
    }
    all.sort((a, b) => b.completedAt - a.completedAt);
    return all.slice(0, 8);
  }, [projects, completedAgents]);

  if (recentItems.length === 0) return null;

  return (
    <div className="mt-8">
      <h2 className="text-sm font-semibold text-ctp-subtext1 uppercase tracking-wider mb-3">Recent Activity</h2>
      <div className="bg-ctp-mantle border border-surface-0 rounded-xl overflow-hidden divide-y divide-surface-0">
        {recentItems.map((item) => (
          <button
            key={item.id}
            onClick={() => navigateProject.toProject(item.projectId)}
            className="flex items-start gap-3 px-4 py-3 hover:bg-surface-0/50 transition-colors cursor-pointer text-left w-full"
          >
            {/* Status icon */}
            <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
              item.cancelled ? 'bg-ctp-subtext0/15 text-ctp-subtext0'
                : item.exitCode === 0 ? 'bg-green-400/15 text-green-400'
                : 'bg-red-400/15 text-red-400'
            }`}>
              {item.cancelled ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ) : item.exitCode === 0 ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-ctp-text font-medium truncate">{item.name}</span>
              </div>
              {item.mission && (
                <p className="text-xs text-ctp-subtext0 truncate mt-0.5">{item.mission}</p>
              )}
              <div className="flex items-center gap-2 mt-1 text-[11px] text-ctp-subtext0">
                <span>{item.projectName}</span>
                <span className="text-surface-2">|</span>
                <span>{formatRelativeTime(item.completedAt)}</span>
                {item.durationMs != null && (
                  <>
                    <span className="text-surface-2">|</span>
                    <span>{formatDuration(item.durationMs)}</span>
                  </>
                )}
                {item.costUsd != null && (
                  <>
                    <span className="text-surface-2">|</span>
                    <span>{formatCost(item.costUsd)}</span>
                  </>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── Empty State ─── */

function EmptyState({ onAddProject }: { onAddProject: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-16 h-16 rounded-2xl bg-surface-0 flex items-center justify-center mb-4">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-subtext0">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h3 className="text-base font-semibold text-ctp-text mb-1">No projects yet</h3>
      <p className="text-sm text-ctp-subtext0 mb-5 max-w-xs">
        Add a project folder to get started with managing agents.
      </p>
      <button
        onClick={onAddProject}
        className="px-4 py-2 rounded-lg bg-ctp-accent text-white text-sm font-medium hover:opacity-90 transition-opacity cursor-pointer"
      >
        Add Project
      </button>
    </div>
  );
}

/* ─── Dashboard ─── */

export function Dashboard() {
  const { projects, pickAndAddProject } = useProjectStore();

  if (projects.length === 0) {
    return (
      <div className="h-full overflow-y-auto p-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-2xl font-bold text-ctp-text mb-1">Home</h1>
          <EmptyState onAddProject={pickAndAddProject} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold text-ctp-text mb-6">Home</h1>

        <StatsOverview />
        <NeedsAttentionBox />

        {/* Projects */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ctp-subtext1 uppercase tracking-wider">Projects</h2>
          <button
            onClick={() => pickAndAddProject()}
            className="text-xs text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer flex items-center gap-1"
          >
            <span className="text-sm leading-none">+</span>
            Add
          </button>
        </div>
        <div className="flex flex-col gap-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>

        <RecentActivity />
      </div>
    </div>
  );
}
