import { useState, useRef, useEffect } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useHubStore } from '../../stores/hubStore';
import { MODEL_OPTIONS } from '../../../shared/models';
import { AgentAvatarWithRing } from '../agents/AgentAvatar';

interface Props {
  paneId: string;
}

export function AgentPicker({ paneId }: Props) {
  const agents = useAgentStore((s) => s.agents);
  const spawnQuickAgent = useAgentStore((s) => s.spawnQuickAgent);
  const spawnDurableAgent = useAgentStore((s) => s.spawnDurableAgent);
  const { projects, activeProjectId } = useProjectStore();
  const assignAgent = useHubStore((s) => s.assignAgent);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const durableAgents = Object.values(agents).filter(
    (a) => a.kind === 'durable' && a.projectId === activeProjectId
  );

  const handlePickDurable = async (agentId: string) => {
    const agent = agents[agentId];
    if (!agent || !activeProject) return;

    if (agent.status === 'sleeping' || agent.status === 'error') {
      await spawnDurableAgent(agent.projectId, activeProject.path, {
        id: agent.id,
        name: agent.name,
        color: agent.color,
        localOnly: agent.localOnly,
        branch: agent.branch || '',
        worktreePath: agent.worktreePath || '',
        createdAt: '',
      }, true);
    }

    assignAgent(paneId, agentId);
  };

  const [showMissionInput, setShowMissionInput] = useState(false);
  const [mission, setMission] = useState('');
  const [quickModel, setQuickModel] = useState('default');
  const missionInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showMissionInput && missionInputRef.current) {
      missionInputRef.current.focus();
    }
  }, [showMissionInput]);

  const handleSpawnQuick = async () => {
    if (!activeProjectId || !activeProject || !mission.trim()) return;
    const agentId = await spawnQuickAgent(activeProjectId, activeProject.path, mission.trim(), quickModel);
    assignAgent(paneId, agentId);
    setMission('');
    setQuickModel('default');
    setShowMissionInput(false);
  };

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base">
      <div className="w-[280px]">
        <h3 className="text-sm font-semibold text-ctp-text mb-3">Select an agent</h3>

        {durableAgents.length > 0 && (
          <div className="space-y-1 mb-3">
            {durableAgents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => handlePickDurable(agent.id)}
                className="w-full text-left px-3 py-2 rounded-lg border border-surface-0
                  hover:border-surface-2 hover:bg-surface-0 transition-colors cursor-pointer
                  flex items-center gap-3"
              >
                <AgentAvatarWithRing agent={agent} />
                <span className="text-sm text-ctp-text truncate flex-1">{agent.name}</span>
              </button>
            ))}
          </div>
        )}

        {durableAgents.length > 0 && (
          <div className="border-t border-surface-0 my-3" />
        )}

        {showMissionInput ? (
          <div className="space-y-2">
            <input
              ref={missionInputRef}
              type="text"
              value={mission}
              onChange={(e) => setMission(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && mission.trim()) handleSpawnQuick();
                if (e.key === 'Escape') { setShowMissionInput(false); setMission(''); }
              }}
              placeholder="What should this agent do?"
              className="w-full px-3 py-2 text-sm rounded-lg border border-surface-0
                bg-ctp-base text-ctp-text placeholder:text-ctp-overlay0
                focus:outline-none focus:border-indigo-500"
            />
            <div className="flex gap-2">
              <select
                value={quickModel}
                onChange={(e) => setQuickModel(e.target.value)}
                className="px-2 py-1.5 text-xs rounded-lg bg-surface-0 border border-surface-2
                  text-ctp-text focus:outline-none focus:border-indigo-500"
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
              <button
                onClick={handleSpawnQuick}
                disabled={!mission.trim()}
                className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-indigo-500/20 text-indigo-300
                  hover:bg-indigo-500/30 transition-colors cursor-pointer
                  disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Start
              </button>
              <button
                onClick={() => { setShowMissionInput(false); setMission(''); setQuickModel('default'); }}
                className="px-3 py-1.5 text-xs rounded-lg border border-surface-0
                  hover:bg-surface-0 transition-colors cursor-pointer text-ctp-subtext1"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowMissionInput(true)}
            className="w-full text-left px-3 py-2 rounded-lg border border-surface-0
              hover:border-surface-2 hover:bg-surface-0 transition-colors cursor-pointer
              text-sm text-ctp-subtext1 hover:text-ctp-text"
          >
            + Quick Agent
          </button>
        )}
      </div>
    </div>
  );
}
