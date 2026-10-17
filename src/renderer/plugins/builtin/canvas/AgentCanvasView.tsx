import React, { useMemo, useState, useEffect, useCallback } from 'react';
import type { AgentCanvasView as AgentCanvasViewType, CanvasView } from './canvas-types';
import type { PluginAPI, AgentInfo } from '../../../../shared/plugin-types';
import { AddAgentDialog } from '../../../features/agents/AddAgentDialog';
import { WidgetPicker, projectRows, type PickerRow, type PickerSection } from './WidgetPicker';
import { StatusDot } from '../../../chrome/sidebar/AgentRow';
import { cardDot, DOT_WORD } from './CanvasView';
import { AgentView } from '../../../features/agents/chat/AgentView';

interface AgentCanvasViewProps {
  view: AgentCanvasViewType;
  api: PluginAPI;
  onUpdate: (updates: Partial<CanvasView>) => void;
  /** Zone theme ID — propagated to the terminal for PTY background updates. */
  zoneThemeId?: string;
  /**
   * LB-M68: Optional callback invoked when the user creates a new agent from
   * inside this card's "+ New Agent" picker. When provided, a NEW sibling
   * card is added to the canvas adjacent to this card with the new agent
   * assigned, and this card stays in picker mode for rapid spawning.
   * If absent, falls back to the legacy behavior of assigning the new agent
   * to the current card.
   */
  onCreateAgentCard?: (parentView: AgentCanvasViewType, agent: AgentInfo) => void;
}

export function AgentCanvasView({ view, api, onUpdate, zoneThemeId, onCreateAgentCard }: AgentCanvasViewProps) {
  const isAppMode = api.context.mode === 'app';
  const [agentTick, setAgentTick] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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

  // New agent: the durable-agent dialog, so the new agent lands in a sibling
  // card (LB-M68). One place to point at the New agent page (#2031) once it
  // can hand the created agent back to the canvas.
  const openNewAgent = useCallback(() => {
    setCreateError(null);
    setShowCreateDialog(true);
  }, []);

  const handleCreateDurable = useCallback(async (
    name: string, color: string, model: string, useWorktree: boolean,
    orchestrator?: string, freeAgentMode?: boolean, mcpIds?: string[], persona?: string,
  ) => {
    const project = activeProjectForCreate;
    if (!project) return;
    setCreateError(null);
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
        persona,
      });
      setShowCreateDialog(false);
      const newAgent = api.agents.list().find((a) => a.id === agentId);
      if (!newAgent) return;
      // LB-M68: prefer creating a sibling card adjacent to this card so the
      // user can see the new agent next to its parent. This card stays in
      // picker mode for rapid spawning. Fall back to assigning to the current
      // card when no callback is wired (e.g. unit tests, popout view).
      if (onCreateAgentCard) {
        onCreateAgentCard(view, newAgent);
      } else {
        handlePickAgent(newAgent);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to create durable agent:', err);
      // Surface the failure in the dialog instead of a silently dead Create
      // button — the previous swallow-to-console left the user with no
      // signal at all (#1564). Keep the dialog open so they can retry.
      setCreateError(message);
    }
  }, [activeProjectForCreate, api.agents, handlePickAgent, onCreateAgentCard, view]);

  // Agent assigned but not yet available in the store (e.g. sleeping durable
  // agent created by a blueprint import, or remote agent that hasn't synced yet).
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
        // the last load (e.g. by a blueprint import).
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
        <span className="text-xs text-ctp-overlay0">Connecting...</span>
      </div>
    );
  }

  // No agent assigned — show the shared picker
  if (!view.agentId) {
    // App mode: two-step picker (project -> agents)
    if (isAppMode && !selectedProjectId) {
      return (
        <WidgetPicker
          searchPlaceholder="Find a project"
          emptyText="No projects open"
          scrollTestId="canvas-agent-picker-scroll"
          sections={[{
            id: 'projects',
            rows: projectRows(projects, setSelectedProjectId, {
              meta: (pid) => {
                const n = agents.filter((a) => a.projectId === pid && a.kind === 'durable').length;
                return n > 0 ? String(n) : undefined;
              },
            }),
          }]}
        />
      );
    }

    // Filter agents by selected project in app mode, or show all in project mode
    // Only show durable agents (no quick agents)
    const filteredAgents = (isAppMode && selectedProjectId
      ? agents.filter((a) => a.projectId === selectedProjectId)
      : agents
    ).filter((a) => a.kind === 'durable');

    const { AgentAvatar } = api.widgets;
    const toRow = (agent: AgentInfo): PickerRow => {
      const dot = cardDot(agent, api.agents.getDetailedStatus(agent.id), null);
      return {
        id: agent.id,
        label: agent.name || agent.id,
        leading: (
          <>
            <StatusDot dot={dot} />
            <AgentAvatar agentId={agent.id} size="2xs" />
          </>
        ),
        meta: DOT_WORD[dot],
        muted: dot === 'sleeping',
        testId: `canvas-agent-pick-${agent.id}`,
        onSelect: () => handlePickAgent(agent),
      };
    };
    const awake = filteredAgents.filter((a) => a.status !== 'sleeping');
    const sleeping = filteredAgents.filter((a) => a.status === 'sleeping');
    const sections: PickerSection[] = [];
    if (awake.length > 0) sections.push({ id: 'awake', rows: awake.map(toRow) });
    if (sleeping.length > 0) sections.push({ id: 'sleeping', label: awake.length > 0 ? 'Sleeping' : undefined, rows: sleeping.map(toRow) });
    const projectName = isAppMode && selectedProjectId ? projects.find((p) => p.id === selectedProjectId)?.name : undefined;

    return (
      <>
        <WidgetPicker
          searchPlaceholder={projectName ? `Find an agent in ${projectName}` : 'Find an agent'}
          emptyText={isAppMode ? 'No agents in this project' : 'No agents available'}
          onBack={isAppMode && selectedProjectId ? handleBackToProjects : undefined}
          backLabel="Projects"
          scrollTestId="canvas-agent-picker-scroll"
          sections={sections}
          footer={{ label: 'New agent', testId: 'canvas-create-agent', onSelect: openNewAgent }}
        />
        {showCreateDialog && activeProjectForCreate && (
          <AddAgentDialog
            onClose={() => { setShowCreateDialog(false); setCreateError(null); }}
            onCreate={handleCreateDurable}
            projectPath={activeProjectForCreate.path}
            error={createError}
          />
        )}
      </>
    );
  }

  // Agent assigned: its live view (chat or terminal), or the sleeping widget
  const isRunning = assignedAgent.status === 'running' || assignedAgent.status === 'creating';

  if (isRunning) {
    return (
      <div className="relative flex flex-col h-full">
        {/* Built-in, so it uses AgentView directly: a canvas card reads a transcript tail and stays quiet for screen readers. */}
        <AgentView agentId={view.agentId!} zoneThemeId={zoneThemeId} context="canvas" />
      </div>
    );
  }

  return React.createElement(api.widgets.SleepingAgent, {
    agentId: view.agentId,
  });
}
