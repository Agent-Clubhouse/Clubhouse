import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ActionView } from '../../../shared/actions';
import { AgentActionsPage, agentActionGroups } from './AgentActionsPage';

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

  beforeEach(() => { window.clubhouse.actions.list = vi.fn(async () => []); });

  it('says so in one line when a group is empty', async () => {
    render(<AgentActionsPage agentId="lead" agentName="release-lead" projectId="p1" />);
    expect(await screen.findByText('No action acts on release-lead.')).toBeTruthy();
    expect(screen.getByText('release-lead hasn’t made any actions.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New action for release-lead' })).toBeTruthy();
  });
});
