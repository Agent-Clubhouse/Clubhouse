import { render, screen, fireEvent } from '@testing-library/react';
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
      'test-agent', 'indigo', 'default', false, 'claude-code', undefined, undefined,
    );
  });

  it('calls onClose when Cancel clicked', () => {
    render(<AddAgentDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop clicked', () => {
    const { container } = render(<AddAgentDialog {...defaultProps} />);
    const backdrop = container.querySelector('.fixed.inset-0');
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
      'my-custom-agent', 'indigo', 'default', false, 'claude-code', undefined, undefined,
    );
  });

  it('enables worktree option', () => {
    render(<AddAgentDialog {...defaultProps} />);
    const checkbox = screen.getByRole('checkbox', { name: /worktree/i });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText('Create Agent'));
    expect(defaultProps.onCreate).toHaveBeenCalledWith(
      'test-agent', 'indigo', 'default', true, 'claude-code', undefined, undefined,
    );
  });
});
