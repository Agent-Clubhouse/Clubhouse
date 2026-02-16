import { useState, useEffect, useCallback, useRef } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { AgentListItem } from './AgentListItem';
import { AddAgentDialog } from './AddAgentDialog';
import { DeleteAgentDialog } from './DeleteAgentDialog';
import { QuickAgentGhostCompact } from '../hub/QuickAgentGhost';
import { MODEL_OPTIONS } from '../../../shared/models';
export function AgentList() {
  const {
    agents, activeAgentId, setActiveAgent,
    spawnQuickAgent, spawnDurableAgent,
    loadDurableAgents, agentActivity, recordActivity,
    deleteDialogAgent,
  } = useAgentStore();
  const { activeProjectId, projects } = useProjectStore();

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
  const missionInputRef = useRef<HTMLInputElement>(null);
  const [, setTick] = useState(0);

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

  const handleQuickAgent = () => {
    setShowDropdown(false);
    setQuickTargetParentId(null);
    setShowMissionInput(true);
  };

  const handleSpawnQuickChild = (durableId: string) => {
    setQuickTargetParentId(durableId);
    setShowMissionInput(true);
  };

  const handleMissionSubmit = async () => {
    if (!activeProject || !mission.trim()) return;
    const selectedModel = quickModel;
    const parentId = quickTargetParentId;
    setShowMissionInput(false);
    try {
      await spawnQuickAgent(activeProject.id, activeProject.path, mission.trim(), selectedModel, parentId || undefined);
    } catch (err) {
      console.error('Failed to spawn quick agent:', err);
    }
    setMission('');
    setQuickModel('default');
    setQuickTargetParentId(null);
  };

  const handleCancelMission = () => {
    setShowMissionInput(false);
    setMission('');
    setQuickModel('default');
    setQuickTargetParentId(null);
  };

  const handleCreateDurable = async (name: string, color: string, model: string, useWorktree: boolean) => {
    if (!activeProject) return;
    setShowDialog(false);
    try {
      const config = await window.clubhouse.agent.createDurable(
        activeProject.path, name, color, model !== 'default' ? model : undefined, useWorktree
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

  // Get the parent durable agent name for the mission input label
  const targetParentAgent = quickTargetParentId ? agents[quickTargetParentId] : null;

  const renderMissionInput = (isNested: boolean) => (
    <div className={`py-2 border-b border-surface-0/50 ${isNested ? 'pl-7 pr-3' : 'px-3'}`}>
      {targetParentAgent && (
        <div className="text-[10px] text-ctp-overlay0 mb-1">
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
        placeholder="What should this agent do?"
        className="w-full px-2 py-1.5 text-xs rounded border border-surface-0
          bg-ctp-base text-ctp-text placeholder:text-ctp-overlay0
          focus:outline-none focus:border-indigo-500"
      />
      <div className="flex gap-1.5 mt-1.5">
        <select
          value={quickModel}
          onChange={(e) => setQuickModel(e.target.value)}
          className="px-1.5 py-1 text-[10px] rounded bg-surface-0 border border-surface-2
            text-ctp-text focus:outline-none focus:border-indigo-500"
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>
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

  if (!activeProject) {
    return (
      <div className="p-3 text-ctp-subtext0 text-sm">
        Select a project to manage agents
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with split button */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
          Agents
        </span>
        <div className="relative flex">
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
          {showDropdown && (
            <div className="absolute right-0 top-full mt-1 bg-ctp-mantle border border-surface-0 rounded-lg shadow-xl py-1 z-50 min-w-[160px]">
              <button
                onClick={handleQuickAgent}
                className="w-full px-3 py-1.5 text-xs text-left text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer flex items-center gap-2"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                Quick Agent
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Close dropdown on outside click */}
      {showDropdown && (
        <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />
      )}

      <div className="flex-1 overflow-y-auto">
        {/* ALL section — durables with their nested children */}
        {durableAgents.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-surface-0/50">
              All
            </div>
            {durableAgents.map((durable) => {
              const childQuick = quickAgents.filter((a) => a.parentAgentId === durable.id);
              const childCompleted = activeProjectId ? getCompletedByParent(activeProjectId, durable.id) : [];
              const isMissionTarget = showMissionInput && quickTargetParentId === durable.id;

              return (
                <div key={durable.id}>
                  <AgentListItem
                    agent={durable}
                    isActive={durable.id === activeAgentId}
                    isThinking={isThinking(durable.id)}
                    onSelect={() => { selectCompleted(null); setActiveAgent(durable.id); }}
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
                      onSelect={() => { selectCompleted(null); setActiveAgent(child.id); }}
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
                      onSelect={() => { setActiveAgent(null); selectCompleted(completed.id); }}
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
                onSelect={() => { selectCompleted(null); setActiveAgent(agent.id); }}
              />
            ))}
          </div>
        )}

        {/* Orphan completed section */}
        {orphanCompleted.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-surface-0/50 flex items-center justify-between">
              <span>Completed</span>
              <button
                onClick={() => activeProjectId && clearCompleted(activeProjectId)}
                className="text-[10px] normal-case tracking-normal text-ctp-overlay0 hover:text-ctp-text cursor-pointer font-normal"
              >
                Clear all
              </button>
            </div>
            {orphanCompleted.map((completed) => (
              <QuickAgentGhostCompact
                key={completed.id}
                completed={completed}
                onDismiss={() => activeProjectId && dismissCompleted(activeProjectId, completed.id)}
                onDelete={() => activeProjectId && dismissCompleted(activeProjectId, completed.id)}
                onSelect={() => { setActiveAgent(null); selectCompleted(completed.id); }}
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
