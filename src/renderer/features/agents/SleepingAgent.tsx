import { Agent } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';

export function SleepingAgent({ agent }: { agent: Agent }) {
  const { spawnDurableAgent } = useAgentStore();
  const { projects } = useProjectStore();
  // Use the agent's own project, not the globally-active project
  const agentProject = projects.find((p) => p.id === agent.projectId);
  const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);

  const handleWake = async () => {
    if (!agentProject) return;
    const configs = await window.clubhouse.agent.listDurable(agentProject.path);
    const config = configs.find((c: any) => c.id === agent.id);
    if (config) {
      await spawnDurableAgent(agentProject.id, agentProject.path, config, true);
    }
  };

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base">
      <div className="flex flex-col items-center gap-6">
        {/* Pixel agent sleeping */}
        <div className="relative">
          <svg width="160" height="160" viewBox="0 0 80 80" className="drop-shadow-lg">
            {/* Body */}
            <rect x="16" y="20" width="48" height="40" rx="8" fill="#c4795b" />
            {/* Head highlight */}
            <rect x="20" y="24" width="40" height="4" rx="2" fill="#d4896b" opacity="0.4" />
            {/* Eyes - closed (sleeping) */}
            <line x1="30" y1="38" x2="35" y2="38" stroke="#2a1f1a" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="45" y1="38" x2="50" y2="38" stroke="#2a1f1a" strokeWidth="2.5" strokeLinecap="round" />
            {/* Legs */}
            <rect x="24" y="60" width="6" height="8" rx="2" fill="#a86a4e" />
            <rect x="34" y="60" width="6" height="8" rx="2" fill="#a86a4e" />
            <rect x="44" y="60" width="6" height="8" rx="2" fill="#a86a4e" />
            {/* Zzz */}
            <text x="60" y="18" fill="#6c7086" fontSize="10" fontWeight="bold" fontFamily="monospace">
              <tspan className="animate-pulse">z</tspan>
            </text>
            <text x="65" y="12" fill="#585b70" fontSize="8" fontWeight="bold" fontFamily="monospace">
              <tspan className="animate-pulse" style={{ animationDelay: '0.3s' }}>z</tspan>
            </text>
            <text x="69" y="7" fill="#45475a" fontSize="6" fontWeight="bold" fontFamily="monospace">
              <tspan className="animate-pulse" style={{ animationDelay: '0.6s' }}>z</tspan>
            </text>
          </svg>
        </div>

        {/* Agent info */}
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            {agent.kind === 'durable' && (
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
              />
            )}
            <h2 className="text-lg font-semibold text-ctp-text">{agent.name}</h2>
          </div>
          <p className="text-sm text-ctp-subtext0 mb-4">
            {agent.status === 'error'
              ? 'Failed to launch — Agent CLI may not be installed or accessible'
              : agent.kind === 'durable'
                ? 'This agent is sleeping'
                : 'Session ended'}
          </p>

          {agent.kind === 'durable' && (
            <button
              onClick={handleWake}
              className="px-5 py-2 text-sm rounded-lg bg-indigo-500 text-white
                hover:bg-indigo-600 cursor-pointer font-medium transition-colors"
            >
              {agent.status === 'error' ? 'Retry' : 'Wake Up'}
            </button>
          )}

          {agent.branch && (
            <p className="text-xs text-ctp-subtext0 mt-3">
              Branch: <span className="font-mono text-ctp-subtext1">{agent.branch}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// Re-export with old name for backwards compatibility during migration
export { SleepingAgent as SleepingClaude };
