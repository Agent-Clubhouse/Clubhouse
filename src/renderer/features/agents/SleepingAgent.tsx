import { useCallback, useEffect, useRef, useState } from 'react';
import { Agent } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { SleepingMascot } from './SleepingMascots';
import { SessionPickerDialog } from './SessionPickerDialog';

export function SleepingAgent({ agent }: { agent: Agent }) {
  const { spawnDurableAgent } = useAgentStore();
  const { projects } = useProjectStore();
  // Use the agent's own project, not the globally-active project
  const agentProject = projects.find((p) => p.id === agent.projectId);
  const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const handleWake = useCallback(async () => {
    if (!agentProject) return;
    const configs = await window.clubhouse.agent.listDurable(agentProject.path);
    const config = configs.find((c: any) => c.id === agent.id);
    if (config) {
      await spawnDurableAgent(agentProject.id, agentProject.path, config, false);
    }
  }, [agentProject, agent.id, spawnDurableAgent]);

  const handleWakeAndResume = useCallback(async () => {
    if (!agentProject) return;
    setDropdownOpen(false);
    const configs = await window.clubhouse.agent.listDurable(agentProject.path);
    const config = configs.find((c: any) => c.id === agent.id);
    if (config) {
      await spawnDurableAgent(agentProject.id, agentProject.path, config, true);
    }
  }, [agentProject, agent.id, spawnDurableAgent]);

  const handleBrowseSessions = useCallback(() => {
    setDropdownOpen(false);
    setSessionPickerOpen(true);
  }, []);

  const handleResumeSession = useCallback(async (sessionId: string) => {
    if (!agentProject) return;
    setSessionPickerOpen(false);
    const configs = await window.clubhouse.agent.listDurable(agentProject.path);
    const config = configs.find((c: any) => c.id === agent.id);
    if (config) {
      // Override lastSessionId for this spawn
      const configWithSession = { ...config, lastSessionId: sessionId };
      await spawnDurableAgent(agentProject.id, agentProject.path, configWithSession, true);
    }
  }, [agentProject, agent.id, spawnDurableAgent]);

  // Close dropdown on outside click or Escape
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [dropdownOpen]);

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
          <p className="text-sm text-ctp-subtext0 mb-1">
            {agent.status === 'error'
              ? 'Failed to launch'
              : agent.kind === 'durable'
                ? 'This agent is sleeping'
                : 'Session ended'}
          </p>
          {agent.status === 'error' && (
            <p className="text-xs text-ctp-subtext0 mb-4 max-w-xs">
              {agent.errorMessage || 'Check that the CLI is installed and your API key is configured'}
            </p>
          )}
          {agent.status !== 'error' && <div className="mb-4" />}

          {agent.kind === 'durable' && (
            <div className="relative inline-flex" ref={dropdownRef}>
              {/* Main wake button */}
              <button
                onClick={handleWake}
                data-testid="wake-button"
                className="px-5 py-2 text-sm rounded-l-lg bg-indigo-500 text-white
                  hover:bg-indigo-600 cursor-pointer font-medium transition-colors"
              >
                {agent.status === 'error' ? 'Retry' : 'Wake Up'}
              </button>
              {/* Dropdown arrow */}
              <button
                onClick={() => setDropdownOpen((v) => !v)}
                data-testid="wake-dropdown-toggle"
                className="px-2 py-2 text-sm rounded-r-lg bg-indigo-500 text-white
                  hover:bg-indigo-600 cursor-pointer transition-colors border-l border-indigo-400"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {/* Dropdown menu */}
              {dropdownOpen && (
                <div
                  data-testid="wake-dropdown-menu"
                  className="absolute top-full mt-1 left-0 right-0 min-w-[180px] py-1 rounded-lg shadow-xl border border-surface-1 bg-ctp-mantle z-50"
                >
                  <button
                    onClick={handleWakeAndResume}
                    data-testid="wake-resume-option"
                    className="w-full px-3 py-1.5 text-xs text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors cursor-pointer text-left"
                  >
                    Wake &amp; Resume
                  </button>
                  <button
                    onClick={handleBrowseSessions}
                    data-testid="browse-sessions-option"
                    className="w-full px-3 py-1.5 text-xs text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors cursor-pointer text-left"
                  >
                    Browse Sessions...
                  </button>
                </div>
              )}
            </div>
          )}

          {agent.branch && (
            <p className="text-xs text-ctp-subtext0 mt-3">
              Branch: <span className="font-mono text-ctp-subtext1">{agent.branch}</span>
            </p>
          )}
        </div>
      </div>

      {/* Session picker dialog */}
      {sessionPickerOpen && agentProject && (
        <SessionPickerDialog
          agentId={agent.id}
          projectPath={agentProject.path}
          orchestrator={agent.orchestrator}
          onResume={handleResumeSession}
          onClose={() => setSessionPickerOpen(false)}
        />
      )}
    </div>
  );
}

// Re-export with old name for backwards compatibility during migration
export { SleepingAgent as SleepingClaude };
