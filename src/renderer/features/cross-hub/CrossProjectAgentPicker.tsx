import { useState, useRef, useEffect } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useCrossHubStore } from '../../stores/crossHubStore';
import { useModelOptions } from '../../hooks/useModelOptions';
import { AgentAvatarWithRing } from '../agents/AgentAvatar';

interface Props {
  paneId: string;
}

export function CrossProjectAgentPicker({ paneId }: Props) {
  const agents = useAgentStore((s) => s.agents);
  const spawnQuickAgent = useAgentStore((s) => s.spawnQuickAgent);
  const spawnDurableAgent = useAgentStore((s) => s.spawnDurableAgent);
  const { projects } = useProjectStore();
  const assignAgent = useCrossHubStore((s) => s.assignAgent);
  const pickerProjectId = useCrossHubStore((s) => s.pickerProjectId[paneId]);
  const setPickerProject = useCrossHubStore((s) => s.setPickerProject);
  const clearPickerProject = useCrossHubStore((s) => s.clearPickerProject);

  const selectedProject = pickerProjectId ? projects.find((p) => p.id === pickerProjectId) : null;

  // Step 1: Project list
  if (!selectedProject) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <div className="w-[280px]">
          <h3 className="text-sm font-semibold text-ctp-text mb-3">Select a project</h3>
          <div className="space-y-1">
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => setPickerProject(paneId, project.id)}
                className="w-full text-left px-3 py-2 rounded-lg border border-surface-0
                  hover:border-surface-2 hover:bg-surface-0 transition-colors cursor-pointer
                  flex items-center gap-3"
              >
                <span className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold bg-surface-2 flex-shrink-0">
                  {(project.displayName || project.name).charAt(0).toUpperCase()}
                </span>
                <span className="text-sm text-ctp-text truncate flex-1">{project.displayName || project.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Step 2: Agent list for selected project
  return (
    <AgentListForProject
      paneId={paneId}
      project={selectedProject}
      agents={agents}
      spawnQuickAgent={spawnQuickAgent}
      spawnDurableAgent={spawnDurableAgent}
      assignAgent={assignAgent}
      onBack={() => clearPickerProject(paneId)}
    />
  );
}

function AgentListForProject({
  paneId,
  project,
  agents,
  spawnQuickAgent,
  spawnDurableAgent,
  assignAgent,
  onBack,
}: {
  paneId: string;
  project: { id: string; name: string; path: string; displayName?: string };
  agents: Record<string, import('../../../shared/types').Agent>;
  spawnQuickAgent: (projectId: string, projectPath: string, mission: string, model?: string) => Promise<string>;
  spawnDurableAgent: (projectId: string, projectPath: string, config: import('../../../shared/types').DurableAgentConfig, resume: boolean) => Promise<string>;
  assignAgent: (paneId: string, agentId: string, projectId: string) => void;
  onBack: () => void;
}) {
  const MODEL_OPTIONS = useModelOptions();
  const durableAgents = Object.values(agents)
    .filter((a) => a.kind === 'durable' && a.projectId === project.id);

  const handlePickDurable = async (agentId: string) => {
    const agent = agents[agentId];
    if (!agent) return;

    if (agent.status === 'sleeping' || agent.status === 'error') {
      await spawnDurableAgent(agent.projectId, project.path, {
        id: agent.id,
        name: agent.name,
        color: agent.color,
        branch: agent.branch,
        worktreePath: agent.worktreePath,
        createdAt: '',
      }, true);
    }

    assignAgent(paneId, agentId, project.id);
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
    if (!mission.trim()) return;
    const agentId = await spawnQuickAgent(project.id, project.path, mission.trim(), quickModel);
    assignAgent(paneId, agentId, project.id);
    setMission('');
    setQuickModel('default');
    setShowMissionInput(false);
  };

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base">
      <div className="w-[280px]">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-ctp-subtext0 hover:text-ctp-text mb-3 cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to projects
        </button>
        <h3 className="text-sm font-semibold text-ctp-text mb-3">
          {project.displayName || project.name}
        </h3>

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
