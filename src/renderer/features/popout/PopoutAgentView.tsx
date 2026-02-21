import { useEffect, useState, useCallback } from 'react';
import { AgentTerminal } from '../agents/AgentTerminal';

interface PopoutAgentViewProps {
  agentId?: string;
  projectId?: string;
}

type AgentStatus = 'running' | 'sleeping' | 'removed';

export function PopoutAgentView({ agentId, projectId }: PopoutAgentViewProps) {
  const [status, setStatus] = useState<AgentStatus>(agentId ? 'running' : 'removed');

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
    <div className="relative w-full h-full">
      {/* PTY terminal view */}
      <AgentTerminal agentId={agentId} focused />

      {/* Floating control bar */}
      {status === 'running' && (
        <div className="absolute top-2 right-2 z-20">
          <button
            onClick={handleKill}
            className="text-[10px] px-2 py-0.5 rounded backdrop-blur-md bg-red-500/20 text-red-400 hover:bg-red-500/30 shadow-lg"
            data-testid="popout-stop-button"
          >
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
