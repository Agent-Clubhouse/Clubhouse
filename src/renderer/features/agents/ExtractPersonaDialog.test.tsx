import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExtractPersonaDialog } from './ExtractPersonaDialog';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';

const mockClose = vi.fn();

function resetStores(overrides: Record<string, any> = {}) {
  useAgentStore.setState({
    extractPersonaDialogAgent: 'agent-1',
    closeExtractPersonaDialog: mockClose,
    agents: {
      'agent-1': {
        id: 'agent-1', projectId: 'proj-1', name: 'Bold Falcon',
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

describe('ExtractPersonaDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    window.clubhouse.agentSettings.extractAgentPersona = vi.fn().mockResolvedValue({
      content: 'Agent @@AgentName',
      settings: { model: 'claude-opus-4-8', mcpIds: ['github'] },
    });
    window.clubhouse.agentSettings.writeSourcePersonaContent = vi.fn().mockResolvedValue(undefined);
  });

  it('renders nothing when no agent is selected', () => {
    resetStores({ extractPersonaDialogAgent: null });
    const { container } = render(<ExtractPersonaDialog />);
    expect(container.innerHTML).toBe('');
  });

  it('prefills the extracted content, settings, and a slugified id', async () => {
    render(<ExtractPersonaDialog />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('Agent @@AgentName')).toBeInTheDocument();
      expect(screen.getByDisplayValue('bold-falcon')).toBeInTheDocument(); // slug of "Bold Falcon"
      expect(screen.getByText(/model/)).toBeInTheDocument();
    });
  });

  it('saves the pattern with front-matter to the user library by default', async () => {
    render(<ExtractPersonaDialog />);
    await screen.findByDisplayValue('Agent @@AgentName');
    fireEvent.click(screen.getByText('Save persona'));
    await waitFor(() => {
      expect(window.clubhouse.agentSettings.writeSourcePersonaContent).toHaveBeenCalled();
    });
    const call = (window.clubhouse.agentSettings.writeSourcePersonaContent as any).mock.calls[0];
    expect(call[0]).toBe('/home/user/project');
    expect(call[1]).toBe('bold-falcon');
    expect(call[2]).toContain('model: "claude-opus-4-8"');
    expect(call[2]).toContain('Agent @@AgentName');
    expect(call[3]).toBe('user');
  });
});
