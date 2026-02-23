import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigChangesDialog } from './ConfigChangesDialog';
import { useAgentStore } from '../../stores/agentStore';

const mockCloseDialog = vi.fn();
const mockComputeConfigDiff = vi.fn();
const mockPropagateConfigChanges = vi.fn();
const mockUpdateDurableConfig = vi.fn();

function resetStore(overrides: Record<string, any> = {}) {
  useAgentStore.setState({
    configChangesDialogAgent: 'agent-1',
    configChangesProjectPath: '/project/path',
    closeConfigChangesDialog: mockCloseDialog,
    agents: {
      'agent-1': {
        id: 'agent-1', name: 'bold-falcon', kind: 'durable',
        status: 'sleeping', color: 'indigo', projectId: 'proj-1',
      },
    },
    ...overrides,
  });
}

const sampleDiffItems = [
  { id: 'item-1', category: 'instructions', action: 'modified', label: 'Updated CLAUDE.md', agentValue: 'new content', defaultValue: 'old content' },
  { id: 'item-2', category: 'permissions-allow', action: 'added', label: 'Allow shell access' },
  { id: 'item-3', category: 'mcp', action: 'removed', label: 'Removed old MCP server' },
];

describe('ConfigChangesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeConfigDiff.mockResolvedValue({ items: sampleDiffItems, agentName: 'bold-falcon' });
    mockPropagateConfigChanges.mockResolvedValue(undefined);
    mockUpdateDurableConfig.mockResolvedValue(undefined);

    window.clubhouse.agentSettings.computeConfigDiff = mockComputeConfigDiff;
    window.clubhouse.agentSettings.propagateConfigChanges = mockPropagateConfigChanges;
    window.clubhouse.agent.updateDurableConfig = mockUpdateDurableConfig;
  });

  describe('null guard', () => {
    it('renders nothing when no agentId', () => {
      resetStore({ configChangesDialogAgent: null });
      const { container } = render(<ConfigChangesDialog />);
      expect(container.innerHTML).toBe('');
    });

    it('renders nothing when no projectPath', () => {
      resetStore({ configChangesProjectPath: null });
      const { container } = render(<ConfigChangesDialog />);
      expect(container.innerHTML).toBe('');
    });
  });

  describe('loading state', () => {
    it('shows spinner while loading', async () => {
      // Make the computation hang
      mockComputeConfigDiff.mockReturnValue(new Promise(() => {}));
      resetStore();
      const { container } = render(<ConfigChangesDialog />);
      // spinner is a div with animate-spin
      expect(container.querySelector('.animate-spin')).toBeTruthy();
    });
  });

  describe('empty state', () => {
    it('shows "No config changes detected" when no items', async () => {
      mockComputeConfigDiff.mockResolvedValue({ items: [], agentName: 'bold-falcon' });
      resetStore();
      render(<ConfigChangesDialog />);
      expect(await screen.findByText('No config changes detected')).toBeInTheDocument();
    });

    it('shows agent name in empty message', async () => {
      mockComputeConfigDiff.mockResolvedValue({ items: [], agentName: 'bold-falcon' });
      resetStore();
      render(<ConfigChangesDialog />);
      expect(await screen.findByText(/bold-falcon has no configuration changes/)).toBeInTheDocument();
    });

    it('close button calls closeDialog', async () => {
      mockComputeConfigDiff.mockResolvedValue({ items: [], agentName: 'test' });
      resetStore();
      render(<ConfigChangesDialog />);
      const closeBtn = await screen.findByText('Close');
      fireEvent.click(closeBtn);
      expect(mockCloseDialog).toHaveBeenCalled();
    });
  });

  describe('items rendering', () => {
    it('renders diff items grouped by category', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      expect(await screen.findByText('Instructions')).toBeInTheDocument();
      expect(screen.getByText('Permissions (Allow)')).toBeInTheDocument();
      expect(screen.getByText('MCP Servers')).toBeInTheDocument();
    });

    it('renders item labels', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      expect(await screen.findByText('Updated CLAUDE.md')).toBeInTheDocument();
      expect(screen.getByText('Allow shell access')).toBeInTheDocument();
      expect(screen.getByText('Removed old MCP server')).toBeInTheDocument();
    });

    it('renders action badges with correct symbols', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      await screen.findByText('Updated CLAUDE.md');

      // modified = ~, added = +, removed = −
      expect(screen.getByText('~')).toBeInTheDocument();
      expect(screen.getByText('+')).toBeInTheDocument();
      // − is a special minus sign (U+2212)
      expect(screen.getByText('−')).toBeInTheDocument();
    });

    it('shows selection count', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      expect(await screen.findByText('3 of 3 selected')).toBeInTheDocument();
    });
  });

  describe('checkbox interactions', () => {
    it('all items are checked by default', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      await screen.findByText('Updated CLAUDE.md');
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes).toHaveLength(3);
      checkboxes.forEach((cb) => expect(cb).toBeChecked());
    });

    it('unchecking an item updates selection count', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      await screen.findByText('Updated CLAUDE.md');
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);

      expect(screen.getByText('2 of 3 selected')).toBeInTheDocument();
    });

    it('deselect all removes all selections', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      await screen.findByText('Deselect all');
      fireEvent.click(screen.getByText('Deselect all'));

      expect(screen.getByText('0 of 3 selected')).toBeInTheDocument();
      expect(screen.getByText('Select all')).toBeInTheDocument();
    });

    it('select all after deselect restores all', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      await screen.findByText('Deselect all');
      fireEvent.click(screen.getByText('Deselect all'));
      fireEvent.click(screen.getByText('Select all'));

      expect(screen.getByText('3 of 3 selected')).toBeInTheDocument();
    });
  });

  describe('expand/collapse diff view', () => {
    it('shows View diff button for instructions items', async () => {
      resetStore();
      render(<ConfigChangesDialog />);
      expect(await screen.findByText('View diff')).toBeInTheDocument();
    });

    it('clicking View diff shows diff content', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      const viewDiff = await screen.findByText('View diff');
      fireEvent.click(viewDiff);

      expect(screen.getByText('Hide diff')).toBeInTheDocument();
    });

    it('does not show View diff for permissions items', async () => {
      mockComputeConfigDiff.mockResolvedValue({
        items: [{ id: 'perm-1', category: 'permissions-allow', action: 'added', label: 'Allow access' }],
        agentName: 'test',
      });
      resetStore();
      render(<ConfigChangesDialog />);

      await screen.findByText('Allow access');
      expect(screen.queryByText('View diff')).toBeNull();
    });
  });

  describe('actions', () => {
    it('save button calls propagateConfigChanges with selected IDs', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      await screen.findByText('Save to Clubhouse');
      fireEvent.click(screen.getByText('Save to Clubhouse'));

      await waitFor(() => {
        expect(mockPropagateConfigChanges).toHaveBeenCalledWith(
          '/project/path',
          'agent-1',
          expect.arrayContaining(['item-1', 'item-2', 'item-3']),
        );
      });
      expect(mockCloseDialog).toHaveBeenCalled();
    });

    it('save button is disabled when nothing is selected', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      await screen.findByText('Deselect all');
      fireEvent.click(screen.getByText('Deselect all'));

      expect(screen.getByText('Save to Clubhouse').closest('button')).toBeDisabled();
    });

    it('keep for agent calls updateDurableConfig', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      const keepBtn = await screen.findByText('Keep for this agent');
      fireEvent.click(keepBtn);

      await waitFor(() => {
        expect(mockUpdateDurableConfig).toHaveBeenCalledWith(
          '/project/path',
          'agent-1',
          { clubhouseModeOverride: true },
        );
      });
      expect(mockCloseDialog).toHaveBeenCalled();
    });

    it('discard closes dialog without saving', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      const discardBtn = await screen.findByText('Discard');
      fireEvent.click(discardBtn);

      expect(mockCloseDialog).toHaveBeenCalled();
      expect(mockPropagateConfigChanges).not.toHaveBeenCalled();
      expect(mockUpdateDurableConfig).not.toHaveBeenCalled();
    });
  });

  describe('keyboard and overlay', () => {
    it('pressing Escape closes the dialog', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      await screen.findByText('Save to Clubhouse');
      fireEvent.keyDown(window, { key: 'Escape' });

      expect(mockCloseDialog).toHaveBeenCalled();
    });

    it('clicking the backdrop overlay closes the dialog', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      await screen.findByText('Save to Clubhouse');
      // The outer div is the backdrop
      const backdrop = screen.getByText('Save to Clubhouse').closest('.fixed');
      expect(backdrop).toBeTruthy();
      fireEvent.click(backdrop!);

      expect(mockCloseDialog).toHaveBeenCalled();
    });

    it('clicking inside the dialog does not close it', async () => {
      resetStore();
      render(<ConfigChangesDialog />);

      await screen.findByText('Config changes detected');
      // Click on the dialog content area
      fireEvent.click(screen.getByText('Config changes detected'));

      expect(mockCloseDialog).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('shows empty state when computeConfigDiff throws', async () => {
      mockComputeConfigDiff.mockRejectedValue(new Error('Network error'));
      resetStore();
      render(<ConfigChangesDialog />);

      expect(await screen.findByText('No config changes detected')).toBeInTheDocument();
    });
  });
});
