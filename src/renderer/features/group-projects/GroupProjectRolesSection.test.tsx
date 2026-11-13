import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProjectRolesView } from '../../../shared/group-project-types';
import { GroupProjectRolesSection } from './GroupProjectRolesSection';

const roles = (extra: Partial<GroupProjectRolesView> = {}): GroupProjectRolesView => ({
  groupProjectId: 'gp1', own: { deliver: 'allow', wake: 'off' }, holders: [{ agentId: 'lead', lead: 'allow', admin: 'off' }], ...extra,
});

describe('GroupProjectRolesSection', () => {
  beforeEach(() => {
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
    expect(screen.getByLabelText('Wake a sleeping member when a lead taps it')).toHaveValue('off');
  });

  it('gives a role and changes an own grant', async () => {
    const setRole = vi.spyOn(window.clubhouse.groupProject, 'setRole').mockResolvedValue(roles({ holders: [{ agentId: 'dev', lead: 'ask', admin: 'off' }] }));
    const setOwnGrant = vi.spyOn(window.clubhouse.groupProject, 'setOwnGrant').mockResolvedValue(roles({ own: { deliver: 'allow', wake: 'allow' } }));
    render(<GroupProjectRolesSection groupProjectId="gp1" />);
    fireEvent.change(await screen.findByLabelText('Lead for dev'), { target: { value: 'ask' } });
    expect(setRole).toHaveBeenCalledWith('gp1', 'dev', 'lead', 'ask');
    expect(await screen.findByLabelText('Lead for dev')).toHaveValue('ask');
    fireEvent.change(screen.getByLabelText('Wake a sleeping member when a lead taps it'), { target: { value: 'allow' } });
    expect(setOwnGrant).toHaveBeenCalledWith('gp1', 'wake', 'allow');
  });
});
