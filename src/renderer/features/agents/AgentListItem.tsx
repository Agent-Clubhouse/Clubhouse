import { useState, useRef, useEffect } from 'react';
import { Agent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { AGENT_COLORS } from '../../../shared/name-generator';

interface Props {
  agent: Agent;
  isActive: boolean;
  isThinking: boolean;
  onSelect: () => void;
  onSpawnQuickChild?: () => void;
  isNested?: boolean;
}

const STATUS_CONFIG: Record<string, { label: string }> = {
  running: { label: 'Running' },
  sleeping: { label: 'Sleeping' },
  error: { label: 'Error' },
};

const STATUS_RING_COLOR: Record<string, string> = {
  running: '#22c55e',
  sleeping: '#6c7086',
  error: '#f87171',
};

export function AgentListItem({ agent, isActive, isThinking, onSelect, onSpawnQuickChild, isNested }: Props) {
  const { killAgent, removeAgent, spawnDurableAgent, openAgentSettings, openDeleteDialog, renameAgent, agentDetailedStatus } = useAgentStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(agent.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleRenameStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(agent.name);
    setIsEditing(true);
  };

  const handleRenameConfirm = async () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== agent.name && activeProject) {
      await renameAgent(agent.id, trimmed, activeProject.path);
    }
    setIsEditing(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditValue(agent.name);
      setIsEditing(false);
    }
  };

  const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);
  const statusInfo = STATUS_CONFIG[agent.status] || STATUS_CONFIG.sleeping;
  const detailed = agentDetailedStatus[agent.id];
  const baseRingColor = STATUS_RING_COLOR[agent.status] || STATUS_RING_COLOR.sleeping;
  const ringColor = agent.status === 'running' && detailed?.state === 'needs_permission' ? '#f97316'
    : agent.status === 'running' && detailed?.state === 'tool_error' ? '#facc15'
    : baseRingColor;

  // Determine what to display for status
  const hasDetailed = agent.status === 'running' && detailed;
  const isWorking = hasDetailed ? detailed.state === 'working' : isThinking;
  const statusLabel = hasDetailed ? detailed.message : (isThinking ? 'Thinking...' : statusInfo.label);

  const handleAction = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (agent.status === 'running') {
      await killAgent(agent.id);
    } else if (agent.kind === 'quick') {
      removeAgent(agent.id);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    openDeleteDialog(agent.id);
  };

  const handleWake = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activeProject || agent.status === 'running') return;
    const configs = await window.clubhouse.agent.listDurable(activeProject.path);
    const config = configs.find((c: any) => c.id === agent.id);
    if (config) {
      await spawnDurableAgent(activeProject.id, activeProject.path, config, true);
    }
  };

  const isDurable = agent.kind === 'durable';

  return (
    <div
      onClick={onSelect}
      className={`
        flex items-center gap-3 py-2.5 cursor-pointer transition-colors
        ${isNested ? 'pl-7 pr-3' : 'px-3'}
        ${isActive ? 'bg-surface-1' : 'hover:bg-surface-0'}
      `}
    >
      {/* Avatar with status ring */}
      <div className={`flex-shrink-0 ${isWorking ? 'animate-pulse-ring' : ''}`}>
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ border: `2px solid ${ringColor}` }}
        >
          {isDurable ? (
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
              style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
            >
              {agent.name.split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
            </div>
          ) : (
            <div className="w-7 h-7 rounded-full flex items-center justify-center bg-surface-2 text-ctp-subtext0">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {isEditing ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleRenameConfirm}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="text-sm text-ctp-text font-medium bg-surface-0 border border-surface-2 rounded px-1 py-0 outline-none focus:border-ctp-blue w-full"
            />
          ) : (
            <span className="text-sm text-ctp-text truncate font-medium">{agent.name}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className={`text-xs truncate ${
            hasDetailed && detailed.state === 'needs_permission' ? 'text-orange-400' :
            hasDetailed && detailed.state === 'tool_error' ? 'text-red-400' :
            'text-ctp-subtext0'
          }`}>
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {isDurable && onSpawnQuickChild && (
          <button
            onClick={(e) => { e.stopPropagation(); onSpawnQuickChild(); }}
            title="Spawn quick agent in worktree"
            className="text-xs text-ctp-subtext0 hover:text-yellow-400 transition-colors px-1 cursor-pointer"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </button>
        )}
        {isDurable && (
          <button
            onClick={handleRenameStart}
            title="Rename agent"
            className="text-xs text-ctp-subtext0 hover:text-ctp-blue transition-colors px-1 cursor-pointer"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              <path d="m15 5 4 4" />
            </svg>
          </button>
        )}
        {isDurable && (
          <button
            onClick={(e) => { e.stopPropagation(); openAgentSettings(agent.id); }}
            title="Agent settings"
            className="text-xs text-ctp-subtext0 hover:text-ctp-blue transition-colors px-1 cursor-pointer"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
        {isDurable && agent.status === 'sleeping' && (
          <button
            onClick={handleWake}
            title="Wake agent"
            className="text-xs text-ctp-subtext0 hover:text-green-400 transition-colors px-1 cursor-pointer"
          >
            {'\u25B6'}
          </button>
        )}
        {agent.status === 'running' && (
          <button
            onClick={handleAction}
            title="Stop agent"
            className="text-xs text-ctp-subtext0 hover:text-yellow-400 transition-colors px-1 cursor-pointer"
          >
            {'\u25A0'}
          </button>
        )}
        {isDurable && agent.status !== 'running' && (
          <button
            onClick={handleDelete}
            title="Delete agent"
            className="text-xs text-ctp-subtext0 hover:text-red-400 transition-colors px-1 cursor-pointer"
          >
            {'\u2715'}
          </button>
        )}
        {!isDurable && agent.status !== 'running' && (
          <button
            onClick={handleAction}
            title="Remove"
            className="text-xs text-ctp-subtext0 hover:text-red-400 transition-colors px-1 cursor-pointer"
          >
            {'\u2715'}
          </button>
        )}
      </div>
    </div>
  );
}
