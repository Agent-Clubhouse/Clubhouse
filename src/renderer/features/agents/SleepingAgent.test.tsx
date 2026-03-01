import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SleepingAgent } from './SleepingAgent';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import type { Agent } from '../../../shared/types';

vi.mock('./SleepingMascots', () => ({
  SleepingMascot: ({ orchestrator }: { orchestrator?: string }) => (
    <div data-testid="sleeping-mascot" data-orchestrator={orchestrator || ''} />
  ),
}));

vi.mock('./SessionPickerDialog', () => ({
  SessionPickerDialog: ({ onResume, onClose }: { onResume: (id: string) => void; onClose: () => void }) => (
    <div data-testid="session-picker-dialog">
      <button data-testid="mock-resume" onClick={() => onResume('test-session-123')}>Resume Mock</button>
      <button data-testid="mock-close" onClick={onClose}>Close Mock</button>
    </div>
  ),
}));

const baseAgent: Agent = {
  id: 'agent-1',
  projectId: 'proj-1',
  name: 'bold-falcon',
  kind: 'durable',
  status: 'sleeping',
  color: 'indigo',
};

const mockSpawnDurableAgent = vi.fn().mockResolvedValue(undefined);

function resetStores(agentOverrides: Partial<Agent> = {}) {
  const agent = { ...baseAgent, ...agentOverrides };
  useAgentStore.setState({
    agents: { [agent.id]: agent },
    spawnDurableAgent: mockSpawnDurableAgent,
  });
  useProjectStore.setState({
    projects: [{ id: 'proj-1', name: 'test-project', path: '/projects/test' }],
    activeProjectId: 'proj-1',
  });
}

function renderComponent(agentOverrides: Partial<Agent> = {}) {
  const agent = { ...baseAgent, ...agentOverrides };
  resetStores(agentOverrides);
  return render(<SleepingAgent agent={agent} />);
}

describe('SleepingAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([]);
  });

  describe('rendering', () => {
    it('renders agent name', () => {
      renderComponent();
      expect(screen.getByText('bold-falcon')).toBeInTheDocument();
    });

    it('renders sleeping mascot', () => {
      renderComponent();
      expect(screen.getByTestId('sleeping-mascot')).toBeInTheDocument();
    });

    it('passes orchestrator to SleepingMascot', () => {
      renderComponent({ orchestrator: 'claude-code' });
      expect(screen.getByTestId('sleeping-mascot')).toHaveAttribute('data-orchestrator', 'claude-code');
    });

    it('shows "This agent is sleeping" for sleeping durable agent', () => {
      renderComponent({ kind: 'durable', status: 'sleeping' });
      expect(screen.getByText('This agent is sleeping')).toBeInTheDocument();
    });

    it('shows "Session ended" for non-durable agent', () => {
      renderComponent({ kind: 'quick', status: 'sleeping' });
      expect(screen.getByText('Session ended')).toBeInTheDocument();
    });

    it('shows "Failed to launch" for error status', () => {
      renderComponent({ status: 'error' });
      expect(screen.getByText('Failed to launch')).toBeInTheDocument();
    });

    it('shows custom error message when available', () => {
      renderComponent({ status: 'error', errorMessage: 'CLI not found' });
      expect(screen.getByText('CLI not found')).toBeInTheDocument();
    });

    it('shows default error hint when no errorMessage', () => {
      renderComponent({ status: 'error' });
      expect(screen.getByText('Check that the CLI is installed and your API key is configured')).toBeInTheDocument();
    });
  });

  describe('color indicator', () => {
    it('renders color dot for durable agents', () => {
      const { container } = renderComponent({ kind: 'durable', color: 'indigo' });
      const dot = container.querySelector('.rounded-full');
      expect(dot).toBeTruthy();
    });

    it('does not render color dot for quick agents', () => {
      const { container } = renderComponent({ kind: 'quick' });
      const dot = container.querySelector('.w-3.h-3.rounded-full');
      expect(dot).toBeNull();
    });
  });

  describe('branch display', () => {
    it('shows branch name when branch is set', () => {
      renderComponent({ branch: 'feature/test' });
      expect(screen.getByText('Branch:')).toBeInTheDocument();
      expect(screen.getByText('feature/test')).toBeInTheDocument();
    });

    it('does not show branch when not set', () => {
      renderComponent();
      expect(screen.queryByText('Branch:')).toBeNull();
    });
  });

  describe('wake button', () => {
    it('renders Wake Up button for sleeping durable agent', () => {
      renderComponent({ kind: 'durable', status: 'sleeping' });
      expect(screen.getByText('Wake Up')).toBeInTheDocument();
    });

    it('renders Retry button for error durable agent', () => {
      renderComponent({ kind: 'durable', status: 'error' });
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('does not render wake button for quick agents', () => {
      renderComponent({ kind: 'quick', status: 'sleeping' });
      expect(screen.queryByText('Wake Up')).toBeNull();
      expect(screen.queryByText('Retry')).toBeNull();
    });

    it('calls spawnDurableAgent with resume=false when Wake Up is clicked', async () => {
      const durableConfig = { id: 'agent-1', name: 'bold-falcon' };
      window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([durableConfig]);

      renderComponent({ kind: 'durable', status: 'sleeping' });
      fireEvent.click(screen.getByText('Wake Up'));

      await waitFor(() => {
        expect(window.clubhouse.agent.listDurable).toHaveBeenCalledWith('/projects/test');
      });

      await waitFor(() => {
        expect(mockSpawnDurableAgent).toHaveBeenCalledWith(
          'proj-1',
          '/projects/test',
          durableConfig,
          false,
        );
      });
    });

    it('does not spawn if config not found', async () => {
      window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([
        { id: 'other-agent', name: 'other' },
      ]);

      renderComponent({ kind: 'durable', status: 'sleeping' });
      fireEvent.click(screen.getByText('Wake Up'));

      await waitFor(() => {
        expect(window.clubhouse.agent.listDurable).toHaveBeenCalled();
      });

      expect(mockSpawnDurableAgent).not.toHaveBeenCalled();
    });

    it('does not spawn if project not found', async () => {
      useProjectStore.setState({ projects: [] });
      const agent = { ...baseAgent, kind: 'durable' as const, status: 'sleeping' as const };
      render(<SleepingAgent agent={agent} />);
      fireEvent.click(screen.getByText('Wake Up'));

      // Should return early without calling listDurable
      await new Promise((r) => setTimeout(r, 50));
      expect(window.clubhouse.agent.listDurable).not.toHaveBeenCalled();
    });
  });

  describe('split button dropdown', () => {
    it('renders dropdown toggle for durable agents', () => {
      renderComponent({ kind: 'durable', status: 'sleeping' });
      expect(screen.getByTestId('wake-dropdown-toggle')).toBeInTheDocument();
    });

    it('shows dropdown menu when toggle is clicked', () => {
      renderComponent({ kind: 'durable', status: 'sleeping' });
      expect(screen.queryByTestId('wake-dropdown-menu')).toBeNull();
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      expect(screen.getByTestId('wake-dropdown-menu')).toBeInTheDocument();
    });

    it('dropdown contains Wake & Resume option', () => {
      renderComponent({ kind: 'durable', status: 'sleeping' });
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      expect(screen.getByTestId('wake-resume-option')).toBeInTheDocument();
    });

    it('calls spawnDurableAgent with resume=true when Wake & Resume is clicked', async () => {
      const durableConfig = { id: 'agent-1', name: 'bold-falcon' };
      window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([durableConfig]);

      renderComponent({ kind: 'durable', status: 'sleeping' });
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      fireEvent.click(screen.getByTestId('wake-resume-option'));

      await waitFor(() => {
        expect(mockSpawnDurableAgent).toHaveBeenCalledWith(
          'proj-1',
          '/projects/test',
          durableConfig,
          true,
        );
      });
    });

    it('closes dropdown on Escape', () => {
      renderComponent({ kind: 'durable', status: 'sleeping' });
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      expect(screen.getByTestId('wake-dropdown-menu')).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('wake-dropdown-menu')).toBeNull();
    });

    it('dropdown contains Browse Sessions option', () => {
      renderComponent({ kind: 'durable', status: 'sleeping' });
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      expect(screen.getByTestId('browse-sessions-option')).toBeInTheDocument();
    });

    it('opens session picker when Browse Sessions is clicked', () => {
      renderComponent({ kind: 'durable', status: 'sleeping' });
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      fireEvent.click(screen.getByTestId('browse-sessions-option'));
      expect(screen.getByTestId('session-picker-dialog')).toBeInTheDocument();
    });

    it('resumes specific session from session picker', async () => {
      const durableConfig = { id: 'agent-1', name: 'bold-falcon' };
      window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([durableConfig]);

      renderComponent({ kind: 'durable', status: 'sleeping' });
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      fireEvent.click(screen.getByTestId('browse-sessions-option'));

      fireEvent.click(screen.getByTestId('mock-resume'));

      await waitFor(() => {
        expect(mockSpawnDurableAgent).toHaveBeenCalledWith(
          'proj-1',
          '/projects/test',
          { ...durableConfig, lastSessionId: 'test-session-123' },
          true,
        );
      });
    });

    it('closes session picker when close is clicked', () => {
      renderComponent({ kind: 'durable', status: 'sleeping' });
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      fireEvent.click(screen.getByTestId('browse-sessions-option'));
      expect(screen.getByTestId('session-picker-dialog')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('mock-close'));
      expect(screen.queryByTestId('session-picker-dialog')).toBeNull();
    });
  });
});
