import { Agent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { AGENT_COLORS } from '../../../shared/name-generator';

interface Props {
  agent: Agent;
  isActive: boolean;
  isThinking: boolean;
  onSelect: () => void;
}

const STATUS_CONFIG: Record<string, { label: string; dotClass: string }> = {
  running: { label: 'Running', dotClass: 'bg-green-400' },
  sleeping: { label: 'Sleeping', dotClass: 'bg-yellow-400' },
  stopped: { label: 'Stopped', dotClass: 'bg-ctp-subtext0' },
  error: { label: 'Error', dotClass: 'bg-red-400' },
};

export function AgentListItem({ agent, isActive, isThinking, onSelect }: Props) {
  const { killAgent, removeAgent, deleteDurableAgent, spawnDurableAgent } = useAgentStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);
  const statusInfo = STATUS_CONFIG[agent.status] || STATUS_CONFIG.stopped;

  const handleAction = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (agent.status === 'running') {
      await killAgent(agent.id);
    } else if (agent.kind === 'quick') {
      removeAgent(agent.id);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activeProject) return;
    await deleteDurableAgent(agent.id, activeProject.path);
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
        flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors
        ${isActive ? 'bg-surface-1' : 'hover:bg-surface-0'}
      `}
    >
      {/* Avatar */}
      {isDurable ? (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
          style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
        >
          {agent.name.split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
        </div>
      ) : (
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs flex-shrink-0 bg-surface-2 text-ctp-subtext0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4z" />
            <path d="M6 20v-1c0-2.21 2.69-4 6-4s6 1.79 6 4v1" />
            <line x1="1" y1="1" x2="23" y2="23" opacity="0.4" />
          </svg>
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-ctp-text truncate font-medium">{agent.name}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusInfo.dotClass} ${
            isThinking ? 'animate-pulse' : ''
          }`} />
          <span className="text-xs text-ctp-subtext0">
            {isThinking ? 'Thinking...' : statusInfo.label}
          </span>
          {agent.status === 'stopped' && agent.exitCode !== undefined && (
            <span className="text-xs text-ctp-subtext0">· exit {agent.exitCode}</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
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
