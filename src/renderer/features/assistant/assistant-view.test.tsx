import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssistantView } from './AssistantView';
import * as assistantAgent from './assistant-agent';

// Mock assistant-agent module
vi.mock('./assistant-agent', () => ({
  getFeedItems: vi.fn(() => []),
  getStatus: vi.fn(() => 'idle' as const),
  getMode: vi.fn(() => 'headless' as const),
  getOrchestrator: vi.fn(() => null),
  getAgentId: vi.fn(() => null),
  onFeedUpdate: vi.fn(() => () => {}),
  onStatusChange: vi.fn(() => () => {}),
  onModeChange: vi.fn(() => () => {}),
  onOrchestratorChange: vi.fn(() => () => {}),
  onAgentIdChange: vi.fn(() => () => {}),
  sendMessage: vi.fn(),
  setMode: vi.fn(),
  setOrchestrator: vi.fn(),
  reset: vi.fn(),
  approveAction: vi.fn(),
  skipAction: vi.fn(),
}));

// Mock AgentTerminal since it depends on PTY
vi.mock('../agents/AgentTerminal', () => ({
  AgentTerminal: ({ agentId }: { agentId: string }) => (
    <div data-testid="agent-terminal">{agentId}</div>
  ),
}));

describe('AssistantView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders assistant-view container', () => {
    render(<AssistantView />);
    expect(screen.getByTestId('assistant-view')).toBeInTheDocument();
  });

  it('renders feed and input in headless mode', () => {
    vi.mocked(assistantAgent.getMode).mockReturnValue('headless');
    vi.mocked(assistantAgent.getAgentId).mockReturnValue(null);
    render(<AssistantView />);

    expect(screen.getByTestId('assistant-feed-empty')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-input')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
  });

  it('renders feed and input in structured mode', () => {
    vi.mocked(assistantAgent.getMode).mockReturnValue('structured');
    vi.mocked(assistantAgent.getAgentId).mockReturnValue(null);
    render(<AssistantView />);

    expect(screen.getByTestId('assistant-feed-empty')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-input')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
  });

  it('renders terminal in interactive mode with active agent', () => {
    vi.mocked(assistantAgent.getMode).mockReturnValue('interactive');
    vi.mocked(assistantAgent.getAgentId).mockReturnValue('agent_123');
    vi.mocked(assistantAgent.getStatus).mockReturnValue('active');
    render(<AssistantView />);

    expect(screen.getByTestId('agent-terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-feed-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-input')).not.toBeInTheDocument();
  });

  it('renders feed (not terminal) in interactive mode without active agent', () => {
    vi.mocked(assistantAgent.getMode).mockReturnValue('interactive');
    vi.mocked(assistantAgent.getAgentId).mockReturnValue(null);
    vi.mocked(assistantAgent.getStatus).mockReturnValue('idle');
    render(<AssistantView />);

    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-feed-empty')).toBeInTheDocument();
  });

  it('disables input when status is starting', () => {
    vi.mocked(assistantAgent.getStatus).mockReturnValue('starting');
    render(<AssistantView />);

    const input = screen.getByTestId('assistant-message-input');
    expect(input).toBeDisabled();
  });

  it('disables input when status is responding', () => {
    vi.mocked(assistantAgent.getStatus).mockReturnValue('responding');
    render(<AssistantView />);

    const input = screen.getByTestId('assistant-message-input');
    expect(input).toBeDisabled();
  });

  it('enables input when status is idle', () => {
    vi.mocked(assistantAgent.getStatus).mockReturnValue('idle');
    render(<AssistantView />);

    const input = screen.getByTestId('assistant-message-input');
    expect(input).not.toBeDisabled();
  });

  it('subscribes to all agent listeners on mount', () => {
    render(<AssistantView />);

    expect(assistantAgent.onFeedUpdate).toHaveBeenCalledOnce();
    expect(assistantAgent.onStatusChange).toHaveBeenCalledOnce();
    expect(assistantAgent.onModeChange).toHaveBeenCalledOnce();
    expect(assistantAgent.onOrchestratorChange).toHaveBeenCalledOnce();
    expect(assistantAgent.onAgentIdChange).toHaveBeenCalledOnce();
  });
});
