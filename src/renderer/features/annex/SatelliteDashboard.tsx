/**
 * SatelliteDashboard — Home view when a satellite is the active host.
 *
 * Mirrors the local Dashboard layout but shows the satellite's remote
 * projects and agents. This decouples Home from the Canvas plugin so
 * Home always renders useful content regardless of canvas/annex state.
 */
import { useMemo } from 'react';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import {
  useRemoteProjectStore,
  type RemoteProject,
  satellitePrefix,
} from '../../stores/remoteProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { getAgentColorHex } from '../../../shared/name-generator';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { STATUS_RING_COLORS as STATUS_RING_COLOR } from '../agents/status-colors';

// ---------------------------------------------------------------------------
// Remote Agent Avatar
// ---------------------------------------------------------------------------

function RemoteAgentAvatar({ agent, iconDataUrl, detailedStatus }: {
  agent: Agent;
  iconDataUrl?: string;
  detailedStatus?: AgentDetailedStatus;
}) {
  const isWorking = agent.status === 'running' && detailedStatus?.state === 'working';
  const baseRingColor = STATUS_RING_COLOR[agent.status] || STATUS_RING_COLOR.sleeping;
  const ringColor = agent.status === 'running' && detailedStatus?.state === 'needs_permission' ? '#f97316'
    : agent.status === 'running' && detailedStatus?.state === 'tool_error' ? '#facc15'
    : baseRingColor;

  const inner = agent.kind === 'durable' ? (
    (() => {
      if (agent.icon && iconDataUrl) {
        return (
          <div className="w-6 h-6 rounded-full overflow-hidden flex-shrink-0">
            <img src={iconDataUrl} alt={agent.name} className="w-full h-full object-cover" />
          </div>
        );
      }
      const bgHex = getAgentColorHex(agent.color);
      const initials = agent.name.slice(0, 2).toUpperCase();
      return (
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[9px] font-bold"
          style={{ backgroundColor: bgHex }}
        >
          {initials}
        </div>
      );
    })()
  ) : (
    <div className="w-6 h-6 rounded-full bg-surface-2 flex items-center justify-center text-[9px] text-ctp-subtext0 font-bold">
      Q
    </div>
  );

  return (
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${isWorking ? 'animate-pulse' : ''}`}
      style={{ boxShadow: `0 0 0 2px ${ringColor}` }}
    >
      {inner}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Remote Project Card
// ---------------------------------------------------------------------------

function RemoteProjectCard({ project, agents, agentIcons, detailedStatuses, onSelect }: {
  project: RemoteProject;
  agents: Agent[];
  agentIcons: Record<string, string>;
  detailedStatuses: Record<string, AgentDetailedStatus>;
  onSelect: (projectId: string) => void;
}) {
  const runningCount = agents.filter((a) => a.status === 'running').length;
  const sleepingCount = agents.filter((a) => a.status === 'sleeping').length;
  const iconDataUrl = useRemoteProjectStore((s) => s.remoteProjectIcons[project.id]);

  return (
    <div
      className="bg-ctp-mantle border border-surface-0 rounded-xl overflow-hidden hover:border-surface-2 transition-colors cursor-pointer"
      onClick={() => onSelect(project.id)}
      data-testid={`satellite-project-card-${project.id}`}
    >
      {/* Project header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-surface-1 overflow-hidden">
          {iconDataUrl ? (
            <img src={iconDataUrl} alt={project.name} className="w-full h-full object-cover" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-subtext0">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-ctp-text truncate">{project.name}</h3>
          <div className="flex items-center gap-2 text-[11px] text-ctp-subtext0 mt-0.5">
            {runningCount > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
                {runningCount} running
              </span>
            )}
            {sleepingCount > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-ctp-subtext0 inline-block" />
                {sleepingCount} sleeping
              </span>
            )}
            {agents.length === 0 && <span>No agents</span>}
          </div>
        </div>
      </div>

      {/* Agent rows */}
      {agents.length > 0 && (
        <div className="border-t border-surface-0 px-2 py-1.5">
          {agents.slice(0, 5).map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-left w-full"
              data-testid={`satellite-agent-row-${a.id}`}
            >
              <RemoteAgentAvatar
                agent={a}
                iconDataUrl={agentIcons[a.id]}
                detailedStatus={detailedStatuses[a.id]}
              />
              <span className="text-sm text-ctp-text font-medium truncate min-w-0">{a.name}</span>
              <span className="text-xs text-ctp-subtext0 truncate flex-shrink-0">
                {a.status === 'running' && detailedStatuses[a.id]?.message
                  ? detailedStatuses[a.id].message
                  : a.status.charAt(0).toUpperCase() + a.status.slice(1)}
              </span>
            </div>
          ))}
          {agents.length > 5 && (
            <div className="px-3 py-2 text-xs text-ctp-subtext0">
              +{agents.length - 5} more agent{agents.length - 5 !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats Row
// ---------------------------------------------------------------------------

function SatelliteStats({ projects, agents }: {
  projects: RemoteProject[];
  agents: Agent[];
}) {
  const running = agents.filter((a) => a.status === 'running').length;
  const sleeping = agents.filter((a) => a.status === 'sleeping').length;

  const stats = [
    { label: 'Projects', value: projects.length },
    { label: 'Running', value: running },
    { label: 'Sleeping', value: sleeping },
  ];

  return (
    <div className="flex gap-4 mb-6">
      {stats.map((s) => (
        <div key={s.label} className="bg-ctp-mantle border border-surface-0 rounded-xl px-4 py-3 flex-1 min-w-0">
          <div className="text-xl font-bold text-ctp-text">{s.value}</div>
          <div className="text-[11px] text-ctp-subtext0 uppercase tracking-wider mt-0.5">{s.label}</div>
        </div>
      ))}
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
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white flex-shrink-0"
            style={{ backgroundColor: colorHex }}
          >
            {satellite?.icon ? (
              <span className="text-base">{satellite.icon}</span>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            )}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-ctp-text">{satelliteName}</h1>
            <p className="text-xs text-ctp-subtext0">
              {satellite?.state === 'connected' ? 'Connected' : satellite?.state || 'Unknown'}
            </p>
          </div>
        </div>

        <SatelliteStats projects={projects} agents={agents} />

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
                  agentIcons={remoteAgentIcons}
                  detailedStatuses={remoteAgentDetailedStatus}
                  onSelect={handleSelectProject}
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
