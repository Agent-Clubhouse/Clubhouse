import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActionView } from '../../../shared/actions';
import { AgentActionsCard, AgentActionsPage, agentActionGroups } from './AgentActionsPage';
import { useAgentStore } from '../../stores/agentStore';

function action(id: string, over: Partial<ActionView>): ActionView {
  return {
    id, name: id, trigger: { kind: 'schedule', preset: 'daily', cron: '0 9 * * *', missed: 'skip' }, steps: [{ kind: 'notify', text: 'x' }],
    overlap: 'skip', owner: { kind: 'user' }, enabled: true, createdAt: 1, updatedAt: 1, running: false, ...over,
  };
}

const list = [
  action('wakes', { steps: [{ kind: 'wake', agentId: 'lead' }] }),
  action('worktree', { steps: [{ kind: 'quick', projectId: 'p1', worktreeAgentId: 'lead', prompt: 'x' }] }),
  action('mine', { trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'lead' } } }),
  action('project', { trigger: { kind: 'event', event: 'agent.woke', source: { kind: 'project', projectId: 'p1' } } }),
  action('made', { owner: { kind: 'agent', agentId: 'lead' } }),
  action('unrelated', { steps: [{ kind: 'wake', agentId: 'pm' }] }),
];

describe('agent Actions page', () => {
  it('groups actions that act on, are set off by, and were made by an agent', () => {
    const g = agentActionGroups(list, 'lead', 'p1');
    expect(g.targeting.map((a) => a.id)).toEqual(['wakes', 'worktree']);
    expect(g.triggeredBy.map((a) => a.id)).toEqual(['mine', 'project']);
    expect(g.owned.map((a) => a.id)).toEqual(['made']);
  });

  describe('agent Actions details card', () => {
    const reminder = action('reminder', {
      name: 'Progress reminder',
      owner: { kind: 'agent', agentId: 'lead' },
      trigger: { kind: 'schedule', preset: 'cron', cron: '*/30 * * * *', missed: 'skip' },
      steps: [{ kind: 'message', agentId: 'lead', text: 'Report progress' }],
    });

    beforeEach(() => {
      window.clubhouse.actions.history = vi.fn(async () => []);
      window.clubhouse.actions.runNow = vi.fn();
      window.clubhouse.actions.setEnabled = vi.fn();
      window.clubhouse.actions.update = vi.fn(async () => reminder);
      useAgentStore.setState({ agents: {
        lead: { id: 'lead', projectId: 'p1', name: 'release-lead', kind: 'durable', status: 'sleeping', color: 'teal' },
      } });
    });

    it('uses the existing relationship groups and counts each related action once', async () => {
      window.clubhouse.actions.list = vi.fn(async () => [...list, reminder]);
      render(<AgentActionsCard agentId="lead" agentName="release-lead" projectId="p1" open onToggle={() => {}} />);
      expect(await screen.findByText('Made by release-lead')).toBeInTheDocument();
      expect(screen.getByTestId('details-card-actions-summary')).toHaveTextContent('6 related');
      expect(screen.getByText('Act on release-lead')).toBeInTheDocument();
      expect(screen.getByText('Set off by release-lead')).toBeInTheDocument();
      expect(screen.queryByText('unrelated')).not.toBeInTheDocument();
    });

    it('directly manages an owned 30-minute reminder with the existing UI and owner', async () => {
      window.clubhouse.actions.list = vi.fn(async () => [reminder]);
      render(<AgentActionsCard agentId="lead" agentName="release-lead" projectId="p1" open onToggle={() => {}} />);
      fireEvent.click((await screen.findAllByTestId('agent-action-row'))[0]);
      const card = await screen.findByTestId('action-card');
      fireEvent.click(within(card).getByRole('button', { name: 'Run now' }));
      await waitFor(() => expect(window.clubhouse.actions.runNow).toHaveBeenCalledWith('reminder'));
      fireEvent.click(within(card).getByRole('switch', { name: 'Action on' }));
      await waitFor(() => expect(window.clubhouse.actions.setEnabled).toHaveBeenCalledWith('reminder', false));
      fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
      const form = await screen.findByTestId('action-form');
      expect(within(form).getByLabelText('Schedule line')).toHaveValue('*/30 * * * *');
      expect(form).toHaveTextContent('Usage counts toward release-lead.');
      fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Progress check' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(window.clubhouse.actions.update).toHaveBeenCalledWith('reminder', expect.objectContaining({
        name: 'Progress check', trigger: reminder.trigger, steps: reminder.steps,
      })));
      expect(vi.mocked(window.clubhouse.actions.update).mock.calls[0][1]).not.toHaveProperty('owner');
      await waitFor(() => expect(screen.queryByTestId('action-form')).not.toBeInTheDocument());
    });

    it('surfaces a failed list read and retries instead of showing an empty success state', async () => {
      window.clubhouse.actions.list = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue([]);
      render(<AgentActionsCard agentId="lead" agentName="release-lead" projectId="p1" open onToggle={() => {}} />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
      expect(screen.queryByText(/No actions are made/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText('No actions are made by, act on or are set off by release-lead.')).toBeInTheDocument();
    });
  });

  beforeEach(() => { window.clubhouse.actions.list = vi.fn(async () => []); });

  it('says so in one line when a group is empty', async () => {
    render(<AgentActionsPage agentId="lead" agentName="release-lead" projectId="p1" />);
    expect(await screen.findByText('No action acts on release-lead.')).toBeTruthy();
    expect(screen.getByText('release-lead hasn’t made any actions.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New action for release-lead' })).toBeTruthy();
  });
});
