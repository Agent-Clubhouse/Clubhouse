import { useState, useEffect, useCallback } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { AgentListItem } from './AgentListItem';
import { AddAgentDialog } from './AddAgentDialog';

export function AgentList() {
  const {
    agents, activeAgentId, setActiveAgent,
    spawnQuickAgent, spawnDurableAgent,
    loadDurableAgents, agentActivity, recordActivity,
  } = useAgentStore();
  const { activeProjectId, projects } = useProjectStore();

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const [showDialog, setShowDialog] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
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

  const handleQuickAgent = async () => {
    if (!activeProject) return;
    setShowDropdown(false);
    try {
      await spawnQuickAgent(activeProject.id, activeProject.path);
    } catch (err) {
      console.error('Failed to spawn quick agent:', err);
    }
  };

  const handleCreateDurable = async (name: string, color: string, localOnly: boolean) => {
    if (!activeProject) return;
    setShowDialog(false);
    try {
      const config = await window.clubhouse.agent.createDurable(
        activeProject.path, name, color, localOnly
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
            <div className="absolute right-0 top-full mt-1 bg-ctp-mantle border border-surface-0 rounded-lg shadow-xl py-1 z-50 min-w-[140px]">
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
        {/* Durable agents section */}
        {durableAgents.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-surface-0/50">
              Agents
            </div>
            {durableAgents.map((agent) => (
              <AgentListItem
                key={agent.id}
                agent={agent}
                isActive={agent.id === activeAgentId}
                isThinking={isThinking(agent.id)}
                onSelect={() => setActiveAgent(agent.id)}
              />
            ))}
          </div>
        )}

        {/* Quick agents section */}
        {quickAgents.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-surface-0/50">
              Quick Sessions
            </div>
            {quickAgents.map((agent) => (
              <AgentListItem
                key={agent.id}
                agent={agent}
                isActive={agent.id === activeAgentId}
                isThinking={isThinking(agent.id)}
                onSelect={() => setActiveAgent(agent.id)}
              />
            ))}
          </div>
        )}

        {durableAgents.length === 0 && quickAgents.length === 0 && (
          <div className="p-4 text-ctp-subtext0 text-xs text-center">
            <p className="mb-2">No agents yet</p>
            <p>Click <span className="text-indigo-300">+ Agent</span> to create a durable agent, or use the dropdown for a quick session.</p>
          </div>
        )}
      </div>

      {/* Dialog */}
      {showDialog && (
        <AddAgentDialog
          onClose={() => setShowDialog(false)}
          onCreate={handleCreateDurable}
        />
      )}
    </div>
  );
}
