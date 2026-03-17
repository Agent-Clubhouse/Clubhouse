import React, { useMemo, useState, useEffect, useCallback } from 'react';
import type { AgentCanvasView as AgentCanvasViewType, CanvasView } from './canvas-types';
import type { PluginAPI, AgentInfo } from '../../../../shared/plugin-types';

interface AgentCanvasViewProps {
  view: AgentCanvasViewType;
  api: PluginAPI;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

export function AgentCanvasView({ view, api, onUpdate }: AgentCanvasViewProps) {
  const isAppMode = api.context.mode === 'app';
  const [agentTick, setAgentTick] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  useEffect(() => {
    const sub = api.agents.onAnyChange(() => setAgentTick((n) => n + 1));
    return () => sub.dispose();
  }, [api]);

  const agents = useMemo(() => api.agents.list(), [api, agentTick]);
  const projects = useMemo(() => api.projects.list(), [api]);
  const assignedAgent = useMemo(
    () => view.agentId ? agents.find((a) => a.id === view.agentId) : null,
    [agents, view.agentId],
  );

  const handlePickAgent = useCallback((agent: AgentInfo) => {
    onUpdate({ agentId: agent.id, projectId: agent.projectId, title: agent.name || agent.id } as Partial<AgentCanvasViewType>);
  }, [onUpdate]);

  const handleBackToProjects = useCallback(() => {
    setSelectedProjectId(null);
  }, []);

  // No agent assigned — show picker
  if (!view.agentId || !assignedAgent) {
    // App mode: two-step picker (project -> agents)
    if (isAppMode && !selectedProjectId) {
      return (
        <div className="flex flex-col h-full p-2">
          <div className="text-xs font-medium text-ctp-subtext1 uppercase tracking-wider mb-2">
            Select a project
          </div>
          <div className="flex-1 overflow-y-auto space-y-1">
            {projects.length === 0 ? (
              <div className="text-xs text-ctp-overlay0 italic">No projects open</div>
            ) : (
              projects.map((p) => {
                const agentCount = agents.filter((a) => a.projectId === p.id).length;
                const color = projectColor(p.name);
                const initials = p.name.slice(0, 2).toUpperCase();
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelectedProjectId(p.id)}
                    className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
                  >
                    <div
                      className="w-6 h-6 rounded-md flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0"
                      style={{ backgroundColor: color }}
                    >
                      {initials}
                    </div>
                    <span className="text-[11px] text-ctp-text truncate flex-1">{p.name}</span>
                    {agentCount > 0 && (
                      <span className="text-[10px] text-ctp-overlay0">{agentCount}</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      );
    }

    // Filter agents by selected project in app mode, or show all in project mode
    // Only show durable agents (no quick agents)
    const filteredAgents = (isAppMode && selectedProjectId
      ? agents.filter((a) => a.projectId === selectedProjectId)
      : agents
    ).filter((a) => a.kind === 'durable');

    const { AgentAvatar } = api.widgets;

    return (
      <div className="flex flex-col h-full p-2">
        {isAppMode && selectedProjectId && (
          <button
            onClick={handleBackToProjects}
            className="text-[10px] text-ctp-overlay0 hover:text-ctp-text flex items-center gap-1 mb-2"
          >
            &larr; Back
          </button>
        )}
        <div className="text-xs font-medium text-ctp-subtext1 uppercase tracking-wider mb-2">
          Assign an agent
        </div>
        <div className="flex-1 overflow-y-auto space-y-1">
          {filteredAgents.length === 0 ? (
            <div className="text-xs text-ctp-overlay0 italic">No agents{isAppMode ? ' in this project' : ' available'}</div>
          ) : (
            filteredAgents.map((agent) => (
              <button
                key={agent.id}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
                onClick={() => handlePickAgent(agent)}
                data-testid={`canvas-agent-pick-${agent.id}`}
              >
                <AgentAvatar agentId={agent.id} size="sm" showStatusRing />
                <span className="text-xs text-ctp-text truncate flex-1">
                  {agent.name || agent.id}
                </span>
                <span className={`text-[10px] ${
                  agent.status === 'running' ? 'text-green-400' :
                  agent.status === 'error' ? 'text-red-400' :
                  'text-ctp-overlay0'
                }`}>{agent.status}</span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  // Agent assigned — show terminal or sleeping widget
  const isRunning = assignedAgent.status === 'running' || assignedAgent.status === 'creating';

  if (isRunning) {
    return React.createElement(api.widgets.AgentTerminal, {
      agentId: view.agentId,
    });
  }

  return React.createElement(api.widgets.SleepingAgent, {
    agentId: view.agentId,
  });
}
