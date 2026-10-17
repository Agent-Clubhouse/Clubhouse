import { useCallback } from 'react';
import type { Agent } from '../../../shared/types';
import { AgentView, useAgentInChat } from '../agents/chat/AgentView';
import { SleepingAgent } from '../agents/SleepingAgent';
import { AgentAvatarWithRing } from '../agents/AgentAvatar';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';

interface PopoutAgentViewProps {
  agentId?: string;
  projectId?: string;
}

export function PopoutAgentView({ agentId, projectId }: PopoutAgentViewProps) {
  const agent = useAgentStore((s) => agentId ? s.agents[agentId] : undefined);

  if (!agentId) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-sm">
        No agent specified
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-sm">
        Agent not found
      </div>
    );
  }

  return <PopoutAgentBody agent={agent} projectId={projectId} />;
}

function PopoutAgentBody({ agent, projectId }: { agent: Agent; projectId?: string }) {
  const agentId = agent.id;
  const spawnDurableAgent = useAgentStore((s) => s.spawnDurableAgent);
  const projects = useProjectStore((s) => s.projects);

  const handleKill = useCallback(async () => {
    if (agentId && projectId) {
      await window.clubhouse.agent.killAgent(agentId, projectId);
    } else if (agentId) {
      await window.clubhouse.pty.kill(agentId);
    }
  }, [agentId, projectId]);

  const handleWake = useCallback(async () => {
    if (!agent || agent.kind !== 'durable') return;
    const agentProject = projects.find((p) => p.id === agent.projectId);
    if (!agentProject) return;
    const configs = await window.clubhouse.agent.listDurable(agentProject.path);
    const config = configs.find((c: any) => c.id === agent.id);
    if (config) {
      await spawnDurableAgent(agentProject.id, agentProject.path, config, false);
    }
  }, [agent, projects, spawnDurableAgent]);

  const handleView = useCallback(() => {
    window.clubhouse.window.focusMain(agentId);
  }, [agentId]);

  // Derive display state from the Zustand store — the single source of truth.
  // useAgentStateSync() in PopoutWindow.tsx keeps the store in sync via hook
  // events, PTY exit, broadcasts, and PTY data wake detection.
  const isRunning = agent.status === 'running' || agent.status === 'creating';
  // ChatView has its own header, so the bar sits above it instead of floating over it.
  const inChat = useAgentInChat(agent) && isRunning;

  return (
    <div className="relative w-full h-full flex flex-col" data-testid="popout-agent-view">
      {/* Content area */}
      <div className={`flex-1 min-h-0 overflow-hidden relative ${inChat ? 'order-2' : ''}`}>
        {isRunning ? (
          <AgentView agentId={agentId} focused context="popout" />
        ) : (
          <SleepingAgent agent={agent} />
        )}
      </div>

      {/* Action bar: floating over the terminal, docked above chat */}
      <div className={inChat ? 'order-1 flex-shrink-0 border-b border-surface-0' : 'absolute top-2 left-2 right-2 z-20'} data-testid="popout-action-bar">
        <div className={inChat ? 'flex items-center gap-1.5 bg-ctp-mantle px-2.5 py-1.5' : 'flex items-center gap-1.5 rounded-lg backdrop-blur-md bg-ctp-mantle/95 shadow-lg px-2.5 py-1.5'}>
          <AgentAvatarWithRing agent={agent} />
          <span className="text-[11px] font-medium text-ctp-text truncate" data-testid="popout-agent-name">
            {agent.name}
          </span>
          <div className="flex-1" />
          <div className="flex items-center gap-1 ml-1 flex-shrink-0">
            <button
              onClick={handleView}
              className="text-xs px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text"
              title="View in main window"
              data-testid="popout-view-button"
            >
              View
            </button>
            {isRunning && (
              <button
                onClick={handleKill}
                className="text-xs px-1.5 py-0.5 rounded bg-ctp-error/20 text-ctp-error hover:bg-ctp-error/30"
                title="Stop agent"
                data-testid="popout-stop-button"
              >
                Stop
              </button>
            )}
            {!isRunning && agent.kind === 'durable' && (
              <button
                onClick={handleWake}
                className="text-xs px-1.5 py-0.5 rounded bg-ctp-success/20 text-ctp-success hover:bg-ctp-success/30"
                title="Wake agent"
                data-testid="popout-wake-button"
              >
                Wake
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
