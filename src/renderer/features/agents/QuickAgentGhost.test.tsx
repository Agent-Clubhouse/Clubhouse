import { render, screen, fireEvent } from '@testing-library/react';
import { QuickAgentGhost, QuickAgentGhostCompact } from './QuickAgentGhost';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import type { CompletedQuickAgent } from '../../../shared/types';

vi.mock('./TranscriptViewer', () => ({
  TranscriptViewer: ({ agentId }: { agentId: string }) => (
    <div data-testid="transcript-viewer">{agentId}</div>
  ),
}));

function makeCompleted(overrides: Partial<CompletedQuickAgent> = {}): CompletedQuickAgent {
  return {
    id: 'quick-1',
    projectId: 'proj-1',
    mission: 'Fix the bug in auth module',
    summary: 'Fixed authentication issue by updating token validation.',
    filesModified: ['src/auth.ts', 'src/auth.test.ts'],
    exitCode: 0,
    completedAt: Date.now() - 60000,
    headless: false,
    ...overrides,
  } as CompletedQuickAgent;
}

function resetStores() {
  useOrchestratorStore.setState({
    allOrchestrators: [
      { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: {} as any },
    ],
  });
}

describe('QuickAgentGhost', () => {
  const defaultProps = {
    completed: makeCompleted(),
    onDismiss: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<QuickAgentGhost {...defaultProps} />);
    expect(screen.getByText('Fix the bug in auth module')).toBeInTheDocument();
  });

  it('shows exit badge for successful exit', () => {
    render(<QuickAgentGhost {...defaultProps} />);
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('shows cancelled badge', () => {
    render(<QuickAgentGhost completed={makeCompleted({ cancelled: true })} onDismiss={vi.fn()} />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('shows killed badge for signal exit', () => {
    render(<QuickAgentGhost completed={makeCompleted({ exitCode: 137 })} onDismiss={vi.fn()} />);
    expect(screen.getByText('Killed')).toBeInTheDocument();
  });

  it('shows error exit badge', () => {
    render(<QuickAgentGhost completed={makeCompleted({ exitCode: 1 })} onDismiss={vi.fn()} />);
    expect(screen.getByText('Exit 1')).toBeInTheDocument();
  });

  it('shows mission and summary', () => {
    render(<QuickAgentGhost {...defaultProps} />);
    expect(screen.getByText('Mission')).toBeInTheDocument();
    expect(screen.getByText('Fix the bug in auth module')).toBeInTheDocument();
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getByText('Fixed authentication issue by updating token validation.')).toBeInTheDocument();
  });

  it('shows "Interrupted" when no summary', () => {
    render(<QuickAgentGhost completed={makeCompleted({ summary: undefined })} onDismiss={vi.fn()} />);
    expect(screen.getByText(/Interrupted/)).toBeInTheDocument();
  });

  it('shows files modified count', () => {
    render(<QuickAgentGhost {...defaultProps} />);
    expect(screen.getByText('Files modified (2)')).toBeInTheDocument();
    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
  });

  it('expands file list when more than 3 files', () => {
    const manyFiles = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    render(<QuickAgentGhost completed={makeCompleted({ filesModified: manyFiles })} onDismiss={vi.fn()} />);
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    fireEvent.click(screen.getByText('+2 more'));
    expect(screen.getByText('Show less')).toBeInTheDocument();
    expect(screen.getByText('d.ts')).toBeInTheDocument();
    expect(screen.getByText('e.ts')).toBeInTheDocument();
  });

  it('calls onDismiss when Dismiss clicked', () => {
    render(<QuickAgentGhost {...defaultProps} />);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(defaultProps.onDismiss).toHaveBeenCalled();
  });

  it('calls onDelete when Delete clicked', () => {
    render(<QuickAgentGhost {...defaultProps} />);
    fireEvent.click(screen.getByText('Delete'));
    expect(defaultProps.onDelete).toHaveBeenCalled();
  });

  it('hides Delete button when onDelete not provided', () => {
    render(<QuickAgentGhost completed={makeCompleted()} onDismiss={vi.fn()} />);
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows transcript viewer toggle for headless agents', () => {
    render(<QuickAgentGhost completed={makeCompleted({ headless: true })} onDismiss={vi.fn()} />);
    expect(screen.getByText('View transcript')).toBeInTheDocument();
  });

  it('toggles transcript viewer on click', () => {
    render(<QuickAgentGhost completed={makeCompleted({ headless: true })} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByText('View transcript'));
    expect(screen.getByTestId('transcript-viewer')).toBeInTheDocument();
    expect(screen.getByText('Hide transcript')).toBeInTheDocument();
  });

  it('hides transcript toggle for non-headless agents', () => {
    render(<QuickAgentGhost completed={makeCompleted({ headless: false })} onDismiss={vi.fn()} />);
    expect(screen.queryByText('View transcript')).not.toBeInTheDocument();
  });

  it('shows duration and tools when available', () => {
    render(<QuickAgentGhost
      completed={makeCompleted({ durationMs: 90000, toolsUsed: ['Read', 'Edit'] })}
      onDismiss={vi.fn()}
    />);
    expect(screen.getByText('1m 30s')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });
});

describe('QuickAgentGhostCompact', () => {
  const defaultProps = {
    completed: makeCompleted(),
    onDismiss: vi.fn(),
    onSelect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<QuickAgentGhostCompact {...defaultProps} />);
    expect(screen.getByText('Fix the bug in auth module')).toBeInTheDocument();
  });

  it('shows orchestrator badge', () => {
    render(<QuickAgentGhostCompact {...defaultProps} />);
    expect(screen.getByText('CC')).toBeInTheDocument();
  });

  it('calls onDismiss on trash button click', () => {
    render(<QuickAgentGhostCompact {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Dismiss'));
    expect(defaultProps.onDismiss).toHaveBeenCalled();
  });

  it('calls onSelect when row clicked', () => {
    render(<QuickAgentGhostCompact {...defaultProps} />);
    fireEvent.click(screen.getByText('Fix the bug in auth module'));
    expect(defaultProps.onSelect).toHaveBeenCalled();
  });
});
