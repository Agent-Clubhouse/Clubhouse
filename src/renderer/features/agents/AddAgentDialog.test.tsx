import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddAgentDialog } from './AddAgentDialog';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

vi.mock('../../../shared/name-generator', () => ({
  generateDurableName: () => 'test-agent',
  AGENT_COLORS: [
    { id: 'indigo', hex: '#6366f1', label: 'Indigo' },
    { id: 'emerald', hex: '#10b981', label: 'Emerald' },
    { id: 'amber', hex: '#f59e0b', label: 'Amber' },
  ],
}));

vi.mock('../../hooks/useModelOptions', () => ({
  useModelOptions: () => ({
    options: [
      { id: 'default', label: 'Default' },
      { id: 'opus', label: 'Opus' },
    ],
    loading: false,
  }),
}));

vi.mock('../../hooks/useEffectiveOrchestrators', () => ({
  useEffectiveOrchestrators: () => ({
    effectiveOrchestrators: [
      { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: { permissions: true } },
    ],
    activeProfile: undefined,
    isOrchestratorInProfile: () => true,
  }),
}));

function resetStores() {
  useOrchestratorStore.setState({
    enabled: ['claude-code'],
    allOrchestrators: [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        shortName: 'CC',
        capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true, structuredMode: true },
      },
    ],
    availability: { 'claude-code': { available: true } },
  });
}

describe('AddAgentDialog', () => {
  const defaultProps = {
    onClose: vi.fn(),
    onCreate: vi.fn(),
    projectPath: '/home/user/project',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    // Reset experimental flag mock to default (off) for each test.
    window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({});
  });

  it('renders without crash', () => {
    render(<AddAgentDialog {...defaultProps} />);
    expect(screen.getByText('New Agent')).toBeInTheDocument();
  });

  it('pre-fills with generated name', () => {
    render(<AddAgentDialog {...defaultProps} />);
    expect(screen.getByDisplayValue('test-agent')).toBeInTheDocument();
  });

  it('renders color picker', () => {
    render(<AddAgentDialog {...defaultProps} />);
    expect(screen.getByTitle('Indigo')).toBeInTheDocument();
    expect(screen.getByTitle('Emerald')).toBeInTheDocument();
    expect(screen.getByTitle('Amber')).toBeInTheDocument();
  });

  it('renders model selector', () => {
    render(<AddAgentDialog {...defaultProps} />);
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('renders orchestrator selector', () => {
    render(<AddAgentDialog {...defaultProps} />);
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });

  it('renders worktree checkbox', () => {
    render(<AddAgentDialog {...defaultProps} />);
    expect(screen.getByText('Use git worktree')).toBeInTheDocument();
  });

  it('renders free agent mode checkbox', () => {
    render(<AddAgentDialog {...defaultProps} />);
    expect(screen.getByText('Free Agent Mode')).toBeInTheDocument();
  });

  it('calls onCreate on form submit', () => {
    render(<AddAgentDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Create Agent'));
    expect(defaultProps.onCreate).toHaveBeenCalledWith(
      'test-agent', 'indigo', 'default', false, 'claude-code', undefined, undefined, undefined,
    );
  });

  it('calls onClose when Cancel clicked', () => {
    render(<AddAgentDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop clicked', () => {
    render(<AddAgentDialog {...defaultProps} />);
    const backdrop = document.body.querySelector('.fixed.inset-0');
    fireEvent.click(backdrop!);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('does not submit with empty name', () => {
    render(<AddAgentDialog {...defaultProps} />);
    const input = screen.getByDisplayValue('test-agent');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByText('Create Agent'));
    expect(defaultProps.onCreate).not.toHaveBeenCalled();
  });

  it('allows changing agent name', () => {
    render(<AddAgentDialog {...defaultProps} />);
    const input = screen.getByDisplayValue('test-agent');
    fireEvent.change(input, { target: { value: 'my-custom-agent' } });
    fireEvent.click(screen.getByText('Create Agent'));
    expect(defaultProps.onCreate).toHaveBeenCalledWith(
      'my-custom-agent', 'indigo', 'default', false, 'claude-code', undefined, undefined, undefined,
    );
  });

  it('enables worktree option', () => {
    render(<AddAgentDialog {...defaultProps} />);
    const checkbox = screen.getByRole('checkbox', { name: /worktree/i });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText('Create Agent'));
    expect(defaultProps.onCreate).toHaveBeenCalledWith(
      'test-agent', 'indigo', 'default', true, 'claude-code', undefined, undefined, undefined,
    );
  });

  describe('error surfacing (#1564)', () => {
    it('shows no error banner by default', () => {
      render(<AddAgentDialog {...defaultProps} />);
      expect(screen.queryByTestId('add-agent-dialog-error')).not.toBeInTheDocument();
    });

    it('shows the error banner when an error prop is passed', () => {
      render(<AddAgentDialog {...defaultProps} error="Plugin 'canvas' requires 'agents.free-agent-mode' permission" />);
      expect(screen.getByTestId('add-agent-dialog-error')).toBeInTheDocument();
      expect(screen.getByText(/requires 'agents.free-agent-mode' permission/)).toBeInTheDocument();
    });

    it('hides the error banner when error is null', () => {
      const { rerender } = render(<AddAgentDialog {...defaultProps} error="boom" />);
      expect(screen.getByTestId('add-agent-dialog-error')).toBeInTheDocument();
      rerender(<AddAgentDialog {...defaultProps} error={null} />);
      expect(screen.queryByTestId('add-agent-dialog-error')).not.toBeInTheDocument();
    });
  });

  describe('Free Agent Mode default-off (#1567)', () => {
    it('renders the Free Agent Mode checkbox unchecked on mount', () => {
      render(<AddAgentDialog {...defaultProps} />);
      const checkbox = screen.getByRole('checkbox', { name: /free agent mode/i });
      expect(checkbox).not.toBeChecked();
    });

    it('submits with freeAgentMode undefined when the toggle is never touched', () => {
      render(<AddAgentDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('Create Agent'));
      const freeAgentModeArg = (defaultProps.onCreate as any).mock.calls[0][5];
      expect(freeAgentModeArg).toBeUndefined();
    });
  });

  describe('Structured Mode gating (experimental flag)', () => {
    it('hides Structured Mode toggle when experimental.structuredMode is off (default)', async () => {
      render(<AddAgentDialog {...defaultProps} />);
      // Wait for async settings load to settle
      await waitFor(() => {
        expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled();
      });
      expect(screen.queryByTestId('structured-mode-field')).not.toBeInTheDocument();
      expect(screen.queryByText('Use Structured Mode')).not.toBeInTheDocument();
    });

    it('shows Structured Mode toggle when experimental.structuredMode is on', async () => {
      window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ structuredMode: true });
      render(<AddAgentDialog {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId('structured-mode-field')).toBeInTheDocument();
      });
      expect(screen.getByText('Use Structured Mode')).toBeInTheDocument();
    });

    it('keeps Structured Mode hidden when getExperimentalSettings rejects', async () => {
      window.clubhouse.app.getExperimentalSettings = vi.fn().mockRejectedValue(new Error('IPC down'));
      render(<AddAgentDialog {...defaultProps} />);
      await waitFor(() => {
        expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled();
      });
      expect(screen.queryByTestId('structured-mode-field')).not.toBeInTheDocument();
    });

    it('does not propagate structuredMode in onCreate when flag is off', async () => {
      render(<AddAgentDialog {...defaultProps} />);
      await waitFor(() => {
        expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled();
      });
      fireEvent.click(screen.getByText('Create Agent'));
      // Last positional arg (structuredMode) must be undefined
      const callArgs = (defaultProps.onCreate as any).mock.calls[0];
      expect(callArgs[callArgs.length - 1]).toBeUndefined();
    });
  });
});
