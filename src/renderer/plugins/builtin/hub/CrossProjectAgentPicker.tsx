import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { PluginAPI, AgentInfo, ProjectInfo, ModelOption } from '../../../../shared/plugin-types';

interface CrossProjectAgentPickerProps {
  api: PluginAPI;
  agents: AgentInfo[];
  onPick: (agentId: string, projectId: string) => void;
}

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

export function CrossProjectAgentPicker({ api, agents, onPick }: CrossProjectAgentPickerProps) {
  const { AgentAvatar } = api.widgets;
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [showQuickForm, setShowQuickForm] = useState(false);
  const [mission, setMission] = useState('');
  const [model, setModel] = useState('default');
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([{ id: 'default', label: 'Default' }]);
  const [spawning, setSpawning] = useState(false);

  const projects = useMemo(() => api.projects.list(), [api]);

  useEffect(() => {
    if (!selectedProject) return;
    api.agents.getModelOptions(selectedProject.id).then(setModelOptions).catch(() => {});
  }, [api, selectedProject]);

  const projectAgents = useMemo(
    () => selectedProject ? agents.filter((a) => a.projectId === selectedProject.id) : [],
    [agents, selectedProject],
  );

  const durableAgents = projectAgents.filter((a) => a.kind === 'durable');
  const quickAgents = projectAgents.filter((a) => a.kind === 'quick' && a.status === 'running');

  const handleResume = useCallback((agent: AgentInfo) => {
    onPick(agent.id, agent.projectId);
    if (agent.status === 'sleeping') {
      api.agents.resume(agent.id).catch(() => {});
    }
  }, [api, onPick]);

  const handleSpawnQuick = useCallback(async () => {
    if (!mission.trim() || spawning || !selectedProject) return;
    setSpawning(true);
    try {
      const agentId = await api.agents.runQuick(mission.trim(), {
        model,
        projectId: selectedProject.id,
      });
      onPick(agentId, selectedProject.id);
      setMission('');
      setShowQuickForm(false);
    } catch (err) {
      api.ui.showError(`Failed to spawn quick agent: ${err}`);
    } finally {
      setSpawning(false);
    }
  }, [api, mission, model, spawning, selectedProject, onPick]);

  const handleBack = useCallback(() => {
    setSelectedProject(null);
    setShowQuickForm(false);
    setMission('');
  }, []);

  // Step 1: Project list
  if (!selectedProject) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="flex flex-col items-center justify-center min-h-full p-4 text-ctp-subtext0">
          <div className="w-full max-w-xs space-y-2">
            <div className="text-xs font-medium text-ctp-subtext1 uppercase tracking-wider mb-2">
              Select a project
            </div>
            {projects.length === 0 ? (
              <div className="text-xs text-ctp-overlay0 text-center py-4">No projects open</div>
            ) : (
              projects.map((p) => {
                const agentCount = agents.filter((a) => a.projectId === p.id).length;
                const color = projectColor(p.name);
                const initials = p.name.slice(0, 2).toUpperCase();
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelectedProject(p)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
                  >
                    <div
                      className="w-7 h-7 rounded-md flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                      style={{ backgroundColor: color }}
                    >
                      {initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-ctp-text truncate">{p.name}</div>
                    </div>
                    {agentCount > 0 && (
                      <span className="text-[10px] text-ctp-overlay0">{agentCount}</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  }

  // Step 2: Agents for selected project
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col items-center justify-center min-h-full p-4 text-ctp-subtext0">
        <div className="w-full max-w-xs space-y-3">
          <button
            onClick={handleBack}
            className="text-[10px] text-ctp-overlay0 hover:text-ctp-text flex items-center gap-1 mb-1"
          >
            &larr; Back
          </button>
          <div className="text-xs font-medium text-ctp-subtext1 uppercase tracking-wider">
            {selectedProject.name}
          </div>

          {durableAgents.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-ctp-overlay0 mb-1">Durable</div>
              {durableAgents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => handleResume(a)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
                >
                  <AgentAvatar agentId={a.id} size="sm" showStatusRing />
                  <span className="text-xs text-ctp-text truncate flex-1">
                    {a.emoji ? `${a.emoji} ` : ''}{a.name}
                  </span>
                  <span className={`text-[10px] ${a.status === 'running' ? 'text-green-400' : a.status === 'error' ? 'text-red-400' : 'text-ctp-overlay0'}`}>
                    {a.status}
                  </span>
                </button>
              ))}
            </div>
          )}

          {quickAgents.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-ctp-overlay0 mb-1">Quick</div>
              {quickAgents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onPick(a.id, a.projectId)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
                >
                  <AgentAvatar agentId={a.id} size="sm" showStatusRing />
                  <span className="text-xs text-ctp-text truncate flex-1">{a.name}</span>
                  <span className="text-[10px] text-green-400">running</span>
                </button>
              ))}
            </div>
          )}

          {durableAgents.length === 0 && quickAgents.length === 0 && (
            <div className="text-xs text-ctp-overlay0 text-center py-2">No agents in this project</div>
          )}

          {showQuickForm ? (
            <div className="space-y-2 pt-2 border-t border-surface-2">
              <textarea
                value={mission}
                onChange={(e) => setMission(e.target.value)}
                placeholder="What should the quick agent do?"
                className="w-full px-3 py-2 bg-surface-0 border border-surface-2 rounded-lg text-xs text-ctp-text placeholder-ctp-overlay0 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
                rows={3}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSpawnQuick();
                }}
              />
              <div className="flex items-center gap-2">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="flex-1 px-2 py-1.5 bg-surface-0 border border-surface-2 rounded text-xs text-ctp-text focus:outline-none"
                >
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <button
                  onClick={handleSpawnQuick}
                  disabled={!mission.trim() || spawning}
                  className="px-3 py-1.5 rounded bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {spawning ? 'Starting...' : 'Start'}
                </button>
              </div>
              <button
                onClick={() => setShowQuickForm(false)}
                className="text-[10px] text-ctp-overlay0 hover:text-ctp-text"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowQuickForm(true)}
              className="w-full px-3 py-2 rounded-lg border border-dashed border-surface-2 text-xs text-ctp-overlay0 hover:text-ctp-text hover:border-ctp-subtext0 transition-colors"
            >
              + Quick Agent
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
