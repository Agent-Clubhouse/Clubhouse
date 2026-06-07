import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApplyPersonaDialog } from './ApplyPersonaDialog';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';

const mockClose = vi.fn();
const mockLoadDurable = vi.fn().mockResolvedValue(undefined);

function resetStores(overrides: Record<string, any> = {}) {
  useAgentStore.setState({
    applyPersonaDialogAgent: 'agent-1',
    closeApplyPersonaDialog: mockClose,
    loadDurableAgents: mockLoadDurable,
    agents: {
      'agent-1': {
        id: 'agent-1', projectId: 'proj-1', name: 'bold-falcon',
        kind: 'durable', status: 'sleeping', color: 'indigo',
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

describe('ApplyPersonaDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    window.clubhouse.agentSettings.listSourcePersonas = vi.fn().mockResolvedValue([
      { id: 'qa', name: 'Quality Assurance', source: 'builtin' },
      { id: 'my-pattern', name: 'My Pattern', source: 'user' },
    ]);
    window.clubhouse.agentSettings.readSourcePersonaContent = vi.fn().mockResolvedValue(
      '---\nmodel: "claude-opus-4-8"\nmcpIds: ["github"]\n---\n# Role: My Pattern',
    );
    window.clubhouse.agentSettings.applyPersonaToAgent = vi.fn().mockResolvedValue(undefined);
  });

  it('renders nothing when no agent is selected', () => {
    resetStores({ applyPersonaDialogAgent: null });
    const { container } = render(<ApplyPersonaDialog />);
    expect(container.innerHTML).toBe('');
  });

  it('lists available personas', async () => {
    render(<ApplyPersonaDialog />);
    await waitFor(() => {
      expect(screen.getByText('Quality Assurance')).toBeInTheDocument();
      expect(screen.getByText('My Pattern · user')).toBeInTheDocument();
    });
  });

  it('previews the settings a persona will overwrite', async () => {
    render(<ApplyPersonaDialog />);
    await screen.findByText('My Pattern · user');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'my-pattern' } });
    await waitFor(() => {
      expect(screen.getByText(/model:/)).toBeInTheDocument();
      expect(screen.getByText(/claude-opus-4-8/)).toBeInTheDocument();
    });
  });

  it('applies the selected persona and closes', async () => {
    render(<ApplyPersonaDialog />);
    await screen.findByText('Quality Assurance');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'qa' } });
    fireEvent.click(screen.getByText('Apply persona'));
    await waitFor(() => {
      expect(window.clubhouse.agentSettings.applyPersonaToAgent).toHaveBeenCalledWith(
        '/home/user/project', 'agent-1', 'qa',
      );
      expect(mockLoadDurable).toHaveBeenCalledWith('proj-1', '/home/user/project');
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
