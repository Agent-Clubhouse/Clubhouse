import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProjectRolesView } from '../../../shared/group-project-types';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { GroupProjectRolesSection } from './GroupProjectRolesSection';

const roles = (extra: Partial<GroupProjectRolesView> = {}): GroupProjectRolesView => ({
  groupProjectId: 'gp1', own: { deliver: 'allow', wake: 'off', actions: 'allow' }, holders: [{ agentId: 'lead', lead: 'allow', admin: 'off' }], ...extra,
});

describe('GroupProjectRolesSection', () => {
  beforeEach(() => {
    useGroupProjectStore.setState({ projects: [{ id: 'gp1', name: 'Group', description: '', instructions: '', createdAt: '', metadata: {} }], operations: {} });
    vi.spyOn(window.clubhouse.groupProject, 'getRoles').mockResolvedValue(roles());
    vi.spyOn(window.clubhouse.groupProject, 'listMembers').mockResolvedValue({
      groupProjectId: 'gp1', managed: true, autoJoin: true, excluded: [],
      members: [{ agentId: 'lead', name: 'lead', kind: 'durable', via: 'auto' }, { agentId: 'dev', name: 'dev', kind: 'durable', via: 'auto' }],
    });
  });

  it('shows the group project\'s own grants and each member\'s lead and admin', async () => {
    render(<GroupProjectRolesSection groupProjectId="gp1" />);
    expect(await screen.findByLabelText('Lead for lead')).toHaveValue('allow');
    expect(screen.getByLabelText('Lead for dev')).toHaveValue('off');
    expect(screen.getByLabelText('Admin for lead')).toHaveValue('off');
    expect(screen.getByLabelText('Tell members about new posts')).toHaveValue('allow');
    expect(screen.getByLabelText('Wake sleeping members')).toHaveValue('off');
  });

  it('reconciles the permission control and post notification status when the host confirms a grant change', async () => {
    render(<GroupProjectRolesSection groupProjectId="gp1" />);
    expect(await screen.findByLabelText('Tell members about new posts')).toHaveValue('allow');
    expect(screen.getByRole('status', { name: 'Post notifications' })).toHaveTextContent('Post notifications: On');
    vi.mocked(window.clubhouse.groupProject.getRoles).mockResolvedValue(roles({ own: { deliver: 'off', wake: 'off', actions: 'allow' } }));
    act(() => useGroupProjectStore.setState((s) => ({ projects: s.projects.map((p) => ({ ...p, metadata: { grants: { deliver: 'off' } } })) })));
    await waitFor(() => expect(screen.getByLabelText('Tell members about new posts')).toHaveValue('off'));
    expect(screen.getByRole('status', { name: 'Post notifications' })).toHaveTextContent('Post notifications: Off');
  });

  it('gives a role and changes an own grant', async () => {
    const setRole = vi.spyOn(window.clubhouse.groupProject, 'setRole').mockResolvedValue(roles({ holders: [{ agentId: 'dev', lead: 'ask', admin: 'off' }] }));
    const setOwnGrant = vi.spyOn(window.clubhouse.groupProject, 'setOwnGrant').mockResolvedValue(roles({ own: { deliver: 'allow', wake: 'allow', actions: 'allow' } }));
    render(<GroupProjectRolesSection groupProjectId="gp1" />);
    fireEvent.change(await screen.findByLabelText('Lead for dev'), { target: { value: 'ask' } });
    expect(setRole).toHaveBeenCalledWith('gp1', 'dev', 'lead', 'ask');
    expect(await screen.findByLabelText('Lead for dev')).toHaveValue('ask');
    fireEvent.change(screen.getByLabelText('Wake sleeping members'), { target: { value: 'allow' } });
    expect(setOwnGrant).toHaveBeenCalledWith('gp1', 'wake', 'allow');
    fireEvent.change(await screen.findByLabelText('Run group project Actions'), { target: { value: 'off' } });
    expect(setOwnGrant).toHaveBeenCalledWith('gp1', 'actions', 'off');
  });
});
