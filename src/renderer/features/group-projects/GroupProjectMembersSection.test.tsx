import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProjectMembershipView } from '../../../shared/group-project-types';
import { GroupProjectMembersSection } from './GroupProjectMembersSection';

const view = (extra: Partial<GroupProjectMembershipView> = {}): GroupProjectMembershipView => ({
  groupProjectId: 'gp1',
  managed: true,
  autoJoin: true,
  members: [
    { agentId: 'lead', name: 'lead', kind: 'durable', via: 'auto', projectId: 'p', projectName: 'Alpha' },
    { agentId: 'h1', name: 'h1', kind: 'helper', via: 'explicit', projectId: 'p', projectName: 'Alpha' },
  ],
  excluded: [{ agentId: 'dev', name: 'dev', excludedAt: '2026-11-13T00:00:00Z' }],
  ...extra,
});

describe('GroupProjectMembersSection', () => {
  beforeEach(() => {
    vi.spyOn(window.clubhouse.groupProject, 'listMembers').mockResolvedValue(view());
  });

  it('lists members with how they joined, and the exclusions', async () => {
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    const members = await screen.findByRole('list', { name: 'Members' });
    expect(members).toHaveTextContent('lead');
    expect(members).toHaveTextContent('Agent, joined by being in scope, Alpha');
    expect(members).toHaveTextContent('Helper, added, Alpha');
    expect(screen.getByRole('list', { name: 'Excluded agents' })).toHaveTextContent('dev');
  });

  it('excludes a durable agent, removes a helper, and includes an excluded agent again', async () => {
    const exclude = vi.spyOn(window.clubhouse.groupProject, 'excludeMember').mockResolvedValue(view());
    const add = vi.spyOn(window.clubhouse.groupProject, 'addMember').mockResolvedValue(view());
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Exclude lead' }));
    expect(exclude).toHaveBeenCalledWith('gp1', 'lead');
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Remove h1' }));
    expect(exclude).toHaveBeenCalledWith('gp1', 'h1');
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Include dev again' }));
    expect(add).toHaveBeenCalledWith('gp1', 'dev');
  });

  it('shows the one-time offer with who would join, and answers it', async () => {
    vi.mocked(window.clubhouse.groupProject.listMembers).mockResolvedValue(view({
      autoJoin: false,
      autoJoinOffer: { state: 'pending', wouldJoin: [{ agentId: 'qa', name: 'qa', kind: 'durable', via: 'auto' }] },
    }));
    const answer = vi.spyOn(window.clubhouse.groupProject, 'answerAutoJoinOffer').mockResolvedValue(view());
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    expect(await screen.findByText('Include every agent in scope? 1 would join: qa.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Include every agent in scope' }));
    expect(answer).toHaveBeenCalledWith('gp1', true);
    expect(await screen.findByRole('list', { name: 'Members' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Include every agent in scope' })).not.toBeInTheDocument();
  });

  it('reloads when its membership changes, and reports a failed change without losing the list', async () => {
    let changed: ((id: string) => void) | undefined;
    vi.spyOn(window.clubhouse.groupProject, 'onMembershipChanged').mockImplementation((fn) => { changed = fn; return () => undefined; });
    vi.spyOn(window.clubhouse.groupProject, 'excludeMember').mockRejectedValue(new Error('Disk unavailable'));
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    await screen.findByRole('list', { name: 'Members' });
    vi.mocked(window.clubhouse.groupProject.listMembers).mockResolvedValue(view({ members: [] }));
    await act(async () => { changed?.('gp1'); });
    expect(screen.getByText('No members.')).toBeInTheDocument();

    vi.mocked(window.clubhouse.groupProject.listMembers).mockResolvedValue(view());
    await act(async () => { changed?.('gp1'); });
    fireEvent.click(screen.getByRole('button', { name: 'Exclude lead' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not changed. Disk unavailable');
    expect(screen.getByRole('list', { name: 'Members' })).toHaveTextContent('lead');
  });
});
