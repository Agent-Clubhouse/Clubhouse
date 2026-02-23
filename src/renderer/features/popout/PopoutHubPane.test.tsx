import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PopoutHubPane } from './PopoutHubPane';
import { useAgentStore } from '../../stores/agentStore';
import type { LeafPane } from '../../plugins/builtin/hub/pane-tree';
import type { Agent, AgentDetailedStatus, CompletedQuickAgent } from '../../../shared/types';

vi.mock('../agents/AgentTerminal', () => ({
  AgentTerminal: ({ agentId }: { agentId: string }) => (
    <div data-testid={`agent-terminal-${agentId}`} />
  ),
}));

vi.mock('../agents/SleepingAgent', () => ({
  SleepingAgent: ({ agent }: { agent: { id: string } }) => (
    <div data-testid={`sleeping-agent-${agent.id}`} />
  ),
}));

vi.mock('../agents/AgentAvatar', () => ({
  AgentAvatarWithRing: ({ agent }: { agent: { name: string } }) => (
    <div data-testid="agent-avatar" data-name={agent.name} />
  ),
}));

vi.mock('../agents/QuickAgentGhost', () => ({
  QuickAgentGhost: ({ completed, onDismiss }: { completed: { id: string }; onDismiss: () => void }) => (
    <div data-testid={`quick-agent-ghost-${completed.id}`}>
      <button data-testid="ghost-dismiss" onClick={onDismiss}>Dismiss</button>
    </div>
  ),
}));

const mockKillAgent = vi.fn().mockResolvedValue(undefined);

const defaultPane: LeafPane = {
  type: 'leaf',
  id: 'pane-1',
  agentId: 'agent-1',
  projectId: 'proj-1',
};

const defaultAgent: Agent = {
  id: 'agent-1',
  projectId: 'proj-1',
  name: 'bold-falcon',
  kind: 'durable',
  status: 'running',
  color: 'indigo',
};

const defaultProps = {
  pane: defaultPane,
  focused: false,
  canClose: true,
  agents: { 'agent-1': defaultAgent } as Record<string, Agent>,
  detailedStatuses: {} as Record<string, AgentDetailedStatus>,
  completedAgents: [] as CompletedQuickAgent[],
  projectId: 'proj-1',
  onSplit: vi.fn(),
  onClose: vi.fn(),
  onSwap: vi.fn(),
  onAssign: vi.fn(),
  onFocus: vi.fn(),
  onZoom: vi.fn(),
  dismissCompleted: vi.fn(),
};

function renderPane(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides };
  return render(<PopoutHubPane {...props} />);
}

describe('PopoutHubPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.setState({ killAgent: mockKillAgent });
    window.clubhouse.window.focusMain = vi.fn().mockResolvedValue(undefined);
  });

  describe('content rendering', () => {
    it('renders AgentTerminal for running agent', () => {
      renderPane();
      expect(screen.getByTestId('agent-terminal-agent-1')).toBeInTheDocument();
    });

    it('renders SleepingAgent for sleeping agent', () => {
      renderPane({
        agents: { 'agent-1': { ...defaultAgent, status: 'sleeping' } },
      });
      expect(screen.getByTestId('sleeping-agent-agent-1')).toBeInTheDocument();
      expect(screen.queryByTestId('agent-terminal-agent-1')).toBeNull();
    });

    it('renders SleepingAgent for error agent', () => {
      renderPane({
        agents: { 'agent-1': { ...defaultAgent, status: 'error' } },
      });
      expect(screen.getByTestId('sleeping-agent-agent-1')).toBeInTheDocument();
    });

    it('renders QuickAgentGhost for completed quick agent', () => {
      const completed: CompletedQuickAgent = {
        id: 'agent-1', projectId: 'proj-1', name: 'quick-done',
        mission: 'test', summary: null, filesModified: [],
        exitCode: 0, completedAt: Date.now(),
      };
      renderPane({
        pane: { ...defaultPane, agentId: 'agent-1' },
        agents: {},
        completedAgents: [completed],
      });
      expect(screen.getByTestId('quick-agent-ghost-agent-1')).toBeInTheDocument();
    });

    it('renders agent picker for unassigned pane', () => {
      renderPane({
        pane: { ...defaultPane, agentId: null },
      });
      expect(screen.getByText('Assign an agent')).toBeInTheDocument();
    });

    it('shows "No agents available" when no agents exist', () => {
      renderPane({
        pane: { ...defaultPane, agentId: null },
        agents: {},
      });
      expect(screen.getByText('No agents available')).toBeInTheDocument();
    });
  });

  describe('agent picker', () => {
    it('shows durable agents under Durable heading', () => {
      renderPane({
        pane: { ...defaultPane, agentId: null },
        agents: { 'agent-1': defaultAgent },
      });
      expect(screen.getByText('Durable')).toBeInTheDocument();
      expect(screen.getByText('bold-falcon')).toBeInTheDocument();
    });

    it('shows quick running agents under Quick heading', () => {
      const quickAgent: Agent = {
        id: 'quick-1', projectId: 'proj-1', name: 'quick-fox',
        kind: 'quick', status: 'running', color: 'emerald',
      };
      renderPane({
        pane: { ...defaultPane, agentId: null },
        agents: { 'quick-1': quickAgent },
      });
      expect(screen.getByText('Quick')).toBeInTheDocument();
      expect(screen.getByText('quick-fox')).toBeInTheDocument();
    });

    it('does not show quick sleeping agents', () => {
      const quickSleeping: Agent = {
        id: 'quick-1', projectId: 'proj-1', name: 'sleeping-fox',
        kind: 'quick', status: 'sleeping', color: 'emerald',
      };
      renderPane({
        pane: { ...defaultPane, agentId: null },
        agents: { 'quick-1': quickSleeping },
      });
      expect(screen.queryByText('Quick')).toBeNull();
    });

    it('calls onAssign when agent is picked', () => {
      const onAssign = vi.fn();
      renderPane({
        pane: { ...defaultPane, agentId: null },
        agents: { 'agent-1': defaultAgent },
        onAssign,
      });
      fireEvent.click(screen.getByText('bold-falcon'));
      expect(onAssign).toHaveBeenCalledWith('pane-1', 'agent-1');
    });
  });

  describe('floating name chip', () => {
    it('renders agent name in chip', () => {
      renderPane();
      expect(screen.getByText('bold-falcon')).toBeInTheDocument();
    });

    it('renders agent avatar', () => {
      renderPane();
      expect(screen.getByTestId('agent-avatar')).toBeInTheDocument();
    });

    it('does not render chip for empty pane', () => {
      renderPane({
        pane: { ...defaultPane, agentId: null },
        agents: {},
      });
      expect(screen.queryByTestId('agent-avatar')).toBeNull();
    });
  });

  describe('expanded actions on hover', () => {
    function hoverPane() {
      const paneEl = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');
      fireEvent.mouseEnter(paneEl!);
      return paneEl!;
    }

    it('shows action buttons on hover', () => {
      renderPane();
      hoverPane();

      expect(screen.getByTitle('View in main window')).toBeInTheDocument();
      expect(screen.getByTestId('zoom-button')).toBeInTheDocument();
      expect(screen.getByTitle('Remove from pane')).toBeInTheDocument();
    });

    it('shows Stop button for running agents', () => {
      renderPane();
      hoverPane();
      expect(screen.getByTitle('Stop agent')).toBeInTheDocument();
    });

    it('does not show Stop button for sleeping agents', () => {
      renderPane({
        agents: { 'agent-1': { ...defaultAgent, status: 'sleeping' } },
      });
      const paneEl = screen.getByTestId('sleeping-agent-agent-1').closest('[class*="rounded-sm"]');
      fireEvent.mouseEnter(paneEl!);
      expect(screen.queryByTitle('Stop agent')).toBeNull();
    });

    it('View button calls focusMain', () => {
      renderPane();
      hoverPane();
      fireEvent.click(screen.getByTitle('View in main window'));
      expect(window.clubhouse.window.focusMain).toHaveBeenCalledWith('agent-1');
    });

    it('Zoom button calls onZoom', () => {
      const onZoom = vi.fn();
      renderPane({ onZoom });
      hoverPane();
      fireEvent.click(screen.getByTestId('zoom-button'));
      expect(onZoom).toHaveBeenCalledWith('pane-1');
    });

    it('shows Restore text when isZoomed is true', () => {
      renderPane({ isZoomed: true });
      hoverPane();
      expect(screen.getByText('Restore')).toBeInTheDocument();
    });

    it('shows Zoom text when isZoomed is false', () => {
      renderPane({ isZoomed: false });
      hoverPane();
      expect(screen.getByText('Zoom')).toBeInTheDocument();
    });

    it('Stop button calls killAgent', () => {
      renderPane();
      hoverPane();
      fireEvent.click(screen.getByTitle('Stop agent'));
      expect(mockKillAgent).toHaveBeenCalledWith('agent-1');
    });

    it('Remove button calls onAssign with null', () => {
      const onAssign = vi.fn();
      renderPane({ onAssign });
      hoverPane();
      fireEvent.click(screen.getByTitle('Remove from pane'));
      expect(onAssign).toHaveBeenCalledWith('pane-1', null);
    });
  });

  describe('edge split indicators', () => {
    it('shows split indicators on hover', () => {
      renderPane();
      const paneEl = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');
      fireEvent.mouseEnter(paneEl!);

      expect(screen.getByTitle('Split Up')).toBeInTheDocument();
      expect(screen.getByTitle('Split Down')).toBeInTheDocument();
      expect(screen.getByTitle('Split Left')).toBeInTheDocument();
      expect(screen.getByTitle('Split Right')).toBeInTheDocument();
    });

    it('split Up calls onSplit with vertical/before', () => {
      const onSplit = vi.fn();
      renderPane({ onSplit });
      const paneEl = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');
      fireEvent.mouseEnter(paneEl!);

      fireEvent.click(screen.getByTitle('Split Up'));
      expect(onSplit).toHaveBeenCalledWith('pane-1', 'vertical', 'before');
    });

    it('split Down calls onSplit with vertical/after', () => {
      const onSplit = vi.fn();
      renderPane({ onSplit });
      const paneEl = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');
      fireEvent.mouseEnter(paneEl!);

      fireEvent.click(screen.getByTitle('Split Down'));
      expect(onSplit).toHaveBeenCalledWith('pane-1', 'vertical', 'after');
    });

    it('split Left calls onSplit with horizontal/before', () => {
      const onSplit = vi.fn();
      renderPane({ onSplit });
      const paneEl = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');
      fireEvent.mouseEnter(paneEl!);

      fireEvent.click(screen.getByTitle('Split Left'));
      expect(onSplit).toHaveBeenCalledWith('pane-1', 'horizontal', 'before');
    });

    it('split Right calls onSplit with horizontal/after', () => {
      const onSplit = vi.fn();
      renderPane({ onSplit });
      const paneEl = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');
      fireEvent.mouseEnter(paneEl!);

      fireEvent.click(screen.getByTitle('Split Right'));
      expect(onSplit).toHaveBeenCalledWith('pane-1', 'horizontal', 'after');
    });
  });

  describe('click and focus', () => {
    it('clicking pane calls onFocus', () => {
      const onFocus = vi.fn();
      renderPane({ onFocus });
      const paneEl = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');
      fireEvent.click(paneEl!);
      expect(onFocus).toHaveBeenCalledWith('pane-1');
    });
  });

  describe('drag and drop', () => {
    it('sets pane id on drag start', () => {
      renderPane();
      const paneEl = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');
      fireEvent.mouseEnter(paneEl!);

      // The draggable element is the chip, not the pane
      const draggable = screen.getByText('bold-falcon').closest('[draggable]');
      const dataTransfer = { setData: vi.fn(), effectAllowed: '' };
      fireEvent.dragStart(draggable!, { dataTransfer });
      expect(dataTransfer.setData).toHaveBeenCalledWith('text/x-pane-id', 'pane-1');
    });

    it('shows drag-over overlay during drag', () => {
      const { container } = renderPane();
      const paneEl = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');

      const dataTransfer = {
        types: ['text/x-pane-id'],
        dropEffect: '',
      };
      fireEvent.dragOver(paneEl!, { dataTransfer });

      // Should show a drag-over overlay
      expect(container.querySelector('.border-dashed')).toBeTruthy();
    });

    it('calls onSwap when drop occurs from a different pane', () => {
      const onSwap = vi.fn();
      renderPane({ onSwap });
      const paneEl = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');

      const dataTransfer = {
        types: ['text/x-pane-id'],
        getData: vi.fn().mockReturnValue('pane-2'),
        dropEffect: '',
      };
      fireEvent.drop(paneEl!, { dataTransfer });
      expect(onSwap).toHaveBeenCalledWith('pane-2', 'pane-1');
    });

    it('does not call onSwap when dropping on same pane', () => {
      const onSwap = vi.fn();
      renderPane({ onSwap });
      const paneEl = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');

      const dataTransfer = {
        types: ['text/x-pane-id'],
        getData: vi.fn().mockReturnValue('pane-1'),
        dropEffect: '',
      };
      fireEvent.drop(paneEl!, { dataTransfer });
      expect(onSwap).not.toHaveBeenCalled();
    });
  });

  describe('close pane', () => {
    it('shows close button on unassigned pane when canClose is true', () => {
      renderPane({
        pane: { ...defaultPane, agentId: null },
        canClose: true,
        agents: {},
      });
      expect(screen.getByTitle('Close pane')).toBeInTheDocument();
    });

    it('does not show close button when canClose is false', () => {
      renderPane({
        pane: { ...defaultPane, agentId: null },
        canClose: false,
        agents: {},
      });
      expect(screen.queryByTitle('Close pane')).toBeNull();
    });

    it('clicking close calls onClose', () => {
      const onClose = vi.fn();
      renderPane({
        pane: { ...defaultPane, agentId: null },
        canClose: true,
        agents: {},
        onClose,
      });
      fireEvent.click(screen.getByTitle('Close pane'));
      expect(onClose).toHaveBeenCalledWith('pane-1');
    });
  });

  describe('border styles', () => {
    it('applies orange border for needs_permission status', () => {
      const { container } = renderPane({
        detailedStatuses: { 'agent-1': { state: 'needs_permission', message: 'Allow?' } },
      });
      const pane = container.firstElementChild as HTMLElement;
      expect(pane.style.boxShadow).toContain('rgb(249,115,22)');
    });

    it('applies yellow border for tool_error status', () => {
      const { container } = renderPane({
        detailedStatuses: { 'agent-1': { state: 'tool_error', message: 'Error' } },
      });
      const pane = container.firstElementChild as HTMLElement;
      expect(pane.style.boxShadow).toContain('rgb(234,179,8)');
    });

    it('applies indigo border for focused pane', () => {
      const { container } = renderPane({ focused: true });
      const pane = container.firstElementChild as HTMLElement;
      expect(pane.style.boxShadow).toContain('rgb(99,102,241)');
    });

    it('adds animate-pulse class for needs_permission', () => {
      const { container } = renderPane({
        detailedStatuses: { 'agent-1': { state: 'needs_permission', message: 'Allow?' } },
      });
      const pane = container.firstElementChild as HTMLElement;
      expect(pane.className).toContain('animate-pulse');
    });
  });

  describe('completed agent ghost dismissal', () => {
    it('dismisses completed agent and unassigns pane', () => {
      const dismissCompleted = vi.fn();
      const onAssign = vi.fn();
      const completed: CompletedQuickAgent = {
        id: 'agent-1', projectId: 'proj-1', name: 'done-agent',
        mission: 'test', summary: null, filesModified: [],
        exitCode: 0, completedAt: Date.now(),
      };
      renderPane({
        pane: { ...defaultPane, agentId: 'agent-1' },
        agents: {},
        completedAgents: [completed],
        dismissCompleted,
        onAssign,
      });

      fireEvent.click(screen.getByTestId('ghost-dismiss'));
      expect(dismissCompleted).toHaveBeenCalledWith('proj-1', 'agent-1');
      expect(onAssign).toHaveBeenCalledWith('pane-1', null);
    });
  });
});
