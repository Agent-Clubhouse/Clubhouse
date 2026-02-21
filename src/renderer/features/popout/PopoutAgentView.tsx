import { useEffect, useState, useCallback } from 'react';

interface PopoutAgentViewProps {
  agentId?: string;
  projectId?: string;
}

type AgentStatus = 'running' | 'sleeping' | 'removed';

export function PopoutAgentView({ agentId, projectId }: PopoutAgentViewProps) {
  const [status, setStatus] = useState<AgentStatus>(agentId ? 'running' : 'removed');
  const [agentName] = useState(agentId || 'Agent');

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
      {/* Terminal area — agents run through PTY, the terminal component is
          provided by the plugin API (AgentTerminal widget). Since pop-out windows
          don't have the full plugin context, we render a lightweight terminal
          view that listens to PTY data. */}
      <div className="w-full h-full bg-ctp-crust flex items-center justify-center">
        <span className="text-ctp-subtext0 text-xs">
          {status === 'running' ? `Agent "${agentName}" is running...` : `Agent "${agentName}" has stopped.`}
        </span>
      </div>

      {/* Floating control bar */}
      <div className="absolute top-2 left-2 right-2 z-20">
        <div className="flex items-center gap-2 rounded-lg backdrop-blur-md bg-ctp-mantle/90 shadow-lg px-3 py-2">
          <span className="text-xs font-medium text-ctp-text truncate flex-1">
            {agentName}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            status === 'running' ? 'bg-green-500/20 text-green-400' : 'bg-ctp-surface0 text-ctp-subtext0'
          }`}>
            {status}
          </span>
          {status === 'running' && (
            <button
              onClick={handleKill}
              className="text-[10px] px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
              data-testid="popout-stop-button"
            >
              Stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
