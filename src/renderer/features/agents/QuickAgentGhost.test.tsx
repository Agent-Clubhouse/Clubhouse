import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    name: 'quick-fox',
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
    completed: makeCompleted({ name: 'bouncy-salmon', orchestrator: 'claude-code', model: 'opus' }),
    onDismiss: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    window.clubhouse.git.diffNumstat = vi.fn().mockResolvedValue([
      { path: 'src/auth.ts', added: 18, removed: 6, binary: false },
      { path: 'src/auth.test.ts', added: 40, removed: 0, binary: false },
    ]);
    window.clubhouse.git.diff = vi.fn().mockResolvedValue({ original: 'a', modified: 'b' });
    window.clubhouse.agent.readTranscriptPage = vi.fn().mockResolvedValue({ events: [], totalEvents: 0 });
  });

  it('shows Done in the toolbar with the mission, meta line and summary, and no chips', () => {
    render(<QuickAgentGhost {...defaultProps} />);
    expect(screen.getByTestId('state-word')).toHaveTextContent('Done');
    expect(screen.getByTestId('quick-mission')).toHaveTextContent('Fix the bug in auth module');
    expect(screen.getByText('bouncy-salmon · quick agent · Claude Code · opus · exit 0')).toBeInTheDocument();
    expect(screen.getByTestId('quick-summary')).toHaveTextContent('Fixed authentication issue');
    expect(screen.queryByText('Mission')).toBeNull();
    expect(screen.queryByText('Headless')).toBeNull();
  });

  it('lists files changed with diff sizes', async () => {
    render(<QuickAgentGhost completed={{ ...defaultProps.completed, cwd: '/wt', baseSha: 'abc' }} onDismiss={vi.fn()} />);
    expect(screen.getAllByTestId('file-row')).toHaveLength(2);
    await waitFor(() => expect(screen.getByTestId('quick-files')).toHaveTextContent('+18'));
    expect(screen.getByTestId('quick-files')).toHaveTextContent('2 · +58 −6');
    expect(window.clubhouse.git.diffNumstat).toHaveBeenCalledWith('/wt', 'abc');
  });

  it('Review changes shows the first file diff', async () => {
    render(<QuickAgentGhost completed={{ ...defaultProps.completed, cwd: '/wt', baseSha: 'abc' }} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quick-review-button'));
    expect(await screen.findByTestId('run-file-diff')).toBeInTheDocument();
    expect(window.clubhouse.git.diff).toHaveBeenCalledWith('/wt', 'src/auth.ts', false, 'abc');
  });

  it('says it ended without a summary', () => {
    render(<QuickAgentGhost completed={makeCompleted({ summary: null, exitCode: 1 })} onDismiss={vi.fn()} />);
    expect(screen.getByTestId('state-word')).toHaveTextContent('Error');
    expect(screen.getByTestId('quick-summary')).toHaveTextContent('It ended without writing a summary.');
  });

  it('says stopped for a cancelled run', () => {
    render(<QuickAgentGhost completed={makeCompleted({ summary: null, cancelled: true, exitCode: 143 })} onDismiss={vi.fn()} />);
    expect(screen.getByTestId('quick-summary')).toHaveTextContent('Stopped before it wrote a summary.');
  });

  it('calls onDismiss when Dismiss clicked', () => {
    render(<QuickAgentGhost {...defaultProps} />);
    fireEvent.click(screen.getByTestId('quick-dismiss-button'));
    expect(defaultProps.onDismiss).toHaveBeenCalled();
  });

  it('asks before Delete', () => {
    render(<QuickAgentGhost {...defaultProps} />);
    fireEvent.click(screen.getByTestId('quick-delete-button'));
    expect(defaultProps.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    expect(defaultProps.onDelete).toHaveBeenCalled();
  });

  it('hides Delete button when onDelete not provided', () => {
    render(<QuickAgentGhost completed={makeCompleted()} onDismiss={vi.fn()} />);
    expect(screen.queryByTestId('quick-delete-button')).toBeNull();
  });

  it('shows the tools used and duration as plain text', () => {
    render(<QuickAgentGhost completed={makeCompleted({ durationMs: 90000, toolsUsed: ['Read', 'Edit', 'Bash'] })} onDismiss={vi.fn()} />);
    expect(screen.getByTestId('quick-tools')).toHaveTextContent('Used Read, Edit and Bash, ran for 1m 30s');
  });

  it('shows a headless record in the run monitor layout', () => {
    render(<QuickAgentGhost completed={makeCompleted({ headless: true })} onDismiss={vi.fn()} />);
    expect(screen.getByTestId('headless-run-finished')).toBeInTheDocument();
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

  it('shows the provider as plain text', () => {
    render(<QuickAgentGhostCompact {...defaultProps} />);
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });

  it('can be dismissed by keyboard (the button is focusable)', () => {
    render(<QuickAgentGhostCompact {...defaultProps} />);
    const btn = screen.getByRole('button', { name: /Dismiss/ });
    expect(btn.className).toContain('focus-visible:opacity-100');
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
