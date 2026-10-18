import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PopoutAgentView } from './PopoutAgentView';
import { resetChatFlagCache } from '../agents/chat/AgentRuntimePane';
import { chatFixture } from '../agents/chat/fixtures';

vi.mock('../agents/AgentTerminal', () => ({
  AgentTerminal: ({ agentId, focused }: { agentId: string; focused?: boolean }) => (
    <div data-testid="agent-terminal" data-agent-id={agentId} data-focused={focused} />
  ),
}));

vi.mock('../agents/SleepingAgent', () => ({
  SleepingAgent: ({ agent }: { agent: { id: string } }) => (
    <div data-testid="sleeping-agent" data-agent-id={agent.id} />
  ),
}));

vi.mock('../agents/AgentAvatar', () => ({
  AgentAvatar: () => <div data-testid="chat-agent-avatar" />,
  AgentAvatarWithRing: ({ agent }: { agent: { name: string } }) => (
    <div data-testid="agent-avatar" data-name={agent.name} />
  ),
}));

vi.mock('../agents/HeadlessAgentView', () => ({
  HeadlessAgentView: ({ agent, stacked }: { agent: { id: string }; stacked?: boolean }) => (
    <div data-testid="headless-agent-view" data-agent-id={agent.id} data-stacked={stacked} />
  ),
}));

const mockAgents: Record<string, any> = {};

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: (selector: (s: any) => any) => selector({
    agents: mockAgents,
    agentDetailedStatus: {},
    spawnDurableAgent: vi.fn(),
  }),
}));

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector: (s: any) => any) => selector({
    projects: [],
  }),
}));

describe('PopoutAgentView', () => {
  beforeEach(() => {
    // Clear mock agents
    for (const key of Object.keys(mockAgents)) delete mockAgents[key];

    window.clubhouse.agent.killAgent = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agent.onHookEvent = vi.fn().mockReturnValue(() => {});
    window.clubhouse.pty.kill = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.pty.onExit = vi.fn().mockReturnValue(() => {});
    window.clubhouse.window.focusMain = vi.fn().mockResolvedValue(undefined);
    resetChatFlagCache();
    window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({ chat: false })) as typeof window.clubhouse.app.getExperimentalSettings;
  });

  it('shows chat for an agent running in chat, with one toolbar', async () => {
    window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({ chat: true })) as typeof window.clubhouse.app.getExperimentalSettings;
    window.clubhouse.app.isPreviewEligible = vi.fn(async () => true);
    window.clubhouse.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, chatAvailable: true }));
    window.clubhouse.chat.readTranscript = vi.fn(async () => chatFixture('codex', 'conversation'));
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red', orchestrator: 'codex-cli',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    // First test to render chat: it cold-loads the lazy ChatView chunk (~1s), right at findBy's default timeout.
    expect(await screen.findByTestId('chat-view', undefined, { timeout: 5000 })).toHaveAttribute('data-view-context', 'popout');
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
    // Switching runtimes stays in the main window.
    expect(screen.queryByTestId('runtime-switch')).not.toBeInTheDocument();
    // ChatView's own toolbar, not a second bar from the popout; Stop is in the title bar.
    expect(screen.getAllByTestId('agent-pane-toolbar')).toHaveLength(1);
    expect(screen.queryByTestId('popout-stop-button')).not.toBeInTheDocument();
  });

  it('follows the agent between chat and the terminal, and from sleeping to running', async () => {
    window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({ chat: true })) as typeof window.clubhouse.app.getExperimentalSettings;
    window.clubhouse.app.isPreviewEligible = vi.fn(async () => true);
    window.clubhouse.chat.readTranscript = vi.fn(async () => chatFixture('codex', 'conversation'));
    window.clubhouse.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, chatAvailable: true }));
    const agent = { id: 'agent-1', name: 'test-agent', status: 'sleeping', kind: 'durable', projectId: 'proj-1', color: 'red', orchestrator: 'codex-cli' };
    mockAgents['agent-1'] = agent;
    const view = render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByTestId('sleeping-agent')).toBeInTheDocument();

    // Woken in chat.
    mockAgents['agent-1'] = { ...agent, status: 'running' };
    view.rerender(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    await screen.findByTestId('chat-view');

    // Switched to the terminal from the main window: the restart changes status and the runtime.
    window.clubhouse.chat.getAgentRuntime = vi.fn(async () => ({ chat: false, chatAvailable: true }));
    mockAgents['agent-1'] = { ...agent, status: 'creating' };
    view.rerender(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    await screen.findByTestId('agent-terminal');
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('agent-pane-toolbar')).toHaveLength(1);
  });

  it('docks the toolbar above the terminal instead of floating over its Bottom button', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    const terminal = await screen.findByTestId('agent-terminal');
    const toolbar = screen.getByTestId('agent-pane-toolbar');
    expect(toolbar.className).not.toContain('absolute');
    // A sibling before the terminal's container, not layered over it.
    expect(toolbar.compareDocumentPosition(terminal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toolbar.contains(terminal)).toBe(false);
    expect(screen.queryByTestId('popout-action-bar')).not.toBeInTheDocument();
  });

  it('renders "No agent specified" when no agentId', () => {
    render(<PopoutAgentView />);
    expect(screen.getByText('No agent specified')).toBeInTheDocument();
  });

  it('renders AgentTerminal when agent is running', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    // Until the Chat flag has loaded the pane shows a neutral placeholder, not a terminal that might be wrong.
    const terminal = await screen.findByTestId('agent-terminal');
    expect(terminal).toBeInTheDocument();
    expect(terminal).toHaveAttribute('data-agent-id', 'agent-1');
  });

  it('renders SleepingAgent when agent is sleeping', () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'sleeping',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByTestId('sleeping-agent')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
  });

  it('renders SleepingAgent when agent has error status', () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'error',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByTestId('sleeping-agent')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
  });

  it('renders AgentTerminal when agent is creating', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'creating',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    expect(await screen.findByTestId('agent-terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('sleeping-agent')).not.toBeInTheDocument();
  });

  it('does not render AgentTerminal when no agentId', () => {
    render(<PopoutAgentView />);
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
  });

  it('renders "Agent not found" when agentId given but agent not in store', () => {
    render(<PopoutAgentView agentId="nonexistent" projectId="proj-1" />);
    expect(screen.getByText('Agent not found')).toBeInTheDocument();
  });

  it('derives status from store, not local state — no hook/exit listeners needed', () => {
    // The component should NOT subscribe to onHookEvent or onExit directly.
    // Those are handled by useAgentStateSync() in PopoutWindow.tsx.
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);

    // Verify no direct subscriptions to PTY/hook events
    expect(window.clubhouse.pty.onExit).not.toHaveBeenCalled();
    expect(window.clubhouse.agent.onHookEvent).not.toHaveBeenCalled();
  });

  it('shows the run monitor, stacked, for a headless quick agent instead of a terminal (#2019)', () => {
    mockAgents['q-1'] = { id: 'q-1', name: 'quick-one', status: 'running', kind: 'quick', headless: true, projectId: 'proj-1', color: 'gray' };
    render(<PopoutAgentView agentId="q-1" projectId="proj-1" />);
    expect(screen.getByTestId('headless-agent-view')).toHaveAttribute('data-stacked', 'true');
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('popout-action-bar')).not.toBeInTheDocument();
  });
});
