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
        capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true },
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

  it('blocks a worktree agent whose name is not a valid folder and branch name (#2221)', () => {
    render(<AddAgentDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /worktree/i }));
    fireEvent.change(screen.getByDisplayValue('test-agent'), { target: { value: 'x$(touch pwned)' } });
    expect(screen.getByTestId('add-agent-name-error')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Create Agent'));
    expect(defaultProps.onCreate).not.toHaveBeenCalled();
  });

  it('allows any display name when the agent has no worktree', () => {
    render(<AddAgentDialog {...defaultProps} />);
    fireEvent.change(screen.getByDisplayValue('test-agent'), { target: { value: 'My Agent' } });
    expect(screen.queryByTestId('add-agent-name-error')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Create Agent'));
    expect(defaultProps.onCreate).toHaveBeenCalledWith(
      'My Agent', 'indigo', 'default', false, 'claude-code', undefined, undefined, undefined,
    );
  });

  describe('persona selector (#1565)', () => {
    it('renders a persona select defaulting to Project default', () => {
      render(<AddAgentDialog {...defaultProps} />);
      const select = screen.getByTestId('add-agent-persona-select') as HTMLSelectElement;
      expect(select.value).toBe('');
      expect(screen.getByText('Project default')).toBeInTheDocument();
    });

    it('lists the known persona templates as options', () => {
      render(<AddAgentDialog {...defaultProps} />);
      expect(screen.getByText('Quality Assurance')).toBeInTheDocument();
      expect(screen.getByText('Researcher')).toBeInTheDocument();
    });

    it('does not propagate a persona by default', () => {
      render(<AddAgentDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('Create Agent'));
      const callArgs = (defaultProps.onCreate as any).mock.calls[0];
      expect(callArgs[callArgs.length - 1]).toBeUndefined();
    });

    it('propagates the selected persona id on submit', () => {
      render(<AddAgentDialog {...defaultProps} />);
      fireEvent.change(screen.getByTestId('add-agent-persona-select'), { target: { value: 'qa' } });
      fireEvent.click(screen.getByText('Create Agent'));
      expect(defaultProps.onCreate).toHaveBeenCalledWith(
        'test-agent', 'indigo', 'default', false, 'claude-code', undefined, undefined, 'qa',
      );
    });
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

  it('does not render a Structured Mode toggle, even with the legacy experimental flag set', async () => {
    window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ structuredMode: true });
    render(<AddAgentDialog {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Create Agent')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('structured-mode-field')).not.toBeInTheDocument();
    expect(screen.queryByText('Use Structured Mode')).not.toBeInTheDocument();
  });

  it('calls onCreate with exactly eight positional args (no structuredMode slot)', () => {
    render(<AddAgentDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Create Agent'));
    expect((defaultProps.onCreate as any).mock.calls[0]).toHaveLength(8);
  });
});
