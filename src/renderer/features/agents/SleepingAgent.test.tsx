import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SleepingAgent } from './SleepingAgent';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import type { Agent } from '../../../shared/types';

vi.mock('./SleepingMascots', () => ({
  SleepingMascot: ({ orchestrator, size }: { orchestrator?: string; size?: number }) => (
    <div data-testid="sleeping-mascot" data-orchestrator={orchestrator || ''} data-size={size} />
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

vi.mock('./SessionNamePromptDialog', () => ({
  SessionNamePromptDialog: ({ onDone }: { onDone: () => void }) => (
    <div data-testid="session-name-prompt-dialog">
      <button data-testid="mock-prompt-done" onClick={onDone}>Done Mock</button>
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

const mockSpawnDurableAgent = vi.fn();

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
    mockSpawnDurableAgent.mockResolvedValue(undefined);
    window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([]);
    window.clubhouse.agent.getSessionSummary = vi.fn().mockResolvedValue(null);
    window.clubhouse.git.info = vi.fn().mockResolvedValue(undefined);
    useAgentStore.setState({ agentIcons: {}, sessionNamePromptFor: null });
  });

  describe('rendering', () => {
    it('greets with one of the greeting lines instead of repeating the name as a heading', () => {
      renderComponent();
      const greeting = screen.getByTestId('sleeping-greeting');
      expect(greeting.textContent).toMatch(/\?|\.$/);
      expect(screen.queryByRole('heading', { name: 'bold-falcon' })).toBeNull();
    });

    it('says the agent is sleeping and how to wake it', () => {
      renderComponent();
      expect(screen.getByText(/bold-falcon is sleeping\. Give it a task/)).toBeInTheDocument();
    });

    it('shows Sleeping in the toolbar', () => {
      renderComponent();
      expect(screen.getByTestId('state-word')).toHaveTextContent('Sleeping');
    });

    it('renders an 88px hero mascot for the provider', () => {
      renderComponent({ orchestrator: 'codex-cli' });
      const mascot = screen.getByTestId('sleeping-mascot');
      expect(mascot).toHaveAttribute('data-orchestrator', 'codex-cli');
      expect(mascot).toHaveAttribute('data-size', '88');
    });

    it('leads with the agent icon and moves the mascot onto the composer at 48px', () => {
      useAgentStore.setState({ agentIcons: { 'agent-1': 'data:image/png;base64,abc' } });
      renderComponent({ icon: 'custom.png' });
      expect(screen.getByTestId('agent-icon-hero')).toHaveAttribute('src', 'data:image/png;base64,abc');
      expect(screen.getByTestId('sleeping-mascot')).toHaveAttribute('data-size', '48');
    });

    it('leads with the agent emoji when set', () => {
      renderComponent({ emoji: '\u{1F680}' });
      expect(screen.getByTestId('agent-icon-hero')).toHaveTextContent('\u{1F680}');
    });

    it('shows the provider glyph and model in the toolbar', () => {
      renderComponent({ orchestrator: 'copilot-cli', model: 'gpt-5' });
      expect(screen.getAllByRole('img', { name: 'GitHub Copilot' }).length).toBeGreaterThan(0);
      expect(screen.getAllByText('gpt-5').length).toBeGreaterThan(0);
    });

    it('shows "Session ended" for non-durable agent', () => {
      renderComponent({ kind: 'quick', status: 'sleeping' });
      expect(screen.getByText('Session ended')).toBeInTheDocument();
    });
  });

  describe('failed launch', () => {
    it('replaces the greeting with what went wrong', () => {
      renderComponent({ status: 'error', errorMessage: 'claude exited with code 1: Not logged in.' });
      expect(screen.getByTestId('sleeping-greeting')).toHaveTextContent("bold-falcon couldn't start");
      expect(screen.getByTestId('launch-error')).toHaveTextContent('claude exited with code 1: Not logged in.');
      expect(screen.getByTestId('state-word')).toHaveTextContent('Error');
    });

    it('falls back to a generic error for the provider', () => {
      renderComponent({ status: 'error', orchestrator: 'codex-cli' });
      expect(screen.getByTestId('launch-error')).toHaveTextContent('codex exited before it started.');
    });

    it('offers Retry and Open settings', () => {
      const openAgentSettings = vi.fn();
      useAgentStore.setState({ openAgentSettings });
      renderComponent({ status: 'error' });
      expect(screen.getByTestId('wake-button')).toHaveTextContent('Retry');
      fireEvent.click(screen.getByTestId('open-settings-button'));
      expect(openAgentSettings).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('last session', () => {
    it('shows the summary, branch and files touched', async () => {
      window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([{ id: 'agent-1', name: 'bold-falcon', lastSessionId: 'sess-1' }]);
      window.clubhouse.agent.getSessionSummary = vi.fn().mockResolvedValue({
        summary: 'Triaged the audit into issues.',
        filesModified: ['/wt/docs/a.md', '/wt/src/b.ts', '/wt/c.ts', '/wt/d.ts', '/wt/e.ts'],
        totalDurationMs: 41 * 60_000,
        totalCostUsd: 1.84,
        lastActiveAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      });
      window.clubhouse.git.info = vi.fn().mockResolvedValue({ hasGit: true, ahead: 2, remote: 'origin', status: [] });
      renderComponent({ branch: 'bold-falcon/standby', worktreePath: '/wt' });

      const section = await screen.findByTestId('last-session');
      expect(section).toHaveTextContent('Triaged the audit into issues.');
      expect(section).toHaveTextContent('3h ago · 41m · $1.84');
      expect(screen.getByTestId('last-session-branch')).toHaveTextContent('bold-falcon/standby');
      expect(screen.getByTestId('last-session-branch')).toHaveTextContent('2 commits ahead of origin');
      expect(screen.getByTestId('last-session-branch')).toHaveTextContent('nothing uncommitted');
      expect(screen.getAllByTestId('file-row')).toHaveLength(3);
      expect(section).toHaveTextContent('a.md');
      expect(section).toHaveTextContent('2 more files');
      expect(window.clubhouse.agent.getSessionSummary).toHaveBeenCalledWith('/projects/test', 'agent-1', 'sess-1', undefined);
      expect(screen.getByTestId('sleeping-toolbar')).toHaveTextContent('last active 3h ago');
    });

    it('is omitted when there is no history and no branch', async () => {
      renderComponent();
      await waitFor(() => expect(window.clubhouse.agent.listDurable).toHaveBeenCalled());
      expect(screen.queryByTestId('last-session')).toBeNull();
    });
  });

  describe('wake', () => {
    it('does not render the composer for quick agents', () => {
      renderComponent({ kind: 'quick', status: 'sleeping' });
      expect(screen.queryByTestId('wake-button')).toBeNull();
      expect(screen.queryByTestId('wake-composer')).toBeNull();
    });

    it('starts a fresh session when there is no session to resume', async () => {
      const durableConfig = { id: 'agent-1', name: 'bold-falcon' };
      window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([durableConfig]);
      renderComponent();
      fireEvent.click(screen.getByTestId('wake-button'));
      await waitFor(() => {
        expect(mockSpawnDurableAgent).toHaveBeenCalledWith('proj-1', '/projects/test', durableConfig, false, undefined);
      });
    });

    it('resumes the last session by default when there is one', async () => {
      const durableConfig = { id: 'agent-1', name: 'bold-falcon', lastSessionId: 'sess-1' };
      window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([durableConfig]);
      renderComponent();
      await waitFor(() => expect(window.clubhouse.agent.getSessionSummary).toHaveBeenCalled());
      fireEvent.click(screen.getByTestId('wake-button'));
      await waitFor(() => {
        expect(mockSpawnDurableAgent).toHaveBeenCalledWith('proj-1', '/projects/test', durableConfig, true, undefined);
      });
    });

    it('wakes with the typed task as the first message (Cmd+Enter)', async () => {
      const durableConfig = { id: 'agent-1', name: 'bold-falcon' };
      window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([durableConfig]);
      renderComponent();
      const input = screen.getByTestId('wake-task-input');
      fireEvent.change(input, { target: { value: '  Fix the flaky test  ' } });
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
      await waitFor(() => {
        expect(mockSpawnDurableAgent).toHaveBeenCalledWith('proj-1', '/projects/test', durableConfig, false, 'Fix the flaky test');
      });
    });

    it('plain Enter does not wake', () => {
      renderComponent();
      fireEvent.keyDown(screen.getByTestId('wake-task-input'), { key: 'Enter' });
      expect(window.clubhouse.agent.listDurable).toHaveBeenCalledTimes(1); // only the last-session load
      expect(mockSpawnDurableAgent).not.toHaveBeenCalled();
    });

    it('does not spawn if config not found', async () => {
      window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([{ id: 'other-agent', name: 'other' }]);
      renderComponent();
      fireEvent.click(screen.getByTestId('wake-button'));
      await waitFor(() => expect(window.clubhouse.agent.listDurable).toHaveBeenCalledTimes(2));
      expect(mockSpawnDurableAgent).not.toHaveBeenCalled();
    });

    it('does not spawn if project not found', async () => {
      useProjectStore.setState({ projects: [] });
      const agent = { ...baseAgent, kind: 'durable' as const, status: 'sleeping' as const };
      render(<SleepingAgent agent={agent} />);
      fireEvent.click(screen.getByTestId('wake-button'));
      await new Promise((r) => setTimeout(r, 50));
      expect(window.clubhouse.agent.listDurable).not.toHaveBeenCalled();
    });
  });

  describe('wake menu', () => {
    it('opens from the split toggle and closes on Escape', () => {
      renderComponent();
      expect(screen.queryByTestId('wake-dropdown-menu')).toBeNull();
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      expect(screen.getByRole('menu', { name: 'Wake options' })).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('wake-dropdown-menu')).toBeNull();
    });

    it('disables resume when there is no last session', () => {
      renderComponent();
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      expect(screen.getByTestId('wake-dropdown-menu-resume')).toHaveAttribute('aria-disabled', 'true');
    });

    it('wakes with a fresh session even when one could resume', async () => {
      const durableConfig = { id: 'agent-1', name: 'bold-falcon', lastSessionId: 'sess-1' };
      window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([durableConfig]);
      renderComponent();
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      fireEvent.click(screen.getByTestId('wake-dropdown-menu-fresh'));
      await waitFor(() => {
        expect(mockSpawnDurableAgent).toHaveBeenCalledWith('proj-1', '/projects/test', durableConfig, false, undefined);
      });
    });

    it('opens the session picker and resumes the chosen session', async () => {
      const durableConfig = { id: 'agent-1', name: 'bold-falcon' };
      window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([durableConfig]);
      renderComponent();
      fireEvent.click(screen.getByTestId('wake-dropdown-toggle'));
      fireEvent.click(screen.getByTestId('wake-dropdown-menu-browse'));
      fireEvent.click(screen.getByTestId('mock-resume'));
      await waitFor(() => {
        expect(mockSpawnDurableAgent).toHaveBeenCalledWith(
          'proj-1', '/projects/test', { ...durableConfig, lastSessionId: 'test-session-123' }, true, undefined,
        );
      });
    });

    it('the toolbar Sessions button opens the session picker', () => {
      renderComponent();
      fireEvent.click(screen.getByTestId('sessions-button'));
      expect(screen.getByTestId('session-picker-dialog')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('mock-close'));
      expect(screen.queryByTestId('session-picker-dialog')).toBeNull();
    });
  });

  describe('session name prompt', () => {
    it('shows session name prompt when sessionNamePromptFor matches agent', () => {
      useAgentStore.setState({ sessionNamePromptFor: 'agent-1', setSessionNamePrompt: vi.fn() });
      renderComponent();
      expect(screen.getByTestId('session-name-prompt-dialog')).toBeInTheDocument();
    });

    it('does not show session name prompt when sessionNamePromptFor does not match', () => {
      useAgentStore.setState({ sessionNamePromptFor: 'other-agent', setSessionNamePrompt: vi.fn() });
      renderComponent();
      expect(screen.queryByTestId('session-name-prompt-dialog')).toBeNull();
    });

    it('clears prompt when done', () => {
      const mockSetSessionNamePrompt = vi.fn();
      useAgentStore.setState({ sessionNamePromptFor: 'agent-1', setSessionNamePrompt: mockSetSessionNamePrompt });
      renderComponent();
      fireEvent.click(screen.getByTestId('mock-prompt-done'));
      expect(mockSetSessionNamePrompt).toHaveBeenCalledWith(null);
    });
  });
});
