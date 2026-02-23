import { useEffect, useState, useCallback } from 'react';
import { AgentTerminal } from '../agents/AgentTerminal';
import { SleepingAgent } from '../agents/SleepingAgent';
import { AgentAvatarWithRing } from '../agents/AgentAvatar';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';

interface PopoutAgentViewProps {
  agentId?: string;
  projectId?: string;
}

type AgentStatus = 'running' | 'sleeping' | 'removed';

export function PopoutAgentView({ agentId, projectId }: PopoutAgentViewProps) {
  const agent = useAgentStore((s) => agentId ? s.agents[agentId] : undefined);
  const spawnDurableAgent = useAgentStore((s) => s.spawnDurableAgent);
  const projects = useProjectStore((s) => s.projects);

  // Derive initial status from actual agent state
  const [status, setStatus] = useState<AgentStatus>(() => {
    if (!agentId) return 'removed';
    if (agent?.status === 'sleeping' || agent?.status === 'error') return 'sleeping';
    return 'running';
  });

  // Sync status when agent store changes
  useEffect(() => {
    if (!agent) return;
    if (agent.status === 'sleeping' || agent.status === 'error') {
      setStatus('sleeping');
    } else if (agent.status === 'running') {
      setStatus('running');
    }
  }, [agent?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!agentId) return;

    const removeExit = window.clubhouse.pty.onExit((exitAgentId: string) => {
      if (exitAgentId === agentId) {
        setStatus('sleeping');
      }
    });

    const removeHook = window.clubhouse.agent.onHookEvent((hookAgentId: string, event: { kind: string }) => {
      if (hookAgentId === agentId) {
        if (event.kind === 'stop') {
          setStatus('sleeping');
        } else if (status !== 'running') {
          setStatus('running');
        }
      }
    });

    return () => {
      removeExit();
      removeHook();
    };
  }, [agentId, status]);

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
      await spawnDurableAgent(agentProject.id, agentProject.path, config, true);
    }
  }, [agent, projects, spawnDurableAgent]);

  const handleView = useCallback(() => {
    if (agentId) {
      window.clubhouse.window.focusMain(agentId);
    }
  }, [agentId]);

  if (!agentId) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-sm">
        No agent specified
      </div>
    );
  }

  if (status === 'removed') {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-sm">
        Agent has been removed
      </div>
    );
  }

  return (
    <div className="relative w-full h-full flex flex-col" data-testid="popout-agent-view">
      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {status === 'running' ? (
          <AgentTerminal agentId={agentId} focused />
        ) : agent ? (
          <SleepingAgent agent={agent} />
        ) : (
          <div className="flex items-center justify-center h-full text-ctp-subtext0 text-sm">
            Agent not found
          </div>
        )}
      </div>

      {/* Floating action bar */}
      {agent && (
        <div className="absolute top-2 left-2 right-2 z-20">
          <div className="flex items-center gap-1.5 rounded-lg backdrop-blur-md bg-ctp-mantle/95 shadow-lg px-2.5 py-1.5">
            <AgentAvatarWithRing agent={agent} />
            <span className="text-[11px] font-medium text-ctp-text truncate" data-testid="popout-agent-name">
              {agent.name}
            </span>
            <div className="flex-1" />
            <div className="flex items-center gap-1 ml-1 flex-shrink-0">
              <button
                onClick={handleView}
                className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text"
                title="View in main window"
                data-testid="popout-view-button"
              >
                View
              </button>
              {status === 'running' && (
                <button
                  onClick={handleKill}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  title="Stop agent"
                  data-testid="popout-stop-button"
                >
                  Stop
                </button>
              )}
              {status === 'sleeping' && agent.kind === 'durable' && (
                <button
                  onClick={handleWake}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 hover:bg-green-500/30"
                  title="Wake agent"
                  data-testid="popout-wake-button"
                >
                  Wake
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
