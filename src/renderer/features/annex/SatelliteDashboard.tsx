/**
 * SatelliteDashboard — Home view when a satellite is the active host.
 *
 * Mirrors the local Dashboard layout but shows the satellite's remote
 * projects and agents. This decouples Home from the Canvas plugin so
 * Home always renders useful content regardless of canvas/annex state.
 */
import { useMemo, useCallback, useState } from 'react';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import {
  useRemoteProjectStore,
  type RemoteProject,
  satellitePrefix,
  parseNamespacedId,
} from '../../stores/remoteProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { useAgentStore } from '../../stores/agentStore';
import { getAgentColorHex } from '../../../shared/name-generator';
import { AgentAvatar } from '../agents/AgentAvatar';
import { STATUS_RING_COLORS as STATUS_RING_COLOR } from '../agents/status-colors';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useNavigateToRemoteAgent() {
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);

  return useCallback(
    (projectId: string, agentId: string) => {
      setActiveProject(projectId);
      setActiveAgent(agentId, projectId);
      setExplorerTab('agents', projectId);
    },
    [setActiveProject, setActiveAgent, setExplorerTab],
  );
}

// ---------------------------------------------------------------------------
// Remote Agent Row (matches local Dashboard AgentRow pattern)
// ---------------------------------------------------------------------------

function RemoteAgentRow({ agent, satelliteId, detailedStatus, iconDataUrl, navigateToAgent }: {
  agent: Agent;
  satelliteId: string;
  detailedStatus?: AgentDetailedStatus;
  iconDataUrl?: string;
  navigateToAgent: (projectId: string, agentId: string) => void;
}) {
  const sendAgentKill = useAnnexClientStore((s) => s.sendAgentKill);
  const sendAgentWake = useAnnexClientStore((s) => s.sendAgentWake);

  const isWorking = agent.status === 'running' && detailedStatus?.state === 'working';
  const baseRingColor = STATUS_RING_COLOR[agent.status] || STATUS_RING_COLOR.sleeping;
  const ringColor = agent.status === 'running' && detailedStatus?.state === 'needs_permission' ? '#f97316'
    : agent.status === 'running' && detailedStatus?.state === 'tool_error' ? '#facc15'
    : baseRingColor;

  const hasDetailed = agent.status === 'running' && detailedStatus;
  const statusLabel = hasDetailed ? detailedStatus.message : agent.status.charAt(0).toUpperCase() + agent.status.slice(1);

  // Extract the original (non-namespaced) agent ID for annex operations
  const parsed = parseNamespacedId(agent.id);
  const originalAgentId = parsed?.agentId || agent.id;

  const isDurable = agent.kind === 'durable';

  const handleStop = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await sendAgentKill(satelliteId, originalAgentId);
  }, [satelliteId, originalAgentId, sendAgentKill]);

  const handleWake = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (agent.status === 'running') return;
    await sendAgentWake(satelliteId, originalAgentId);
  }, [satelliteId, originalAgentId, agent.status, sendAgentWake]);

  const primaryAction = agent.status === 'running'
    ? { id: 'stop', title: 'Stop', icon: <span>{'\u25A0'}</span>, hoverColor: 'hover:text-yellow-400', handler: handleStop }
    : isDurable && (agent.status === 'sleeping' || agent.status === 'error')
      ? { id: 'wake', title: 'Wake', icon: <span>{'\u25B6'}</span>, hoverColor: 'hover:text-green-400', handler: handleWake }
      : null;

  return (
    <div
      onClick={() => navigateToAgent(agent.projectId, agent.id)}
      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-1/60 transition-colors cursor-pointer text-left w-full group"
      data-testid={`satellite-agent-row-${agent.id}`}
    >
      <div className={`relative flex-shrink-0 ${isWorking ? 'animate-pulse-ring' : ''}`}>
        <AgentAvatar agent={agent} size="sm" showRing ringColor={ringColor} iconUrl={iconDataUrl} />
      </div>

      <span className="text-sm text-ctp-text font-medium truncate min-w-0">{agent.name}</span>

      <span
        className={`text-xs truncate flex-shrink-0 ${
          hasDetailed && detailedStatus.state === 'needs_permission'
            ? 'text-orange-400'
            : hasDetailed && detailedStatus.state === 'tool_error'
              ? 'text-red-400'
              : 'text-ctp-subtext0'
        }`}
      >
        {statusLabel}
      </span>

      {/* Inline action buttons */}
      <div className="flex items-center gap-0.5 flex-shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" data-testid="satellite-agent-actions">
        {primaryAction && (
          <button
            onClick={primaryAction.handler}
            title={primaryAction.title}
            className={`w-6 h-6 flex items-center justify-center rounded text-ctp-subtext0 ${primaryAction.hoverColor} hover:bg-surface-1 transition-colors cursor-pointer`}
            data-testid={`satellite-action-${primaryAction.id}`}
          >
            {primaryAction.icon}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Remote Project Card
// ---------------------------------------------------------------------------

function RemoteProjectCard({ project, agents, satelliteId, agentIcons, detailedStatuses, onSelect, navigateToAgent }: {
  project: RemoteProject;
  agents: Agent[];
  satelliteId: string;
  agentIcons: Record<string, string>;
  detailedStatuses: Record<string, AgentDetailedStatus>;
  onSelect: (projectId: string) => void;
  navigateToAgent: (projectId: string, agentId: string) => void;
}) {
  const iconDataUrl = useRemoteProjectStore((s) => s.remoteProjectIcons[project.id]);

  const statusDots = useMemo(() => {
    let working = 0, idle = 0, sleeping = 0, errored = 0;
    for (const a of agents) {
      if (a.status === 'running') {
        const d = detailedStatuses[a.id];
        if (d?.state === 'working') working++;
        else idle++;
      } else if (a.status === 'sleeping') sleeping++;
      else if (a.status === 'error') errored++;
    }
    const dots: { color: string; pulse: boolean; label: string; count: number }[] = [];
    if (working > 0) dots.push({ color: 'bg-green-400', pulse: true, label: 'working', count: working });
    if (idle > 0) dots.push({ color: 'bg-blue-400', pulse: false, label: 'idle', count: idle });
    if (errored > 0) dots.push({ color: 'bg-red-400', pulse: false, label: 'error', count: errored });
    if (sleeping > 0) dots.push({ color: 'bg-ctp-subtext0/50', pulse: false, label: 'sleeping', count: sleeping });
    return dots;
  }, [agents, detailedStatuses]);

  return (
    <div
      className="bg-ctp-mantle border border-surface-0 rounded-xl overflow-hidden hover:border-surface-2 transition-colors"
      data-testid={`satellite-project-card-${project.id}`}
    >
      {/* Project header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <button
          onClick={() => onSelect(project.id)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity cursor-pointer"
        >
          <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-surface-1 overflow-hidden">
            {iconDataUrl ? (
              <img src={iconDataUrl} alt={project.name} className="w-full h-full object-cover" />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-subtext0">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-ctp-text truncate">{project.name}</h3>
            {project.path && (
              <p className="text-xs text-ctp-subtext0 truncate mt-0.5">{project.path}</p>
            )}
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
      </div>

      {/* Agent rows */}
      {agents.length > 0 && (
        <div className="border-t border-surface-0 px-2 py-1.5">
          {agents.slice(0, 5).map((a) => (
            <RemoteAgentRow
              key={a.id}
              agent={a}
              satelliteId={satelliteId}
              detailedStatus={detailedStatuses[a.id]}
              iconDataUrl={agentIcons[a.id]}
              navigateToAgent={navigateToAgent}
            />
          ))}
          {agents.length > 5 && (
            <div className="px-3 py-2 text-xs text-ctp-subtext0">
              +{agents.length - 5} more agent{agents.length - 5 !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}

      {agents.length === 0 && (
        <div className="border-t border-surface-0 px-5 py-3">
          <span className="text-xs text-ctp-subtext0">No agents</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats Row
// ---------------------------------------------------------------------------

function SatelliteStats({ projects, agents, detailedStatuses }: {
  projects: RemoteProject[];
  agents: Agent[];
  detailedStatuses: Record<string, AgentDetailedStatus>;
}) {
  const stats = useMemo(() => {
    let working = 0, attention = 0;
    const sleeping = agents.filter((a) => a.status === 'sleeping').length;
    for (const a of agents) {
      if (a.status === 'running') {
        const d = detailedStatuses[a.id];
        if (d?.state === 'working') working++;
        if (d?.state === 'needs_permission' || d?.state === 'tool_error') attention++;
      }
      if (a.status === 'error') attention++;
    }
    return { projects: projects.length, working, sleeping, attention };
  }, [projects, agents, detailedStatuses]);

  return (
    <div className="grid grid-cols-4 gap-3 mb-6">
      <div className="bg-ctp-mantle border border-surface-0 rounded-xl p-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: '#a78bfa15', color: '#a78bfa' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold text-ctp-text leading-tight">{stats.projects}</div>
          <div className="text-xs text-ctp-subtext0 truncate">Projects</div>
        </div>
      </div>
      <div className="bg-ctp-mantle border border-surface-0 rounded-xl p-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: '#34d39915', color: '#34d399' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold text-ctp-text leading-tight">{stats.working}</div>
          <div className="text-xs text-ctp-subtext0 truncate">Working</div>
        </div>
      </div>
      <div className="bg-ctp-mantle border border-surface-0 rounded-xl p-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: stats.attention > 0 ? '#fb923c15' : '#6c708615', color: stats.attention > 0 ? '#fb923c' : '#6c7086' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold text-ctp-text leading-tight">{stats.attention}</div>
          <div className="text-xs text-ctp-subtext0 truncate">Attention</div>
        </div>
      </div>
      <div className="bg-ctp-mantle border border-surface-0 rounded-xl p-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: '#6c708615', color: '#6c7086' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold text-ctp-text leading-tight">{stats.sleeping}</div>
          <div className="text-xs text-ctp-subtext0 truncate">Sleeping</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SatelliteDashboard
// ---------------------------------------------------------------------------

interface SatelliteDashboardProps {
  activeHostId: string;
}

export function SatelliteDashboard({ activeHostId }: SatelliteDashboardProps) {
  const satellites = useAnnexClientStore((s) => s.satellites);
  const satelliteProjects = useRemoteProjectStore((s) => s.satelliteProjects);
  const remoteAgents = useRemoteProjectStore((s) => s.remoteAgents);
  const remoteAgentDetailedStatus = useRemoteProjectStore((s) => s.remoteAgentDetailedStatus);
  const remoteAgentIcons = useRemoteProjectStore((s) => s.remoteAgentIcons);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);

  const navigateToAgent = useNavigateToRemoteAgent();

  const satellite = satellites.find((s) => s.id === activeHostId);
  const satelliteName = satellite?.alias || 'Remote';
  const colorHex = getAgentColorHex(satellite?.color);

  // Find projects for this satellite — applySatelliteSnapshot keys by satelliteId (= satellite.id)
  const projects = useMemo(() => {
    return satelliteProjects[activeHostId] || [];
  }, [satelliteProjects, activeHostId]);

  // Collect agents belonging to this satellite
  const agents = useMemo(() => {
    const prefix = satellitePrefix(activeHostId);
    return Object.values(remoteAgents).filter((a) => a.id.startsWith(prefix));
  }, [remoteAgents, activeHostId]);

  // Group agents by project
  const agentsByProject = useMemo(() => {
    const map: Record<string, Agent[]> = {};
    for (const a of agents) {
      if (!map[a.projectId]) map[a.projectId] = [];
      map[a.projectId].push(a);
    }
    return map;
  }, [agents]);

  const handleSelectProject = (projectId: string) => {
    setActiveProject(projectId);
  };

  return (
    <div className="h-full overflow-y-auto p-8" data-testid="satellite-dashboard">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center text-white flex-shrink-0"
            style={{ backgroundColor: colorHex }}
          >
            {satellite?.icon ? (
              <span className="text-lg">{satellite.icon}</span>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-ctp-text">{satelliteName}</h1>
              <span className="text-[10px] font-medium text-ctp-peach bg-ctp-peach/10 px-2 py-0.5 rounded-full">
                Remote
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`w-1.5 h-1.5 rounded-full ${satellite?.state === 'connected' ? 'bg-green-400' : 'bg-ctp-subtext0'}`} />
              <p className="text-xs text-ctp-subtext0">
                {satellite?.state === 'connected' ? 'Connected' : satellite?.state || 'Unknown'}
                {satellite?.host && ` \u00B7 ${satellite.host}`}
              </p>
            </div>
          </div>
        </div>

        <SatelliteStats projects={projects} agents={agents} detailedStatuses={remoteAgentDetailedStatus} />

        {/* Projects */}
        {projects.length > 0 && (
          <>
            <h2 className="text-sm font-semibold text-ctp-subtext1 uppercase tracking-wider mb-3">Projects</h2>
            <div className="flex flex-col gap-3">
              {projects.map((p) => (
                <RemoteProjectCard
                  key={p.id}
                  project={p}
                  agents={agentsByProject[p.id] || []}
                  satelliteId={activeHostId}
                  agentIcons={remoteAgentIcons}
                  detailedStatuses={remoteAgentDetailedStatus}
                  onSelect={handleSelectProject}
                  navigateToAgent={navigateToAgent}
                />
              ))}
            </div>
          </>
        )}

        {projects.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-surface-0 flex items-center justify-center mb-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-subtext0">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <h3 className="text-base font-semibold text-ctp-text mb-1">No projects on this satellite</h3>
            <p className="text-sm text-ctp-subtext0">
              Open a project on the remote machine to see it here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
