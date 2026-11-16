/** #3548: the Members and Permissions sections with the host's roster, an incomplete one, and none. */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProject, GroupProjectMembershipView, GroupProjectRolesView } from '../../../shared/group-project-types';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import type { GroupProjectRosterMember, GroupProjectRosterView } from '../../../shared/group-project-roster';
import { GroupProjectMembersSection } from './GroupProjectMembersSection';
import { GroupProjectRolesSection } from './GroupProjectRolesSection';

const DESK = Array.from({ length: 32 }, () => 'aa').join(':');
const STUDIO = Array.from({ length: 32 }, () => 'bb').join(':');
const ATTIC = Array.from({ length: 32 }, () => 'cc').join(':');

/** This computer is Studio, holding a copy of Desk's group. */
const localView = (): GroupProjectMembershipView => ({
  groupProjectId: 'gp1', managed: true, autoJoin: true, excluded: [],
  members: [{ agentId: 'builder_b', name: 'Builder', kind: 'durable', via: 'auto', projectName: 'App' }],
});

const member = (agentId: string, machine: string, machineLabel: string, extra: Partial<GroupProjectRosterMember> = {}): GroupProjectRosterMember => ({
  agentId, machine, machineLabel, key: `${agentId}@${machine}`, thisComputer: machine === STUDIO,
  label: 'Builder', kind: 'durable', provenance: 'linked', projectLabel: 'App', inventory: 'verified', lead: 'off', admin: 'off', ...extra,
});

const fullRoster = (extra: Partial<Extract<GroupProjectRosterView, { status: 'available' }>> = {}): GroupProjectRosterView => ({
  groupProjectId: 'gp1', status: 'available', source: 'live', hostName: 'Desk', fetchedAt: new Date().toISOString(),
  members: [
    member('builder_a', DESK, 'Desk', { provenance: 'auto', lead: 'allow', admin: 'ask' }),
    member('builder_b', STUDIO, 'This computer', { lead: 'ask' }),
    member('checker', ATTIC, 'Attic', { label: 'Checker' }),
  ],
  copies: [
    { machine: STUDIO, label: 'App on Studio', state: 'verified', thisComputer: true },
    { machine: ATTIC, label: 'App on Attic', state: 'verified', thisComputer: false },
  ],
  hostInventory: 'complete', truncated: false, copiesCut: false, complete: true, ...extra,
});

const roles = (): GroupProjectRolesView => ({
  groupProjectId: 'gp1', own: { deliver: 'allow', wake: 'off', actions: 'allow' }, holders: [{ agentId: 'builder_b', lead: 'allow', admin: 'off' }],
});

const replica = { id: 'gp1', name: 'Release', description: '', instructions: '', createdAt: '', metadata: {}, hostName: 'Desk',
  host: { machine: DESK }, network: { role: 'replica', state: 'online', waitingWrites: 0, refusals: [] } } as unknown as GroupProject;

afterEach(() => {
  vi.useRealTimers();
  useGroupProjectStore.setState({ projects: [] });
});

beforeEach(() => {
  vi.spyOn(window.clubhouse.groupProject, 'listMembers').mockResolvedValue(localView());
  vi.spyOn(window.clubhouse.groupProject, 'getRoles').mockResolvedValue(roles());
});

describe('Members with the host\'s roster (#3548)', () => {
  it('lists every member on every computer, two Builders apart, with actions only where this computer can act', async () => {
    vi.spyOn(window.clubhouse.groupProject, 'getRoster').mockResolvedValue(fullRoster());
    const exclude = vi.spyOn(window.clubhouse.groupProject, 'excludeMember').mockResolvedValue(localView());
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    const roster = await screen.findByTestId('members-roster');
    expect(roster).toHaveTextContent(/Every member on every computer, from Desk, as of /);
    const items = within(within(roster).getByRole('list', { name: 'Members' })).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Desk, Agent, joined by being in scope, App'),
      expect.stringContaining('This computer, Agent, joined from a linked project, App'),
      expect.stringContaining('Attic, Agent, joined from a linked project, App'),
    ]);
    // Only this computer's own agent can be excluded from here; the others are the host's to change.
    expect(screen.getAllByRole('button', { name: /^Exclude/ })).toHaveLength(1);
    expect(roster).toHaveTextContent('Members on other computers can be changed on Desk.');
    fireEvent.click(screen.getByRole('button', { name: 'Exclude Builder on This computer' }));
    expect(exclude).toHaveBeenCalledWith('gp1', 'builder_b');
    expect(screen.queryByTestId('members-local-only')).toBeNull();
  });

  it('says what it can\'t vouch for: an offline host, an offline or cut-short copy, and a cut list', async () => {
    vi.spyOn(window.clubhouse.groupProject, 'getRoster').mockResolvedValue(fullRoster({
      source: 'cache', stale: 'offline', complete: false, truncated: true, hostInventory: 'partial',
      copies: [
        { machine: STUDIO, label: 'App on Studio', state: 'truncated', thisComputer: true },
        { machine: ATTIC, label: 'App on Attic', state: 'offline', thisComputer: false },
      ],
    }));
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    const status = await screen.findByRole('status', { name: 'Member list may be incomplete' });
    expect(status).toHaveTextContent('This list may be incomplete.');
    expect(status).toHaveTextContent('Desk is offline, so this may be out of date.');
    expect(status).toHaveTextContent('Some projects on Desk couldn\'t be read.');
    expect(status).toHaveTextContent('App on Studio sent a shortened agent list.');
    expect(status).toHaveTextContent('App on Attic was offline when last checked.');
    expect(status).toHaveTextContent('Showing the first 3 members.');
    expect(screen.queryByText(/Every member on every computer/)).toBeNull();
  });

  it('falls back to this computer\'s members, labelled, when the host can\'t send its roster', async () => {
    vi.spyOn(window.clubhouse.groupProject, 'getRoster').mockResolvedValue({ groupProjectId: 'gp1', status: 'unavailable', reason: 'unsupported', hostName: 'Desk' });
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    const label = await screen.findByTestId('members-local-only');
    expect(label).toHaveTextContent('Members on this computer. Desk needs a Clubhouse update to show members on every computer. Members on other computers aren\'t shown.');
    expect(screen.getByRole('list', { name: 'Members' })).toHaveTextContent('Builder');
    expect(screen.queryByTestId('members-roster')).toBeNull();
  });

  it('on a copy, labels its own list while the host hasn\'t answered yet', async () => {
    useGroupProjectStore.setState({ projects: [replica] });
    vi.spyOn(window.clubhouse.groupProject, 'getRoster').mockReturnValue(new Promise(() => {}));
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    expect(await screen.findByTestId('members-local-only')).toHaveTextContent('Members on this computer. Checking Desk for members on other computers.');
    expect(screen.getByRole('list', { name: 'Members' })).toHaveTextContent('Builder');
  });

  it('on a copy, labels its own list after the roster read failed', async () => {
    useGroupProjectStore.setState({ projects: [replica] });
    vi.spyOn(window.clubhouse.groupProject, 'getRoster').mockRejectedValue(new Error('boom'));
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    expect(await screen.findByTestId('members-local-only')).toHaveTextContent('Members on this computer.');
  });

  it('a roster read long ago is no longer called complete, and an open panel asks again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const getRoster = vi.spyOn(window.clubhouse.groupProject, 'getRoster').mockResolvedValue(fullRoster({ fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    const status = await screen.findByRole('status', { name: 'Member list may be incomplete' });
    expect(status).toHaveTextContent('Desk hasn\'t confirmed it since, so this may be out of date.');
    expect(screen.queryByText(/Every member on every computer/)).toBeNull();
    const before = getRoster.mock.calls.length;
    getRoster.mockResolvedValue(fullRoster());
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(getRoster.mock.calls.length).toBeGreaterThan(before);
    expect(await screen.findByText(/Every member on every computer, from Desk/)).toBeInTheDocument();
  });

  it('more linked computers than a roster lists is never complete', async () => {
    vi.spyOn(window.clubhouse.groupProject, 'getRoster').mockResolvedValue(fullRoster({ copiesCut: true, complete: false }));
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    expect(await screen.findByRole('status', { name: 'Member list may be incomplete' })).toHaveTextContent('More linked computers than can be listed.');
  });

  it('with no roster known, shows the list it has and claims nothing more', async () => {
    render(<GroupProjectMembersSection groupProjectId="gp1" />);
    expect(await screen.findByRole('list', { name: 'Members' })).toHaveTextContent('Builder');
    expect(screen.queryByTestId('members-local-only')).toBeNull();
    expect(screen.queryByText(/every computer/)).toBeNull();
  });
});

describe('Permissions with the host\'s roles (#3548)', () => {
  it('shows the host\'s roles read-only, and this computer\'s grants editable, explaining both', async () => {
    vi.spyOn(window.clubhouse.groupProject, 'getRoster').mockResolvedValue(fullRoster());
    render(<GroupProjectRolesSection groupProjectId="gp1" />);
    const host = await screen.findByTestId('roles-host');
    expect(host).toHaveTextContent(/Lead and admin on Desk, as of /);
    expect(host).toHaveTextContent('can\'t be changed from here');
    expect(within(host).getByLabelText('Lead for Builder on Desk on Desk')).toHaveTextContent('Lead allow');
    expect(within(host).getByLabelText('Admin for Builder on Desk on Desk')).toHaveTextContent('Admin ask first');
    expect(within(host).getByLabelText('Lead for Builder on Desk')).toHaveTextContent('Lead ask first');
    expect(within(host).getByLabelText('Lead for Checker on Attic on Desk')).toHaveTextContent('Lead off');
    expect(within(host).queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.getByTestId('roles-this-computer')).toHaveTextContent('Desk doesn\'t use them when it applies a change, so the two lists can differ.');
    // This computer's own grant stays editable, as before.
    expect(screen.getByRole('combobox', { name: 'Lead for Builder' })).toHaveValue('allow');
  });

  it('with no roster from the host, says its roles can\'t be shown', async () => {
    vi.spyOn(window.clubhouse.groupProject, 'getRoster').mockResolvedValue({ groupProjectId: 'gp1', status: 'unavailable', reason: 'offline', hostName: 'Desk' });
    render(<GroupProjectRolesSection groupProjectId="gp1" />);
    expect(await screen.findByTestId('roles-host-unavailable')).toHaveTextContent('Lead and admin on Desk can\'t be shown. Desk is offline');
    expect(screen.getByRole('combobox', { name: 'Lead for Builder' })).toBeInTheDocument();
  });

  it('on a copy, says the host\'s roles are being checked before any roster arrives', async () => {
    useGroupProjectStore.setState({ projects: [replica] });
    vi.spyOn(window.clubhouse.groupProject, 'getRoster').mockReturnValue(new Promise(() => {}));
    render(<GroupProjectRolesSection groupProjectId="gp1" />);
    expect(await screen.findByTestId('roles-host-checking')).toHaveTextContent('Checking Desk for its lead and admin grants.');
    expect(screen.getByTestId('roles-this-computer')).toHaveTextContent('Desk doesn\'t use them');
  });

  it('on the host, names other computers\' members and keeps every role editable', async () => {
    vi.spyOn(window.clubhouse.groupProject, 'listMembers').mockResolvedValue({
      groupProjectId: 'gp1', managed: true, autoJoin: true, excluded: [],
      members: [
        { agentId: 'builder_a', name: 'Builder', kind: 'durable', via: 'auto' },
        { agentId: `builder_b@${STUDIO}`, name: 'Builder', kind: 'durable', via: 'auto' },
      ],
    });
    vi.spyOn(window.clubhouse.groupProject, 'getRoster').mockResolvedValue(fullRoster({
      source: 'host', hostName: 'This computer',
      members: [member('builder_a', DESK, 'This computer', { thisComputer: true }), member('builder_b', STUDIO, 'Studio', { thisComputer: false })],
    }));
    const setRole = vi.spyOn(window.clubhouse.groupProject, 'setRole').mockResolvedValue(roles());
    render(<GroupProjectRolesSection groupProjectId="gp1" />);
    const remote = await screen.findByRole('combobox', { name: 'Lead for Builder on Studio' });
    expect(screen.getByRole('combobox', { name: 'Lead for Builder' })).toBeInTheDocument();
    expect(screen.queryByTestId('roles-host')).toBeNull();
    fireEvent.change(remote, { target: { value: 'allow' } });
    expect(setRole).toHaveBeenCalledWith('gp1', `builder_b@${STUDIO}`, 'lead', 'allow');
  });
});
