import { render, screen, fireEvent } from '@testing-library/react';
import { TemplateConfigDialog } from './TemplateConfigDialog';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

vi.mock('../../../shared/name-generator', () => ({
  generateDurableName: () => 'random-name',
  AGENT_COLORS: [
    { id: 'indigo', hex: '#6366f1', label: 'Indigo' },
    { id: 'emerald', hex: '#10b981', label: 'Emerald' },
    { id: 'red', hex: '#ef4444', label: 'Red' },
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
      { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: { permissions: true, structuredMode: true } },
      { id: 'copilot-cli', displayName: 'GitHub Copilot', shortName: 'GHCP', capabilities: { permissions: false } },
    ],
    activeProfile: undefined,
    isOrchestratorInProfile: () => true,
  }),
}));

const mockPersona = {
  id: 'qa',
  name: 'QA',
  description: 'Quality assurance persona',
  content: '# QA\nTesting instructions...',
};

function resetStores() {
  useOrchestratorStore.setState({
    enabled: ['claude-code', 'copilot-cli'],
    allOrchestrators: [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        shortName: 'CC',
        capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true, structuredMode: true },
      },
      {
        id: 'copilot-cli',
        displayName: 'GitHub Copilot',
        shortName: 'GHCP',
        capabilities: { headless: true },
      },
    ],
    availability: {
      'claude-code': { available: true },
      'copilot-cli': { available: true },
    },
  });
}

describe('TemplateConfigDialog', () => {
  const defaultProps = {
    persona: mockPersona,
    personaColor: 'red',
    projectPath: '/home/user/project',
    onClose: vi.fn(),
    onCreate: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders with persona name in header', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    expect(screen.getByText('Configure QA')).toBeInTheDocument();
  });

  it('shows persona description', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    expect(screen.getByText('Quality assurance persona')).toBeInTheDocument();
  });

  it('pre-fills name from persona', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    const nameInput = screen.getByDisplayValue('qa');
    expect(nameInput).toBeInTheDocument();
  });

  it('allows editing the agent name', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    const nameInput = screen.getByDisplayValue('qa');
    fireEvent.change(nameInput, { target: { value: 'my-qa-agent' } });
    expect(screen.getByDisplayValue('my-qa-agent')).toBeInTheDocument();
  });

  it('randomize button changes the name', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    const randomizeBtn = screen.getByTitle('Randomize');
    fireEvent.click(randomizeBtn);
    expect(screen.getByDisplayValue('random-name')).toBeInTheDocument();
  });

  it('submits with correct config on Create Agent click', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    const createBtn = screen.getByText('Create Agent');
    fireEvent.click(createBtn);

    expect(defaultProps.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        persona: mockPersona,
        name: 'qa',
        color: 'red',
        model: 'default',
        orchestrator: 'claude-code',
        useWorktree: true,
        freeAgentMode: false,
        structuredMode: false,
      }),
    );
  });

  it('calls onClose when Cancel is clicked', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', () => {
    const { container } = render(<TemplateConfigDialog {...defaultProps} />);
    const backdrop = container.querySelector('.fixed.inset-0');
    fireEvent.click(backdrop!);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('shows worktree toggle defaulting to checked', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    const worktreeCheckbox = screen.getByRole('checkbox', { name: /worktree/i });
    expect(worktreeCheckbox).toBeChecked();
  });

  it('submits with worktree disabled when unchecked', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    const worktreeCheckbox = screen.getByRole('checkbox', { name: /worktree/i });
    fireEvent.click(worktreeCheckbox);

    fireEvent.click(screen.getByText('Create Agent'));
    expect(defaultProps.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ useWorktree: false }),
    );
  });

  it('renders model selector', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('Opus')).toBeInTheDocument();
  });

  it('renders orchestrator selector', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('GitHub Copilot')).toBeInTheDocument();
  });

  it('includes persona in submitted config', () => {
    render(<TemplateConfigDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Create Agent'));

    const call = defaultProps.onCreate.mock.calls[0][0];
    expect(call.persona.id).toBe('qa');
    expect(call.persona.content).toBe('# QA\nTesting instructions...');
  });
});
