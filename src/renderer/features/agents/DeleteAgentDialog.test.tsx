import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeleteAgentDialog } from './DeleteAgentDialog';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';

const mockCloseDeleteDialog = vi.fn();
const mockExecuteDelete = vi.fn().mockResolvedValue({ ok: true });

function resetStores(overrides: Record<string, any> = {}) {
  useAgentStore.setState({
    deleteDialogAgent: 'agent-1',
    closeDeleteDialog: mockCloseDeleteDialog,
    executeDelete: mockExecuteDelete,
    agents: {
      'agent-1': {
        id: 'agent-1',
        projectId: 'proj-1',
        name: 'bold-falcon',
        kind: 'durable',
        status: 'sleeping',
        color: 'indigo',
        worktreePath: '/worktrees/bold-falcon',
      },
    },
    ...overrides,
  });

  useProjectStore.setState({
    projects: [{ id: 'proj-1', name: 'my-project', path: '/home/user/project', color: 'indigo' }],
    activeProjectId: 'proj-1',
  });
}

describe('DeleteAgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    window.clubhouse.agent.getWorktreeStatus = vi.fn().mockResolvedValue({
      isValid: true,
      uncommittedFiles: [],
      unpushedCommits: [],
      hasRemote: true,
    });
  });

  it('renders nothing when no agent selected', () => {
    resetStores({ deleteDialogAgent: null });
    const { container } = render(<DeleteAgentDialog />);
    expect(container.innerHTML).toBe('');
  });

  it('renders loading spinner initially', () => {
    const { container } = render(<DeleteAgentDialog />);
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('shows clean state confirmation for clean worktree', async () => {
    render(<DeleteAgentDialog />);
    await waitFor(() => {
      expect(screen.getByText(/Delete bold-falcon/)).toBeInTheDocument();
    });
    expect(screen.getByText(/No uncommitted changes detected/)).toBeInTheDocument();
  });

  it('shows simple dialog for non-worktree agent', async () => {
    resetStores({
      agents: {
        'agent-1': {
          id: 'agent-1',
          projectId: 'proj-1',
          name: 'bold-falcon',
          kind: 'durable',
          status: 'sleeping',
          color: 'indigo',
          worktreePath: undefined,
        },
      },
    });

    render(<DeleteAgentDialog />);
    expect(screen.getByText(/Remove bold-falcon/)).toBeInTheDocument();
    expect(screen.getByText('This agent has no worktree. It will be removed from the sidebar.')).toBeInTheDocument();
  });

  it('shows dirty state with options when there are uncommitted changes', async () => {
    window.clubhouse.agent.getWorktreeStatus = vi.fn().mockResolvedValue({
      isValid: true,
      uncommittedFiles: [{ path: 'src/index.ts', status: 'M' }],
      unpushedCommits: [],
      hasRemote: true,
    });

    render(<DeleteAgentDialog />);
    await waitFor(() => {
      expect(screen.getByText(/unsaved work/)).toBeInTheDocument();
    });
    expect(screen.getByText('Commit & push')).toBeInTheDocument();
    expect(screen.getByText('Cleanup branch')).toBeInTheDocument();
    expect(screen.getByText('Save as patch')).toBeInTheDocument();
    expect(screen.getByText('Force delete')).toBeInTheDocument();
    expect(screen.getByText('Leave files')).toBeInTheDocument();
  });

  it('shows uncommitted files list', async () => {
    window.clubhouse.agent.getWorktreeStatus = vi.fn().mockResolvedValue({
      isValid: true,
      uncommittedFiles: [{ path: 'src/index.ts', status: 'M' }],
      unpushedCommits: [],
      hasRemote: true,
    });

    render(<DeleteAgentDialog />);
    await waitFor(() => {
      expect(screen.getByText('src/index.ts')).toBeInTheDocument();
    });
  });

  it('shows unpushed commits list', async () => {
    window.clubhouse.agent.getWorktreeStatus = vi.fn().mockResolvedValue({
      isValid: true,
      uncommittedFiles: [],
      unpushedCommits: [{ hash: 'abc123', shortHash: 'abc1', subject: 'Add feature' }],
      hasRemote: true,
    });

    render(<DeleteAgentDialog />);
    await waitFor(() => {
      expect(screen.getByText('abc1')).toBeInTheDocument();
      expect(screen.getByText('Add feature')).toBeInTheDocument();
    });
  });

  it('closes dialog when Cancel clicked', async () => {
    render(<DeleteAgentDialog />);
    await waitFor(() => screen.getByText(/Delete bold-falcon/));
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockCloseDeleteDialog).toHaveBeenCalled();
  });

  it('closes dialog on Escape key', () => {
    render(<DeleteAgentDialog />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(mockCloseDeleteDialog).toHaveBeenCalled();
  });

  it('closes dialog when backdrop clicked', async () => {
    const { container } = render(<DeleteAgentDialog />);
    const backdrop = container.querySelector('.fixed.inset-0');
    fireEvent.click(backdrop!);
    expect(mockCloseDeleteDialog).toHaveBeenCalled();
  });
});
