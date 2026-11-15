import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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


const automaticMembership = { scope: { level: 'project' as const, projectId: 'p', reach: 'network' as const }, projectName: 'Alpha', editable: true };

describe('automatic membership and lost-link review', () => {
  beforeEach(() => {
    vi.spyOn(window.clubhouse.groupProject, 'listMembers').mockResolvedValue(view({ automaticMembership, includeLinkedComputers: true }));
  });

  it('previews toggle changes before applying and explains that off keeps members', async () => {
    const set = vi.spyOn(window.clubhouse.groupProject, 'setAutomaticMembership').mockResolvedValue(view({ automaticMembership, autoJoin: false }));
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    fireEvent.click(await screen.findByLabelText('Start with every agent in Alpha'));
    const review = await screen.findByRole('region', { name: 'Automatic membership review' });
    expect(review).toHaveTextContent('Current members stay');
    expect(set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply automatic membership' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('gp1', { autoJoin: false, includeLinkedComputers: true }));
    expect(screen.getByRole('list', { name: 'Members' })).toHaveTextContent('lead');
  });

  it('previews enabling linked computers with exclusions and can cancel without mutation', async () => {
    vi.mocked(window.clubhouse.groupProject.listMembers).mockResolvedValue(view({ automaticMembership, includeLinkedComputers: false }));
    const preview = vi.spyOn(window.clubhouse.groupProject, 'previewAutoJoin').mockResolvedValue({ wouldJoin: [{ agentId: 'remote', name: 'Remote', kind: 'durable', via: 'auto' }], unreadableProjects: [] });
    const set = vi.spyOn(window.clubhouse.groupProject, 'setAutomaticMembership');
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    fireEvent.click(await screen.findByLabelText('Include linked computers'));
    expect(await screen.findByRole('region', { name: 'Automatic membership review' })).toHaveTextContent('Remote');
    expect(preview).toHaveBeenCalledWith(automaticMembership.scope, { autoJoin: true, includeLinkedComputers: true, excluded: ['dev'] });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(set).not.toHaveBeenCalled();
  });

  it('disables controls on replicas and has no controls on an app group', async () => {
    vi.mocked(window.clubhouse.groupProject.listMembers).mockResolvedValue(view({ automaticMembership: { ...automaticMembership, editable: false } }));
    const { unmount } = render(<GroupProjectMembersSection groupProjectId="gp1" />);
    expect(await screen.findByLabelText('Start with every agent in Alpha')).toBeDisabled();
    expect(screen.getByLabelText('Include linked computers')).toBeDisabled();
    expect(screen.getByText('Only the host can change automatic membership.')).toBeInTheDocument();
    unmount();
    vi.mocked(window.clubhouse.groupProject.listMembers).mockResolvedValue(view());
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    await screen.findByRole('list', { name: 'Members' });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('lists lost-link members, confirms exact addresses, and requires another review after refusal', async () => {
    const leaving = [{ agentId: 'remote@machine', name: 'Remote', kind: 'durable' as const, via: 'auto' as const, projectName: 'Alpha on Laptop' }];
    vi.mocked(window.clubhouse.groupProject.listMembers).mockResolvedValue(view({ automaticMembership, coverageLeaving: leaving }));
    const confirm = vi.spyOn(window.clubhouse.groupProject, 'confirmUnlinkedMembers').mockRejectedValue(new Error('The members who would leave have changed. Review the change again.'));
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review linked membership' }));
    expect(screen.getByRole('region', { name: 'Linked membership review' })).toHaveTextContent('Remote (Alpha on Laptop)');
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply and remove 1' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('gp1', ['remote@machine']));
    expect(await screen.findByRole('alert')).toHaveTextContent('Review again');
    expect(screen.queryByRole('region', { name: 'Linked membership review' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Members' })).toHaveTextContent('lead');
  });
});
