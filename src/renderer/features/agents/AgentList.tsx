import { useState, useEffect, useCallback, useRef } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { useUIStore } from '../../stores/uiStore';
import { AgentListItem } from './AgentListItem';
import { AddAgentDialog } from './AddAgentDialog';
import { DeleteAgentDialog } from './DeleteAgentDialog';
import { QuickAgentGhostCompact } from './QuickAgentGhost';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

export function AgentList() {
  const {
    agents, activeAgentId, setActiveAgent,
    spawnQuickAgent, spawnDurableAgent,
    loadDurableAgents, agentActivity, recordActivity,
    deleteDialogAgent, reorderAgents,
  } = useAgentStore();
  const { activeProjectId, projects } = useProjectStore();
  const { options: MODEL_OPTIONS } = useModelOptions();
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledOrchestrators = allOrchestrators.filter((o) => enabled.includes(o.id));

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const completedAgents = useQuickAgentStore((s) =>
    activeProjectId ? s.getCompleted(activeProjectId) : []
  );
  const getCompletedByParent = useQuickAgentStore((s) => s.getCompletedByParent);
  const getCompletedOrphans = useQuickAgentStore((s) => s.getCompletedOrphans);
  const dismissCompleted = useQuickAgentStore((s) => s.dismissCompleted);
  const clearCompleted = useQuickAgentStore((s) => s.clearCompleted);
  const selectCompleted = useQuickAgentStore((s) => s.selectCompleted);
  const [showDialog, setShowDialog] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showMissionInput, setShowMissionInput] = useState(false);
  const [quickTargetParentId, setQuickTargetParentId] = useState<string | null>(null);
  const [mission, setMission] = useState('');
  const [quickModel, setQuickModel] = useState('default');
  const [quickOrchestrator, setQuickOrchestrator] = useState('');
  const [quickFreeAgentMode, setQuickFreeAgentMode] = useState(false);
  const missionInputRef = useRef<HTMLInputElement>(null);
  const dropdownBtnRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);

  // Drag-to-reorder state for durable agents
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Collapsible completed section (persisted in localStorage)
  const [completedCollapsed, setCompletedCollapsed] = useState(() => {
    try {
      return localStorage.getItem('clubhouse_completed_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const toggleCompletedCollapsed = useCallback(() => {
    setCompletedCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('clubhouse_completed_collapsed', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Load durable agents on project switch
  useEffect(() => {
    if (activeProject) {
      loadDurableAgents(activeProject.id, activeProject.path);
    }
  }, [activeProject, loadDurableAgents]);

  // Track activity from pty data
  useEffect(() => {
    const unsub = window.clubhouse.pty.onData((agentId: string) => {
      recordActivity(agentId);
    });
    return unsub;
  }, [recordActivity]);

  // Tick for activity status refresh
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(interval);
  }, []);

  const projectAgents = Object.values(agents).filter(
    (a) => a.projectId === activeProjectId
  );

  const durableAgents = projectAgents.filter((a) => a.kind === 'durable');
  const quickAgents = projectAgents.filter((a) => a.kind === 'quick');
  const orphanQuickAgents = quickAgents.filter((a) => !a.parentAgentId);
  const orphanCompleted = activeProjectId ? getCompletedOrphans(activeProjectId) : [];

  useEffect(() => {
    if (showMissionInput && missionInputRef.current) {
      missionInputRef.current.focus();
    }
  }, [showMissionInput]);

  const openQuickAgentDialog = useUIStore((s) => s.openQuickAgentDialog);

  const handleQuickAgent = () => {
    setShowDropdown(false);
    openQuickAgentDialog();
  };

  const handleSpawnQuickChild = (durableId: string) => {
    setQuickTargetParentId(durableId);
    setShowMissionInput(true);
  };

  const handleMissionSubmit = async () => {
    if (!activeProject || !mission.trim()) return;
    const selectedModel = quickModel;
    const parentId = quickTargetParentId;
    const selectedOrchestrator = quickOrchestrator || undefined;
    const freeMode = quickFreeAgentMode || undefined;
    setShowMissionInput(false);
    try {
      await spawnQuickAgent(activeProject.id, activeProject.path, mission.trim(), selectedModel, parentId || undefined, parentId ? undefined : selectedOrchestrator, freeMode);
    } catch (err) {
      console.error('Failed to spawn quick agent:', err);
    }
    setMission('');
    setQuickModel('default');
    setQuickOrchestrator('');
    setQuickFreeAgentMode(false);
    setQuickTargetParentId(null);
  };

  const handleCancelMission = () => {
    setShowMissionInput(false);
    setMission('');
    setQuickModel('default');
    setQuickOrchestrator('');
    setQuickFreeAgentMode(false);
    setQuickTargetParentId(null);
  };

  const handleCreateDurable = async (name: string, color: string, model: string, useWorktree: boolean, orchestrator?: string, freeAgentMode?: boolean) => {
    if (!activeProject) return;
    setShowDialog(false);
    try {
      const config = await window.clubhouse.agent.createDurable(
        activeProject.path, name, color, model !== 'default' ? model : undefined, useWorktree, orchestrator, freeAgentMode
      );
      await spawnDurableAgent(activeProject.id, activeProject.path, config, false);
    } catch (err) {
      console.error('Failed to create durable agent:', err);
    }
  };

  const isThinking = useCallback((id: string) => {
    const last = agentActivity[id];
    if (!last) return false;
    return Date.now() - last < 3000;
  }, [agentActivity]);

  // Drag-to-reorder handlers for durable agents
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5';
    }
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1';
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }

    const newOrder = [...durableAgents];
    const [moved] = newOrder.splice(dragIndex, 1);
    newOrder.splice(dropIndex, 0, moved);

    if (activeProject) {
      reorderAgents(activeProject.path, newOrder.map((a) => a.id));
    }

    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, durableAgents, activeProject, reorderAgents]);

  // Get the parent durable agent name for the mission input label
  const targetParentAgent = quickTargetParentId ? agents[quickTargetParentId] : null;

  const renderMissionInput = (isNested: boolean) => {
    // Resolve orchestrator for capabilities check
    const resolvedOrchId = isNested
      ? targetParentAgent?.orchestrator || enabledOrchestrators[0]?.id
      : quickOrchestrator || enabledOrchestrators[0]?.id;
    const resolvedOrch = allOrchestrators.find((o) => o.id === resolvedOrchId);
    const supportsPermissions = resolvedOrch?.capabilities?.permissions ?? false;

    return (
      <div className={`py-3 border-b border-surface-0/50 space-y-2 ${isNested ? 'pl-7 pr-3' : 'px-3'}`}>
        {targetParentAgent && (
          <div className="text-[10px] text-ctp-overlay0">
            Quick agent in {targetParentAgent.name}'s worktree
          </div>
        )}
        <input
          ref={missionInputRef}
          type="text"
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && mission.trim()) handleMissionSubmit();
            if (e.key === 'Escape') handleCancelMission();
          }}
          placeholder="What should this quick agent do?"
          className="w-full px-2 py-1.5 text-xs rounded border border-surface-0
            bg-ctp-base text-ctp-text placeholder:text-ctp-overlay0
            focus:outline-none focus:border-indigo-500"
        />
        <div className="flex gap-1.5">
          <select
            value={quickModel}
            onChange={(e) => setQuickModel(e.target.value)}
            className="flex-1 min-w-0 px-1.5 py-1 text-[10px] rounded bg-surface-0 border border-surface-2
              text-ctp-text focus:outline-none focus:border-indigo-500"
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
          {!isNested && enabledOrchestrators.length > 1 && (
            <select
              value={quickOrchestrator || enabledOrchestrators[0]?.id}
              onChange={(e) => setQuickOrchestrator(e.target.value)}
              className="flex-1 min-w-0 px-1.5 py-1 text-[10px] rounded bg-surface-0 border border-surface-2
                text-ctp-text focus:outline-none focus:border-indigo-500"
            >
              {enabledOrchestrators.map((o) => (
                <option key={o.id} value={o.id}>{o.displayName}</option>
              ))}
            </select>
          )}
        </div>
        {/* Free Agent Mode toggle */}
        <label
          className={`flex items-center gap-1.5 ${supportsPermissions ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
          title={supportsPermissions ? 'Skip all permission prompts' : 'Not supported by this orchestrator'}
        >
          <input
            type="checkbox"
            checked={quickFreeAgentMode}
            onChange={(e) => setQuickFreeAgentMode(e.target.checked)}
            disabled={!supportsPermissions}
            className="w-3 h-3 rounded border-surface-2 bg-surface-0 text-red-500 focus:ring-red-500 accent-red-500"
          />
          <span className="text-[10px] text-ctp-subtext0">Free Agent Mode</span>
          {quickFreeAgentMode && supportsPermissions && (
            <span className="text-[10px] text-red-400">skip all permissions</span>
          )}
        </label>
        <div className="flex gap-1.5">
          <button
            onClick={handleMissionSubmit}
            disabled={!mission.trim()}
            className="flex-1 px-2 py-1 text-[10px] rounded bg-indigo-500/20 text-indigo-300
              hover:bg-indigo-500/30 transition-colors cursor-pointer
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Start
          </button>
          <button
            onClick={handleCancelMission}
            className="px-2 py-1 text-[10px] rounded border border-surface-0
              hover:bg-surface-0 transition-colors cursor-pointer text-ctp-subtext1"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  };

  if (!activeProject) {
    return (
      <div className="p-3 text-ctp-subtext0 text-sm">
        Select a project to manage agents
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="agent-list">
      {/* Header with split button */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
          Agents
        </span>
        <div ref={dropdownBtnRef} className="relative flex">
          <button
            onClick={() => setShowDialog(true)}
            className="px-2 py-1 text-xs rounded-l bg-indigo-500/20 text-indigo-300
              hover:bg-indigo-500/30 transition-colors cursor-pointer"
          >
            + Agent
          </button>
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="px-1.5 py-1 text-xs rounded-r bg-indigo-500/20 text-indigo-300
              hover:bg-indigo-500/30 transition-colors cursor-pointer border-l border-indigo-500/30"
          >
            {'\u25BE'}
          </button>
          {showDropdown && (() => {
            const rect = dropdownBtnRef.current?.getBoundingClientRect();
            return (
              <div
                className="fixed bg-ctp-mantle border border-surface-0 rounded-lg shadow-xl py-1 z-50 min-w-[160px]"
                style={rect ? { top: rect.bottom + 4, right: window.innerWidth - rect.right } : undefined}
              >
                <button
                  onClick={() => { setShowDropdown(false); setShowDialog(true); }}
                  className="w-full px-3 py-1.5 text-xs text-left text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer flex items-center gap-2 whitespace-nowrap"
                >
                  <svg className="flex-shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="16" />
                    <line x1="8" y1="12" x2="16" y2="12" />
                  </svg>
                  Durable
                </button>
                <button
                  onClick={handleQuickAgent}
                  className="w-full px-3 py-1.5 text-xs text-left text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer flex items-center gap-2 whitespace-nowrap"
                >
                  <svg className="flex-shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  Quick Agent
                </button>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Close dropdown on outside click */}
      {showDropdown && (
        <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />
      )}

      <div className="flex-1 overflow-y-auto min-h-0" data-testid="agent-list-content">
        {/* ALL section — durables with their nested children */}
        {durableAgents.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-surface-0/50">
              All
            </div>
            {durableAgents.map((durable, i) => {
              const childQuick = quickAgents.filter((a) => a.parentAgentId === durable.id);
              const childCompleted = activeProjectId ? getCompletedByParent(activeProjectId, durable.id) : [];
              const isMissionTarget = showMissionInput && quickTargetParentId === durable.id;

              return (
                <div
                  key={durable.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, i)}
                  onDragEnd={handleDragEnd}
                  onDragOver={(e) => handleDragOver(e, i)}
                  onDrop={(e) => handleDrop(e, i)}
                  className="relative"
                  data-testid={`durable-drag-${i}`}
                  data-agent-id={durable.id}
                >
                  {dragOverIndex === i && dragIndex !== null && dragIndex !== i && (
                    <div data-testid="drag-indicator" className="absolute -top-px left-3 right-3 h-0.5 bg-indigo-500 rounded-full z-10" />
                  )}
                  <AgentListItem
                    agent={durable}
                    isActive={durable.id === activeAgentId}
                    isThinking={isThinking(durable.id)}
                    onSelect={() => { selectCompleted(null); setActiveAgent(durable.id, activeProjectId ?? undefined); }}
                    onSpawnQuickChild={() => handleSpawnQuickChild(durable.id)}
                  />
                  {/* Inline mission input targeting this durable */}
                  {isMissionTarget && renderMissionInput(true)}
                  {/* Child quick agents (indented) */}
                  {childQuick.map((child) => (
                    <AgentListItem
                      key={child.id}
                      agent={child}
                      isActive={child.id === activeAgentId}
                      isThinking={isThinking(child.id)}
                      onSelect={() => { selectCompleted(null); setActiveAgent(child.id, activeProjectId ?? undefined); }}
                      isNested
                    />
                  ))}
                  {/* Child completed ghosts (indented) */}
                  {childCompleted.map((completed) => (
                    <QuickAgentGhostCompact
                      key={completed.id}
                      completed={completed}
                      onDismiss={() => activeProjectId && dismissCompleted(activeProjectId, completed.id)}
                      onDelete={() => activeProjectId && dismissCompleted(activeProjectId, completed.id)}
                      onSelect={() => { setActiveAgent(null, activeProjectId ?? undefined); selectCompleted(completed.id); }}
                      isNested
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {/* Orphan mission input (targeting project root) */}
        {showMissionInput && quickTargetParentId === null && renderMissionInput(false)}

        {/* Orphan Quick Sessions */}
        {orphanQuickAgents.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-surface-0/50">
              Quick Sessions
            </div>
            {orphanQuickAgents.map((agent) => (
              <AgentListItem
                key={agent.id}
                agent={agent}
                isActive={agent.id === activeAgentId}
                isThinking={isThinking(agent.id)}
                onSelect={() => { selectCompleted(null); setActiveAgent(agent.id, activeProjectId ?? undefined); }}
              />
            ))}
          </div>
        )}

        {durableAgents.length === 0 && quickAgents.length === 0 && completedAgents.length === 0 && (
          <div className="p-4 text-ctp-subtext0 text-xs text-center">
            <p className="mb-2">No agents yet</p>
            <p>Click <span className="text-indigo-300">+ Agent</span> to create a durable agent, or use the dropdown for a quick session.</p>
          </div>
        )}
      </div>

      {/* Completed footer — pinned to bottom, expands upward */}
      <div className="flex-shrink-0 border-t border-surface-0" data-testid="completed-footer">
        <div className="px-3 py-1.5 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider flex items-center justify-between">
          <button
            onClick={toggleCompletedCollapsed}
            data-testid="completed-toggle"
            className="flex items-center gap-1 cursor-pointer hover:text-ctp-text transition-colors"
          >
            <svg
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`transition-transform duration-200 ${completedCollapsed ? '' : 'rotate-90'}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span>Completed ({orphanCompleted.length})</span>
          </button>
          {!completedCollapsed && orphanCompleted.length > 0 && (
            <button
              onClick={() => activeProjectId && clearCompleted(activeProjectId)}
              data-testid="completed-clear-all"
              className="text-[10px] normal-case tracking-normal text-ctp-overlay0 hover:text-ctp-text cursor-pointer font-normal"
            >
              Clear all
            </button>
          )}
        </div>
        <div
          data-testid="completed-items"
          className="overflow-hidden transition-[max-height,min-height] duration-300 ease-in-out"
          style={{
            maxHeight: completedCollapsed ? 0 : '33vh',
            minHeight: completedCollapsed ? 0 : (orphanCompleted.length > 0 ? '120px' : 0),
          }}
        >
          <div className="overflow-y-auto pb-2" style={{ maxHeight: '33vh' }}>
            {orphanCompleted.map((completed) => (
              <QuickAgentGhostCompact
                key={completed.id}
                completed={completed}
                onDismiss={() => activeProjectId && dismissCompleted(activeProjectId, completed.id)}
                onDelete={() => activeProjectId && dismissCompleted(activeProjectId, completed.id)}
                onSelect={() => { setActiveAgent(null, activeProjectId ?? undefined); selectCompleted(completed.id); }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Dialogs */}
      {showDialog && (
        <AddAgentDialog
          onClose={() => setShowDialog(false)}
          onCreate={handleCreateDurable}
        />
      )}
      {deleteDialogAgent && <DeleteAgentDialog />}
    </div>
  );
}
