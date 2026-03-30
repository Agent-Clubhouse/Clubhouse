import React, { useMemo, useState, useEffect, useCallback } from 'react';
import type { AgentCanvasView as AgentCanvasViewType, CanvasView } from './canvas-types';
import type { PluginAPI, AgentInfo } from '../../../../shared/plugin-types';
import { AddAgentDialog } from '../../../features/agents/AddAgentDialog';

interface AgentCanvasViewProps {
  view: AgentCanvasViewType;
  api: PluginAPI;
  onUpdate: (updates: Partial<CanvasView>) => void;
  /** Zone theme ID — propagated to the terminal for PTY background updates. */
  zoneThemeId?: string;
}

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

export function AgentCanvasView({ view, api, onUpdate, zoneThemeId }: AgentCanvasViewProps) {
  const isAppMode = api.context.mode === 'app';
  const [agentTick, setAgentTick] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

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
    const project = projects.find((p) => p.id === agent.projectId);
    const name = agent.name || agent.id;
    onUpdate({
      agentId: agent.id,
      projectId: agent.projectId,
      title: name,
      displayName: name,
      metadata: {
        agentId: agent.id,
        projectId: agent.projectId ?? null,
        agentName: agent.name ?? null,
        projectName: project?.name ?? null,
        orchestrator: agent.orchestrator ?? null,
        model: agent.model ?? null,
      },
    } as Partial<AgentCanvasViewType>);
  }, [onUpdate, projects]);

  // Keep metadata in sync when the assigned agent's searchable properties change
  useEffect(() => {
    if (!assignedAgent) return;
    const project = projects.find((p) => p.id === assignedAgent.projectId);
    const prev = view.metadata;
    const next = {
      agentId: assignedAgent.id,
      projectId: assignedAgent.projectId ?? null,
      agentName: assignedAgent.name ?? null,
      projectName: project?.name ?? null,
      orchestrator: assignedAgent.orchestrator ?? null,
      model: assignedAgent.model ?? null,
    };
    // Only update if something actually changed to avoid loops
    const changed = Object.keys(next).some(
      (k) => prev[k] !== next[k as keyof typeof next],
    );
    if (changed) {
      onUpdate({ metadata: next } as Partial<AgentCanvasViewType>);
    }
  }, [assignedAgent, projects, view.metadata, onUpdate]);

  const handleBackToProjects = useCallback(() => {
    setSelectedProjectId(null);
  }, []);

  // Resolve the active project for agent creation
  const activeProjectForCreate = useMemo(() => {
    const pid = isAppMode ? selectedProjectId : api.context.projectId;
    if (!pid) return null;
    return projects.find((p) => p.id === pid) ?? null;
  }, [isAppMode, selectedProjectId, api.context.projectId, projects]);

  const handleCreateDurable = useCallback(async (
    name: string, color: string, model: string, useWorktree: boolean,
    orchestrator?: string, freeAgentMode?: boolean, mcpIds?: string[],
  ) => {
    const project = activeProjectForCreate;
    if (!project) return;
    setShowCreateDialog(false);
    try {
      const agentId = await api.agents.createDurable({
        projectId: project.id,
        name,
        color,
        model,
        useWorktree,
        orchestrator,
        freeAgentMode,
        mcpIds,
      });
      // Auto-assign the newly created agent to this canvas view
      const newAgent = api.agents.list().find((a) => a.id === agentId);
      if (newAgent) {
        handlePickAgent(newAgent);
      }
    } catch (err) {
      console.error('Failed to create durable agent:', err);
    }
  }, [activeProjectForCreate, api.agents, handlePickAgent]);

  // Agent assigned but not yet available in the store (e.g. sleeping durable
  // agent created by the assistant, or remote agent that hasn't synced yet).
  // Trigger loadDurableAgents so the store picks up the agent and subsequent
  // renders can show SleepingAgent or AgentTerminal properly.
  const [agentFetchTriggered, setAgentFetchTriggered] = useState(false);
  useEffect(() => {
    if (!view.agentId || assignedAgent || agentFetchTriggered) return;
    setAgentFetchTriggered(true);
    const projectId = view.projectId || (view.metadata as any)?.projectId;
    if (projectId) {
      const project = api.projects.list().find((p) => p.id === projectId);
      if (project) {
        // Trigger the agent store to reload durables for this project.
        // This adds sleeping agents that may have been created since
        // the last load (e.g. by the assistant via create_agent MCP tool).
        import('../../../stores/agentStore').then(({ useAgentStore }) => {
          useAgentStore.getState().loadDurableAgents(project.id, project.path);
        }).catch(() => { /* ignore — dynamic import failure */ });
      }
    }
  }, [view.agentId, assignedAgent, agentFetchTriggered, view.projectId, view.metadata, api.projects]);

  if (view.agentId && !assignedAgent) {
    const name = view.displayName || view.title || view.agentId;
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-4">
        <div className="w-8 h-8 rounded-full bg-surface-1 animate-pulse" />
        <span className="text-xs text-ctp-subtext0 truncate max-w-full">{name}</span>
        <span className="text-[10px] text-ctp-overlay0">Connecting...</span>
      </div>
    );
  }

  // No agent assigned — show picker
  if (!view.agentId) {
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
                  agent.status === 'running' ? 'text-ctp-success' :
                  agent.status === 'error' ? 'text-ctp-error' :
                  'text-ctp-overlay0'
                }`}>{agent.status}</span>
              </button>
            ))
          )}
        </div>
        <button
          onClick={() => setShowCreateDialog(true)}
          data-testid="canvas-create-agent"
          className="w-full mt-2 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg
            bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 transition-colors text-xs cursor-pointer"
        >
          + New Agent
        </button>
        {showCreateDialog && activeProjectForCreate && (
          <AddAgentDialog
            onClose={() => setShowCreateDialog(false)}
            onCreate={handleCreateDurable}
            projectPath={activeProjectForCreate.path}
          />
        )}
      </div>
    );
  }

  // Agent assigned — show terminal or sleeping widget
  const isRunning = assignedAgent.status === 'running' || assignedAgent.status === 'creating';

  if (isRunning) {
    return (
      <div className="relative flex flex-col h-full">
        {React.createElement(api.widgets.AgentTerminal, {
          agentId: view.agentId,
          zoneThemeId,
        })}
      </div>
    );
  }

  return React.createElement(api.widgets.SleepingAgent, {
    agentId: view.agentId,
  });
}
