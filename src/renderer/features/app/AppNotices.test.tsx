import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AppNotices, CollapsedSidebarNotices } from './AppNotices';
import { usePluginStore } from '../../plugins/plugin-store';
import { useChromeStore } from '../../chrome/chromeStore';
import { useAgentStore } from '../../stores/agentStore';
import { useDispatcherStore } from '../dispatcher/dispatcherStore';
import { DISPATCHER_OFF } from '../../../shared/dispatcher-types';
import { processResumeQueue, resumeFromBanner } from '../../services/resume-queue';
import { removeAgentsFromState } from '../../stores/agent/agentUtils';
import type { RestartSessionEntry } from '../../../shared/types';

const violation = { pluginId: 'p', pluginName: 'Bad Plugin', permission: 'git', apiName: 'git', timestamp: 1 };

describe('AppNotices', () => {
  beforeEach(() => {
    usePluginStore.setState({ permissionViolations: [] });
    useChromeStore.setState({ sidebarCollapsed: false });
    useAgentStore.setState({ agents: {}, resumingAgents: {}, resumeAgentNames: {} });
    useDispatcherStore.setState({ state: null });
  });

  it('stacks notices as cards in the sidebar slot', () => {
    usePluginStore.setState({ permissionViolations: [violation] });
    render(<AppNotices variant="card" />);
    const slot = screen.getByTestId('sidebar-notices');
    expect(slot).toContainElement(screen.getByTestId('permission-violation-banner'));
    expect(screen.getByTestId('permission-violation-banner').className).toContain('rounded-lg');
  });

  it('renders an empty slot when there is nothing to show', () => {
    render(<AppNotices variant="card" />);
    expect(screen.getByTestId('sidebar-notices')).toBeEmptyDOMElement();
  });

  it('shows the bars only while the sidebar is collapsed', () => {
    usePluginStore.setState({ permissionViolations: [violation] });
    const { rerender } = render(<CollapsedSidebarNotices />);
    expect(screen.queryByTestId('permission-violation-banner')).toBeNull();
    useChromeStore.setState({ sidebarCollapsed: true });
    rerender(<CollapsedSidebarNotices />);
    expect(screen.getByTestId('permission-violation-banner').className).toContain('border-b');
  });

  it('uses the captured chat name before the agent loads, in both notice variants', () => {
    useAgentStore.setState({ resumingAgents: { chat: 'manual' }, resumeAgentNames: { chat: 'Sage' } });
    const { rerender } = render(<AppNotices variant="card" />);
    expect(screen.getByTestId('resume-banner')).toHaveTextContent('Sage');
    rerender(<AppNotices variant="bar" />);
    expect(screen.getByTestId('resume-banner')).toHaveTextContent('Sage');
    expect(screen.getByTestId('resume-banner')).not.toHaveTextContent('chat');
  });

  it('uses Dispatcher identity when an older captured chat name was only its id', () => {
    useAgentStore.setState({ resumingAgents: { chat: 'manual' }, resumeAgentNames: { chat: 'chat' } });
    useDispatcherStore.setState({ state: {
      ...DISPATCHER_OFF, chatAgentId: 'chat', config: { id: 'work', name: 'Sage', color: 'blue', createdAt: '' },
    } });
    render(<AppNotices variant="card" />);
    expect(screen.getByTestId('resume-banner')).toHaveTextContent('Sage');
    expect(screen.getByTestId('resume-banner')).not.toHaveTextContent('chat');
  });

  describe('Resume and Retry buttons run the real resume', () => {
    const spawnAgent = vi.fn();
    const getRunningStatuses = vi.fn();
    const entry: RestartSessionEntry = {
      agentId: 'zesty-lynx',
      agentName: 'zesty-lynx',
      projectPath: '/projects/test',
      orchestrator: 'claude-code',
      sessionId: 'sess-1',
      resumeStrategy: 'manual',
      kind: 'durable',
    };

    beforeEach(() => {
      spawnAgent.mockReset().mockResolvedValue(undefined);
      getRunningStatuses.mockReset().mockResolvedValue([]);
      Object.assign(window, {
        clubhouse: {
          ...(window as unknown as { clubhouse: object }).clubhouse,
          agent: { spawnAgent, getDurableConfig: vi.fn().mockResolvedValue(null), readIcon: vi.fn().mockResolvedValue(null), getRunningStatuses },
          pty: { kill: vi.fn() },
        },
      });
      useAgentStore.setState({ agents: {}, resumingAgents: {}, resumeAgentNames: {}, resumeErrors: {} });
    });

    const queue = () => processResumeQueue({
      version: 1, capturedAt: new Date().toISOString(), appVersion: '1.0.0', sessions: [entry],
    });

    it.each(['card', 'bar'] as const)('%s: Resume spawns the session with resume on', async (variant) => {
      await queue();
      render(<AppNotices variant={variant} />);
      expect(spawnAgent).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

      await waitFor(() => expect(useAgentStore.getState().resumingAgents['zesty-lynx']).toBe('resumed'));
      expect(spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'zesty-lynx', resume: true, sessionId: 'sess-1' }),
      );
    });

    it.each(['card', 'bar'] as const)('%s: a failed resume shows its error and Retry runs it again', async (variant) => {
      await queue();
      render(<AppNotices variant={variant} />);
      spawnAgent.mockRejectedValueOnce(new Error('CLI not installed'));

      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      expect(await screen.findByText('CLI not installed')).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(useAgentStore.getState().resumingAgents['zesty-lynx']).toBe('resumed'));
      expect(spawnAgent).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('CLI not installed')).toBeNull();
    });

    it.each(['card', 'bar'] as const)('%s: Retry on a timed-out session runs the resume', async (variant) => {
      await queue();
      useAgentStore.getState().setResumeStatus('zesty-lynx', 'timed_out');
      render(<AppNotices variant={variant} />);

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      await waitFor(() => expect(spawnAgent).toHaveBeenCalledTimes(1));
      expect(useAgentStore.getState().resumingAgents['zesty-lynx']).toBe('resumed');
    });

    it('shows an IPC rejection without Electron\'s prefix', async () => {
      await queue();
      render(<AppNotices variant="card" />);
      spawnAgent.mockRejectedValueOnce(new Error("Error invoking remote method 'agent:spawn': Error: Cannot verify the saved execution policy"));

      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

      expect(await screen.findByText('Cannot verify the saved execution policy')).toBeDefined();
      expect(screen.getByTestId('resume-banner')).not.toHaveTextContent('Error invoking');
    });

    it('a deleted agent drops its row, and its stale button cannot bring it back', async () => {
      await queue();
      render(<AppNotices variant="card" />);
      spawnAgent.mockRejectedValueOnce(new Error('CLI not installed'));
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      await screen.findByText('CLI not installed');
      const retry = screen.getByRole('button', { name: 'Retry' });
      spawnAgent.mockClear();

      useAgentStore.setState((s) => removeAgentsFromState(s, ['zesty-lynx']));
      const state = useAgentStore.getState();
      expect(state.resumingAgents).toEqual({});
      expect(state.resumeErrors).toEqual({});
      await waitFor(() => expect(screen.queryByTestId('resume-banner')).toBeNull());

      // A click that was already in flight, or a later caller, still does nothing.
      fireEvent.click(retry);
      await resumeFromBanner('zesty-lynx');
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(useAgentStore.getState().agents['zesty-lynx']).toBeUndefined();
      expect(useAgentStore.getState().resumingAgents).toEqual({});
    });

    it('Retry does not spawn over an agent that was woken another way; the row is marked resumed', async () => {
      await queue();
      render(<AppNotices variant="card" />);
      spawnAgent.mockRejectedValueOnce(new Error('CLI not installed'));
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      await screen.findByText('CLI not installed');
      spawnAgent.mockClear();
      getRunningStatuses.mockResolvedValue(['zesty-lynx']);

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      await waitFor(() => expect(useAgentStore.getState().resumingAgents['zesty-lynx']).toBe('resumed'));
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(useAgentStore.getState().resumeErrors).toEqual({});
    });

    it('two overlapping calls for one agent spawn once', async () => {
      await queue();
      await Promise.all([resumeFromBanner('zesty-lynx'), resumeFromBanner('zesty-lynx')]);
      expect(spawnAgent).toHaveBeenCalledTimes(1);
    });

    it('Dismiss drops the saved sessions, so a later call does nothing', async () => {
      await queue();
      useAgentStore.getState().clearResumingAgents();
      await resumeFromBanner('zesty-lynx');
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(useAgentStore.getState().resumingAgents).toEqual({});
    });
  });
});
