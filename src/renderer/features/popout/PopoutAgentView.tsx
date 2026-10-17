import type { Agent } from '../../../shared/types';
import { AgentView } from '../agents/chat/AgentView';
import { useAgentRuntimeInfo, useChatFlag } from '../agents/chat/AgentRuntimePane';
import { TerminalPaneToolbar } from '../agents/pane/AgentPaneToolbar';
import { SleepingAgent } from '../agents/SleepingAgent';
import { useAgentStore } from '../../stores/agentStore';

interface PopoutAgentViewProps {
  agentId?: string;
  projectId?: string;
}

export function PopoutAgentView({ agentId }: PopoutAgentViewProps) {
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

  return <PopoutAgentBody agent={agent} />;
}

/**
 * The popout's content under its title bar (#2018): ChatView brings its own
 * 32px toolbar; a terminal gets the same toolbar docked above it, so nothing
 * floats over the terminal's Bottom button. Show in main window and Stop or
 * Wake are in the title bar (PopoutAgentActions).
 */
function PopoutAgentBody({ agent }: { agent: Agent }) {
  // Derive display state from the Zustand store — the single source of truth.
  // useAgentStateSync() in PopoutWindow.tsx keeps the store in sync via hook
  // events, PTY exit, broadcasts, and PTY data wake detection.
  const isRunning = agent.status === 'running' || agent.status === 'creating';
  const flag = useChatFlag();
  const runtime = useAgentRuntimeInfo(agent, flag === true);
  // Only once it's known the agent isn't in chat, so the chat toolbar and this one never both show.
  const terminalToolbar = isRunning && flag !== null && runtime !== null && !runtime.chat;

  return (
    <div className="relative w-full h-full flex flex-col" data-testid="popout-agent-view">
      {terminalToolbar && <TerminalPaneToolbar agent={agent} />}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {isRunning ? (
          <AgentView agentId={agent.id} focused context="popout" />
        ) : (
          <SleepingAgent agent={agent} />
        )}
      </div>
    </div>
  );
}
