import type { Agent } from '../../../shared/types';
import { AgentView } from '../agents/chat/AgentView';
import { useAgentRuntimeInfo, useChatFlag } from '../agents/chat/AgentRuntimePane';
import { TerminalPaneToolbar } from '../agents/pane/AgentPaneToolbar';
import { SleepingAgent } from '../agents/SleepingAgent';
import { HeadlessAgentView } from '../agents/HeadlessAgentView';
import { useAgentStore } from '../../stores/agentStore';
import { Button } from '../../components/Button';
import { isDispatcherProjectId, useDispatcherStore } from '../dispatcher/dispatcherStore';

interface PopoutAgentViewProps {
  agentId?: string;
  projectId?: string;
}

export function PopoutAgentView({ agentId, projectId }: PopoutAgentViewProps) {
  const agent = useAgentStore((s) => agentId ? s.agents[agentId] : undefined);

  if (agentId && isDispatcherProjectId(projectId)) return <PopoutDispatcherView agentId={agentId} />;

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

  // A headless run has no terminal: show its monitor, stacked (#2019). Stop and
  // Show in main window are in the popout's title bar.
  if (agent.kind === 'quick' && agent.headless) {
    return (
      <div className="w-full h-full" data-testid="popout-agent-view">
        <HeadlessAgentView agent={agent} stacked />
      </div>
    );
  }

  return <PopoutAgentBody agent={agent} />;
}

function PopoutMessage({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 h-full text-ctp-subtext0 text-sm" data-testid="popout-dispatcher-message">
      <p role="status" className="max-w-md text-center">{children}</p>
      {action}
    </div>
  );
}

/**
 * The Dispatcher's chat in its own window (#3235): the same agent and
 * conversation as its view in the main window, which loads it. Setup and
 * settings stay in the main window.
 */
function PopoutDispatcherView({ agentId }: { agentId: string }) {
  const agent = useAgentStore((s) => s.agents[agentId]);
  const state = useDispatcherStore((s) => s.state);
  const on = useDispatcherStore((s) => !!s.project);

  if (!state) return <PopoutMessage>Loading the Dispatcher</PopoutMessage>;
  if (!on && !agent) return <PopoutMessage>The Dispatcher is turned off.</PopoutMessage>;
  if (state.config && state.setup?.status === 'pending') {
    return (
      <PopoutMessage action={<Button onClick={() => { void window.clubhouse.window.focusMain(agentId, 'dispatcher-setup'); }} data-testid="popout-dispatcher-setup">Open setup</Button>}>
        Finish setting up the Dispatcher in the main window.
      </PopoutMessage>
    );
  }
  if (!agent) return <PopoutMessage>Loading the Dispatcher</PopoutMessage>;
  if (agent.headless && (agent.status === 'running' || agent.status === 'creating')) {
    return (
      <div className="w-full h-full" data-testid="popout-agent-view">
        <HeadlessAgentView agent={agent} stacked />
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
  const runtime = useAgentRuntimeInfo(agent, flag !== null);
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
