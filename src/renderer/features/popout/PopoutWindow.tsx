import { useEffect, useState } from 'react';
import { useThemeStore } from '../../stores/themeStore';
import { useAgentStore } from '../../stores/agentStore';
import { PopoutAgentView } from './PopoutAgentView';
import { PopoutHubView } from './PopoutHubView';
import type { Agent, AgentHookEvent } from '../../../shared/types';

/**
 * Set up agent state synchronisation for pop-out windows.
 *
 * 1. Requests the full agent state snapshot from the main window via IPC relay.
 * 2. Subscribes to the same hook-event and pty-exit broadcasts that the main
 *    App component uses, so the pop-out's Zustand store stays in sync.
 */
function useAgentStateSync() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // 1. Fetch snapshot from the main window
    window.clubhouse.window.getAgentState().then((snapshot) => {
      if (cancelled) return;

      const store = useAgentStore.getState();

      // Hydrate agents
      const agents: Record<string, Agent> = {};
      for (const [id, raw] of Object.entries(snapshot.agents)) {
        agents[id] = raw as Agent;
      }
      useAgentStore.setState({
        agents: { ...store.agents, ...agents },
        agentDetailedStatus: snapshot.agentDetailedStatus as any,
        agentIcons: snapshot.agentIcons,
      });

      setReady(true);
    }).catch(() => {
      // If snapshot fails, still mark ready so the popout is usable
      if (!cancelled) setReady(true);
    });

    // 2. Subscribe to hook events (same as App.tsx)
    const removeHookListener = window.clubhouse.agent.onHookEvent(
      (agentId: string, event: {
        kind: string;
        toolName?: string;
        toolInput?: Record<string, unknown>;
        message?: string;
        toolVerb?: string;
        timestamp: number;
      }) => {
        useAgentStore.getState().handleHookEvent(agentId, event as AgentHookEvent);
      },
    );

    // 3. Subscribe to PTY exit events (same as App.tsx, simplified)
    const removeExitListener = window.clubhouse.pty.onExit(
      (agentId: string, exitCode: number) => {
        useAgentStore.getState().updateAgentStatus(agentId, 'sleeping', exitCode);
        // Allow re-detection on next wake
        awokenAgents.delete(agentId);
      },
    );

    // 4. Detect sleeping → running transitions via PTY data.
    //    When an agent is woken from the main window, the pop-out's store still
    //    shows 'sleeping'. Hook events may not arrive promptly (the agent might
    //    be idle at a prompt). PTY data is a reliable signal that the process is
    //    alive, so we use the first data event to transition the status.
    const awokenAgents = new Set<string>();
    const removeDataListener = window.clubhouse.pty.onData(
      (agentId: string) => {
        if (awokenAgents.has(agentId)) return;
        const agent = useAgentStore.getState().agents[agentId];
        if (!agent || agent.status === 'running') {
          awokenAgents.add(agentId);
          return;
        }
        awokenAgents.add(agentId);
        useAgentStore.setState((s) => {
          const a = s.agents[agentId];
          if (!a || a.status === 'running') return s;
          return {
            agents: {
              ...s.agents,
              [agentId]: { ...a, status: 'running', exitCode: undefined, errorMessage: undefined },
            },
            agentSpawnedAt: { ...s.agentSpawnedAt, [agentId]: Date.now() },
          };
        });
      },
    );

    return () => {
      cancelled = true;
      removeHookListener();
      removeExitListener();
      removeDataListener();
    };
  }, []);

  return ready;
}

export function PopoutWindow() {
  const loadTheme = useThemeStore((s) => s.loadTheme);
  const ready = useAgentStateSync();

  useEffect(() => {
    loadTheme();
  }, [loadTheme]);

  const params = window.clubhouse.window?.getPopoutParams();
  if (!params) {
    return (
      <div className="h-screen w-screen bg-ctp-base text-ctp-text flex items-center justify-center">
        <span className="text-ctp-subtext0 text-sm">Invalid pop-out configuration</span>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
      {/* Title bar drag region */}
      <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center">
        <span className="text-xs text-ctp-subtext0 select-none">
          {params.type === 'agent' ? 'Agent' : 'Hub'} — Pop-out
        </span>
      </div>
      {/* Content */}
      <div className="flex-1 min-h-0">
        {!ready ? (
          <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
            Syncing agent state...
          </div>
        ) : params.type === 'agent' ? (
          <PopoutAgentView agentId={params.agentId} projectId={params.projectId} />
        ) : (
          <PopoutHubView hubId={params.hubId} projectId={params.projectId} />
        )}
      </div>
    </div>
  );
}
