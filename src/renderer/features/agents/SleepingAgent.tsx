import { Agent } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { SleepingMascot } from './SleepingMascots';

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
        {/* Orchestrator-specific sleeping mascot */}
        <div className="relative">
          <SleepingMascot orchestrator={agent.orchestrator} />
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
