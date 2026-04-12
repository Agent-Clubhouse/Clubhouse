import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantView } from './AssistantView';
import * as assistantAgent from './assistant-agent';
import { useUIStore } from '../../stores/uiStore';

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
  loadHistory: vi.fn(async () => {}),
}));

// Mock AgentTerminal since it depends on PTY
vi.mock('../agents/AgentTerminal', () => ({
  AgentTerminal: ({ agentId }: { agentId: string }) => (
    <div data-testid="agent-terminal">{agentId}</div>
  ),
}));

/** Helper: render and wait for the experimental flag fetch to settle. */
async function renderAndSettle(): Promise<void> {
  render(<AssistantView />);
  // The flag fetch is async — wait for the loading state to clear before
  // the test makes assertions about the resolved UI.
  await waitFor(() => {
    const view = screen.getByTestId('assistant-view');
    expect(view.getAttribute('data-assistant-state')).not.toBe('loading');
  });
}

describe('AssistantView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset Zustand UI store between tests so the "Open Settings" assertion
    // doesn't leak into sibling tests.
    useUIStore.setState({ explorerTab: 'agents', settingsSubPage: 'display' });
    // Default: experimental.assistant flag is enabled, so existing tests
    // exercise the chat UI path. Tests that need the disabled state override.
    vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue({
      assistant: true,
    } as Record<string, boolean>);
  });

  // ── Mission 73 — gating + recovery ─────────────────────────────────────────

  describe('experimental flag gating (Mission 73)', () => {
    it('renders loading state synchronously before the flag fetch resolves', () => {
      // Don't wait for settle — capture the initial render state
      render(<AssistantView />);
      const view = screen.getByTestId('assistant-view');
      expect(view.getAttribute('data-assistant-state')).toBe('loading');
    });

    it('renders disabled placeholder when experimental flag is false', async () => {
      vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue({
        assistant: false,
      } as Record<string, boolean>);

      await renderAndSettle();

      const view = screen.getByTestId('assistant-view');
      expect(view.getAttribute('data-assistant-state')).toBe('disabled');
      expect(screen.getByText(/experimental feature/i)).toBeInTheDocument();
      expect(screen.getByTestId('assistant-open-settings-button')).toBeInTheDocument();
      // The chat UI should NOT be present
      expect(screen.queryByTestId('assistant-feed-empty')).not.toBeInTheDocument();
      expect(screen.queryByTestId('assistant-message-input')).not.toBeInTheDocument();
    });

    it('renders disabled placeholder when getExperimentalSettings rejects', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockRejectedValue(
        new Error('IPC failed'),
      );

      await renderAndSettle();

      const view = screen.getByTestId('assistant-view');
      expect(view.getAttribute('data-assistant-state')).toBe('disabled');
      // Error should be logged, not swallowed (the fix's "stop swallowing" guarantee)
      expect(errorSpy).toHaveBeenCalledWith(
        'AssistantView: failed to load experimental settings',
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it('renders disabled placeholder when flag key is missing entirely', async () => {
      // Stable build default: getExperimentalSettings returns {} so flags.assistant is undefined
      vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue(
        {} as Record<string, boolean>,
      );

      await renderAndSettle();

      const view = screen.getByTestId('assistant-view');
      expect(view.getAttribute('data-assistant-state')).toBe('disabled');
    });

    it('"Open Experimental Settings" button routes to Settings -> Experimental', async () => {
      vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue({
        assistant: false,
      } as Record<string, boolean>);

      await renderAndSettle();

      const user = userEvent.setup();
      await user.click(screen.getByTestId('assistant-open-settings-button'));

      const ui = useUIStore.getState();
      expect(ui.explorerTab).toBe('settings');
      expect(ui.settingsSubPage).toBe('experimental');
    });

    it('renders the chat UI when the flag is enabled', async () => {
      await renderAndSettle();

      const view = screen.getByTestId('assistant-view');
      expect(view.getAttribute('data-assistant-state')).toBe('enabled');
      expect(screen.getByTestId('assistant-feed-empty')).toBeInTheDocument();
      expect(screen.getByTestId('assistant-message-input')).toBeInTheDocument();
    });

    it('calls loadHistory exactly once on mount when enabled', async () => {
      await renderAndSettle();
      // Allow microtasks for the loadHistory effect to fire
      await act(async () => { await Promise.resolve(); });
      expect(vi.mocked(assistantAgent.loadHistory)).toHaveBeenCalledTimes(1);
    });

    it('does NOT call loadHistory when the flag is false', async () => {
      vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue({
        assistant: false,
      } as Record<string, boolean>);

      await renderAndSettle();
      await act(async () => { await Promise.resolve(); });

      expect(vi.mocked(assistantAgent.loadHistory)).not.toHaveBeenCalled();
    });
  });

  // ── Existing chat-UI tests (now run with the flag pre-enabled) ─────────────

  it('renders assistant-view container', async () => {
    await renderAndSettle();
    expect(screen.getByTestId('assistant-view')).toBeInTheDocument();
  });

  it('renders feed and input in headless mode', async () => {
    vi.mocked(assistantAgent.getMode).mockReturnValue('headless');
    vi.mocked(assistantAgent.getAgentId).mockReturnValue(null);
    await renderAndSettle();

    expect(screen.getByTestId('assistant-feed-empty')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-input')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
  });

  it('renders feed and input in structured mode', async () => {
    vi.mocked(assistantAgent.getMode).mockReturnValue('structured');
    vi.mocked(assistantAgent.getAgentId).mockReturnValue(null);
    await renderAndSettle();

    expect(screen.getByTestId('assistant-feed-empty')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-input')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
  });

  it('renders terminal in interactive mode with active agent', async () => {
    vi.mocked(assistantAgent.getMode).mockReturnValue('interactive');
    vi.mocked(assistantAgent.getAgentId).mockReturnValue('agent_123');
    vi.mocked(assistantAgent.getStatus).mockReturnValue('active');
    await renderAndSettle();

    expect(screen.getByTestId('agent-terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-feed-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-input')).not.toBeInTheDocument();
  });

  it('renders feed (not terminal) in interactive mode without active agent', async () => {
    vi.mocked(assistantAgent.getMode).mockReturnValue('interactive');
    vi.mocked(assistantAgent.getAgentId).mockReturnValue(null);
    vi.mocked(assistantAgent.getStatus).mockReturnValue('idle');
    await renderAndSettle();

    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-feed-empty')).toBeInTheDocument();
  });

  it('disables input when status is starting', async () => {
    vi.mocked(assistantAgent.getStatus).mockReturnValue('starting');
    await renderAndSettle();

    const input = screen.getByTestId('assistant-message-input');
    expect(input).toBeDisabled();
  });

  it('disables input when status is responding', async () => {
    vi.mocked(assistantAgent.getStatus).mockReturnValue('responding');
    await renderAndSettle();

    const input = screen.getByTestId('assistant-message-input');
    expect(input).toBeDisabled();
  });

  it('enables input when status is idle', async () => {
    vi.mocked(assistantAgent.getStatus).mockReturnValue('idle');
    await renderAndSettle();

    const input = screen.getByTestId('assistant-message-input');
    expect(input).not.toBeDisabled();
  });

  it('subscribes to all agent listeners on mount', async () => {
    await renderAndSettle();

    expect(assistantAgent.onFeedUpdate).toHaveBeenCalledOnce();
    expect(assistantAgent.onStatusChange).toHaveBeenCalledOnce();
    expect(assistantAgent.onModeChange).toHaveBeenCalledOnce();
    expect(assistantAgent.onOrchestratorChange).toHaveBeenCalledOnce();
    expect(assistantAgent.onAgentIdChange).toHaveBeenCalledOnce();
  });
});
