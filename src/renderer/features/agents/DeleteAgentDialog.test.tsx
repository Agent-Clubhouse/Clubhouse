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
    render(<DeleteAgentDialog />);
    expect(document.body.querySelector('.animate-spin')).toBeInTheDocument();
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
    render(<DeleteAgentDialog />);
    const backdrop = document.body.querySelector('.fixed.inset-0');
    fireEvent.click(backdrop!);
    expect(mockCloseDeleteDialog).toHaveBeenCalled();
  });

  describe('agents outside the active project (the new chrome tree)', () => {
    it('reads and deletes the worktree in the agent’s own project', async () => {
      resetStores();
      useProjectStore.setState({
        projects: [
          { id: 'proj-1', name: 'my-project', path: '/home/user/project', color: 'indigo' },
          { id: 'proj-2', name: 'other', path: '/home/user/other', color: 'blue' },
        ] as never,
        activeProjectId: 'proj-1',
      });
      useAgentStore.setState({
        deleteDialogAgent: 'agent-2',
        agents: { 'agent-2': { id: 'agent-2', projectId: 'proj-2', name: 'calm-otter', kind: 'durable', status: 'sleeping', color: 'blue', worktreePath: '/home/user/other/.clubhouse/agents/calm-otter' } },
      } as never);
      render(<DeleteAgentDialog />);
      await waitFor(() => screen.getByText(/Delete calm-otter/));
      expect(window.clubhouse.agent.getWorktreeStatus).toHaveBeenCalledWith('/home/user/other', 'agent-2');
      fireEvent.click(screen.getByText('Leave files'));
      await waitFor(() => expect(mockExecuteDelete).toHaveBeenCalledWith('unregister', '/home/user/other'));
    });

    it('deletes a satellite’s agent on its satellite, whichever project is active', async () => {
      const { useRemoteProjectStore, namespacedAgentId, namespacedProjectId } = await import('../../stores/remoteProjectStore');
      const { useAnnexClientStore } = await import('../../stores/annexClientStore');
      const ra = namespacedAgentId('sat-1', 'bold-owl');
      const requestWorktreeStatus = vi.fn().mockResolvedValue({ isValid: true, uncommittedFiles: [], unpushedCommits: [], hasRemote: true });
      const sendAgentDeleteDurable = vi.fn().mockResolvedValue({ ok: true, message: '' });
      useAnnexClientStore.setState({ requestWorktreeStatus, sendAgentDeleteDurable } as never);
      useRemoteProjectStore.setState({
        remoteAgents: { [ra]: { id: ra, projectId: namespacedProjectId('sat-1', 'site'), name: 'bold-owl', kind: 'durable', status: 'sleeping', color: 'blue', worktreePath: '/srv/site/wt' } as never },
      });
      useProjectStore.setState({ activeProjectId: null });
      useAgentStore.setState({ deleteDialogAgent: ra });
      render(<DeleteAgentDialog />);
      await waitFor(() => screen.getByText(/Delete bold-owl/));
      expect(requestWorktreeStatus).toHaveBeenCalledWith('sat-1', 'site', 'bold-owl');
      fireEvent.click(screen.getByText('Leave files'));
      await waitFor(() => expect(sendAgentDeleteDurable).toHaveBeenCalledWith('sat-1', 'site', 'bold-owl', 'unregister'));
      expect(mockExecuteDelete).not.toHaveBeenCalled();
    });
  });
});
