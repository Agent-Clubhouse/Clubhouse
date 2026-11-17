import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as annexClientStore from '../../stores/annexClientStore';
import { useNetworkSidebarStore } from '../../chrome/sidebar/networkSidebarStore';
import { useRemoteProjectStore } from '../../stores/remoteProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { CreateGroupProjectForm as CreateGroupProject } from './CreateGroupProjectForm';

const scope = { level: 'project' as const, projectId: 'atlas', reach: 'network' as const };
const preview = { wouldJoin: [
  { agentId: 'ada', name: 'Ada', kind: 'durable' as const, via: 'auto' as const, projectName: 'Atlas' },
  { agentId: 'bea@computer', name: 'Bea', kind: 'durable' as const, via: 'auto' as const, projectName: 'Atlas on Laptop' },
], unreadableProjects: [] };

beforeEach(() => {
  useRemoteProjectStore.setState({ satelliteProjects: {}, remoteAgents: {} });
  useProjectStore.setState({ projects: [{ id: 'atlas', name: 'Atlas', path: '/atlas' }] });
  vi.spyOn(window.clubhouse.groupProject, 'scopeOptions').mockResolvedValue({ network: { available: true } });
  vi.spyOn(window.clubhouse.groupProject, 'previewAutoJoin').mockImplementation(async (s, options) => ({
    ...preview, wouldJoin: s.level === 'project' && options?.autoJoin !== false
      ? preview.wouldJoin.filter((a) => !a.agentId.includes('@') || options?.includeLinkedComputers) : [],
  }));
});

async function chooseProject() {
  fireEvent.change(screen.getByLabelText('Covers'), { target: { value: 'project:atlas' } });
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Network' })).toBeEnabled());
  fireEvent.click(screen.getByRole('radio', { name: 'Network' }));
  await screen.findByText('2 agents will join now.');
}

describe('starting membership controls', () => {
  it('starts app groups empty without toggles', async () => {
    const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockResolvedValue({ id: 'gp-new', name: 'Group' });
    render(<CreateGroupProject />);
    await screen.findByText('0 agents will join now.');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New group project name'), { target: { value: 'Group' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group project' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Group', { scope: { level: 'app', reach: 'local' }, membership: { autoJoin: false, includeLinkedComputers: false, excluded: [] } }));
  });

  it('keeps project defaults and creation and close callbacks from the navigation form', async () => {
    const project = { id: 'gp-new', name: 'Group' };
    const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockResolvedValue(project);
    const onCreated = vi.fn();
    const onCancel = vi.fn();
    render(<CreateGroupProject defaultScope={scope} onCreated={onCreated} onCancel={onCancel} />);
    await screen.findByText('2 agents will join now.');
    expect(screen.getByLabelText('Start with every agent in Atlas')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('New group project name'), { target: { value: 'Group' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group project' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(project));
    expect(create).toHaveBeenCalledExactlyOnceWith('Group', { scope, membership: { autoJoin: true, includeLinkedComputers: true, excluded: [] } });
  });

  it('defaults project membership on, previews linked agents and sends exclusions with the one create request', async () => {
    const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockResolvedValue({ id: 'gp-new', name: 'Group' });
    render(<CreateGroupProject />);
    await chooseProject();
    expect(screen.getByLabelText('Start with every agent in Atlas')).toBeChecked();
    expect(screen.getByLabelText('Include linked computers')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Bea (Atlas on Laptop)'));
    expect(screen.getByText('1 agent will join now.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New group project name'), { target: { value: 'Group' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group project' }));
    await waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith('Group', { scope, membership: { autoJoin: true, includeLinkedComputers: true, excluded: ['bea@computer'] } }));
  });

  it('refreshes preview for both toggles and keeps unchecked agents excluded across toggling', async () => {
    render(<CreateGroupProject />);
    await chooseProject();
    fireEvent.click(screen.getByLabelText('Ada (Atlas)'));
    fireEvent.click(screen.getByLabelText('Include linked computers'));
    await screen.findByText('0 agents will join now.');
    fireEvent.click(screen.getByLabelText('Include linked computers'));
    await screen.findByText('1 agent will join now.');
    expect(screen.getByLabelText('Ada (Atlas)')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('Start with every agent in Atlas'));
    await screen.findByText('0 agents will join now.');
    expect(screen.getByLabelText('Include linked computers')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Start with every agent in Atlas'));
    await screen.findByText('1 agent will join now.');
    expect(screen.getByLabelText('Ada (Atlas)')).not.toBeChecked();
  });

  it('includes and excludes the whole set while retaining individual overrides in the create request (#3661)', async () => {
    const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockResolvedValue({ id: 'gp-new', name: 'Group' });
    render(<CreateGroupProject />);
    await chooseProject();
    fireEvent.click(screen.getByRole('button', { name: 'Exclude all' }));
    expect(screen.getByLabelText('Ada (Atlas)')).not.toBeChecked();
    expect(screen.getByLabelText('Bea (Atlas on Laptop)')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('Ada (Atlas)'));
    expect(screen.getByText('1 agent will join now.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Include all' }));
    expect(screen.getByLabelText('Bea (Atlas on Laptop)')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Ada (Atlas)'));
    fireEvent.change(screen.getByLabelText('New group project name'), { target: { value: 'Group' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group project' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Group', expect.objectContaining({ membership: expect.objectContaining({ excluded: ['ada'] }) })));
  });

  it('shows unavailable linked inventory as unknown and refreshes when membership changes', async () => {
    let changed!: (id: string) => void;
    vi.spyOn(window.clubhouse.groupProject, 'onMembershipChanged').mockImplementation((fn) => { changed = fn; return () => {}; });
    render(<CreateGroupProject />);
    await chooseProject();
    vi.mocked(window.clubhouse.groupProject.previewAutoJoin).mockResolvedValue({ wouldJoin: [], unreadableProjects: [{ projectId: 'remote', name: 'Atlas on Laptop' }] });
    await act(async () => changed('gp'));
    expect(screen.getByRole('list', { name: 'Projects with unconfirmed agents' })).toHaveTextContent('Atlas on Laptop: The agent list has not synced yet.');
  });

  it('refreshes remote inventory on snapshots, connection changes and links before a group exists (#3661)', async () => {
    let snapshot!: (machine: string) => void;
    let computers!: (satellites: unknown[]) => void;
    vi.spyOn(annexClientStore, 'onSatelliteSnapshot').mockImplementation((fn) => { snapshot = fn; return () => {}; });
    vi.spyOn(window.clubhouse.annexClient, 'onSatellitesChanged').mockImplementation((fn) => { computers = fn; return () => {}; });
    render(<CreateGroupProject defaultScope={scope} />);
    await screen.findByText('2 agents will join now.');
    vi.mocked(window.clubhouse.groupProject.previewAutoJoin).mockResolvedValue({ wouldJoin: [], unreadableProjects: [] });
    await act(async () => computers([]));
    expect(screen.getByText('0 agents will join now.')).toBeInTheDocument();
    vi.mocked(window.clubhouse.groupProject.previewAutoJoin).mockResolvedValue(preview);
    await act(async () => snapshot('computer'));
    expect(screen.getByLabelText('Bea (Atlas on Laptop)')).toBeChecked();
    vi.mocked(window.clubhouse.groupProject.previewAutoJoin).mockResolvedValue({ wouldJoin: [preview.wouldJoin[0]], unreadableProjects: [] });
    await act(async () => useNetworkSidebarStore.setState({ links: [] }));
    expect(screen.getByText('1 agent will join now.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Bea (Atlas on Laptop)')).not.toBeInTheDocument();
  });

  it('previews coverage from the same read: a linked copy covered, an unchecked one not verified, a repository match offered', async () => {
    let changed!: (id: string) => void;
    vi.spyOn(window.clubhouse.groupProject, 'onMembershipChanged').mockImplementation((fn) => { changed = fn; return () => {}; });
    render(<CreateGroupProject />);
    await chooseProject();
    vi.mocked(window.clubhouse.groupProject.previewAutoJoin).mockResolvedValue({
      coverage: {
        groupProjectId: 'preview', scoped: true, complete: false, localUnknown: false,
        copies: [
          { machine: 'a', projectId: 'p', name: 'Atlas', thisComputer: true, state: 'verified' },
          { machine: 'b', projectId: 'r', name: 'Atlas on Laptop', thisComputer: false, state: 'unknown' },
        ],
        repositoryMatches: [{ projectId: 'p-clone', name: 'Atlas clone' }],
      },
      wouldJoin: [], unreadableProjects: [],
    });
    await act(async () => changed('gp'));
    const summary = await screen.findByTestId('coverage-summary');
    expect(summary).toHaveTextContent('Covers Atlas.');
    expect(summary).toHaveTextContent('Coverage not verified on this computer: Atlas on Laptop.');
    expect(screen.getByRole('button', { name: 'Offer to link Atlas clone' })).toBeInTheDocument();
  });
});

describe('choosing the host (#3547)', () => {
  const studio = 'bb:bb';
  const hosts = [
    { machine: null, name: 'This computer', state: 'online' as const },
    { machine: studio, name: 'Studio', state: 'online' as const },
    { machine: 'cc:cc', name: 'Harbor', state: 'offline' as const, reason: 'Harbor is offline.' },
    { machine: 'dd:dd', name: 'Attic', state: 'needs_update' as const, reason: 'Attic needs a Clubhouse update to host group projects created here.' },
  ];
  const base = { requestId: 'rc_1', host: studio, hostName: 'Studio' };
  const options = { scope: { level: 'app', reach: 'network' }, membership: { autoJoin: false, includeLinkedComputers: false, excluded: [] } };

  beforeEach(() => {
    vi.spyOn(window.clubhouse.groupProject, 'createHosts').mockResolvedValue(hosts);
  });
  const hostRadio = (name: string | RegExp) => within(screen.getByRole('group', { name: 'Host' })).getByRole('radio', { name });

  async function onStudio(name = 'Launch') {
    render(<CreateGroupProject defaultScope={{ level: 'app', reach: 'network' }} onCreated={created} />);
    await screen.findByText('0 agents will join now.');
    await waitFor(() => expect(hostRadio('Studio')).toBeEnabled());
    fireEvent.click(hostRadio('Studio'));
    fireEvent.change(screen.getByLabelText('New group project name'), { target: { value: name } });
  }
  const created = vi.fn();
  beforeEach(() => created.mockReset());

  it('offers only with network reach, defaults to this computer, and explains computers that can\'t be chosen', async () => {
    render(<CreateGroupProject />);
    await screen.findByText('0 agents will join now.');
    expect(screen.queryByRole('group', { name: 'Host' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Network' }));
    await waitFor(() => expect(hostRadio('This computer')).toBeChecked());
    expect(hostRadio(/Harbor/)).toBeDisabled();
    expect(screen.getByText('Harbor is offline.')).toBeInTheDocument();
    expect(hostRadio(/Attic/)).toBeDisabled();
    expect(screen.getByText(/Attic needs a Clubhouse update/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create group project' })).toBeInTheDocument();
  });

  it('waits for approval on the host, asks again with the same id, and opens the copy once created', async () => {
    const createOnHost = vi.spyOn(window.clubhouse.groupProject, 'createOnHost')
      .mockResolvedValueOnce({ ...base, status: 'waiting', expiresAt: '2026-11-16T12:00:00.000Z' })
      .mockResolvedValueOnce({ ...base, status: 'created', groupProjectId: 'gp_1', project: { id: 'gp_1', name: 'Launch' } as never });
    const local = vi.spyOn(window.clubhouse.groupProject, 'create');
    await onStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Create on Studio' }));
    expect(await screen.findByText(/Waiting for approval on Studio\. A person there approves it in Needs you\. Nothing has been created yet\./)).toBeInTheDocument();
    expect(createOnHost).toHaveBeenCalledWith(studio, 'Launch', options, undefined);
    expect(screen.getByLabelText('New group project name')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(created).toHaveBeenCalledWith({ id: 'gp_1', name: 'Launch' }));
    expect(createOnHost).toHaveBeenLastCalledWith(studio, 'Launch', options, 'rc_1');
    expect(screen.getByText('Created on Studio. Open it from the list.')).toBeInTheDocument();
    expect(local).not.toHaveBeenCalled();
  });

  it('asks the host again on its own while approval waits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const createOnHost = vi.spyOn(window.clubhouse.groupProject, 'createOnHost').mockResolvedValue({ ...base, status: 'waiting', expiresAt: '2026-11-16T12:00:00.000Z' });
      await onStudio();
      fireEvent.click(screen.getByRole('button', { name: 'Create on Studio' }));
      await screen.findByText(/Waiting for approval on Studio/);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(createOnHost).toHaveBeenLastCalledWith(studio, 'Launch', options, 'rc_1');
      expect(createOnHost).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('a check that fails while approval waits keeps the request and the lock, and says it may still be approved', async () => {
    const createOnHost = vi.spyOn(window.clubhouse.groupProject, 'createOnHost')
      .mockResolvedValueOnce({ ...base, status: 'waiting', expiresAt: '2026-11-16T12:00:00.000Z' })
      .mockResolvedValueOnce({ ...base, status: 'unreachable', reason: 'Studio didn\'t answer.' })
      .mockResolvedValueOnce({ ...base, status: 'declined', reason: 'A person there declined it. Nothing was created.' });
    await onStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Create on Studio' }));
    await screen.findByText(/Waiting for approval on Studio/);
    expect(screen.getByText(/Closing this form stops checking/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText(/Couldn't check just now\. Studio didn't answer\. The request still stands and may be approved/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for approval on Studio/)).toBeInTheDocument();
    expect(screen.getByLabelText('New group project name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Declined. A person there declined it. Nothing was created.')).toBeInTheDocument();
    expect(createOnHost).toHaveBeenLastCalledWith(studio, 'Launch', options, 'rc_1');
    expect(screen.getByLabelText('New group project name')).toBeEnabled();
  });

  it('an unreachable host offers Retry with the same id, or this computer instead', async () => {
    const createOnHost = vi.spyOn(window.clubhouse.groupProject, 'createOnHost')
      .mockResolvedValue({ ...base, status: 'unreachable', reason: 'Studio is offline. Nothing was created and nothing is queued.' });
    await onStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Create on Studio' }));
    expect(await screen.findByText('Not created. Studio is offline. Nothing was created and nothing is queued.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(createOnHost).toHaveBeenLastCalledWith(studio, 'Launch', options, 'rc_1'));
    fireEvent.click(screen.getByRole('button', { name: 'Create on this computer instead' }));
    expect(hostRadio('This computer')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Create group project' })).toBeInTheDocument();
  });

  it('a changed draft is a new request, not a retry of the old id', async () => {
    const createOnHost = vi.spyOn(window.clubhouse.groupProject, 'createOnHost')
      .mockResolvedValue({ ...base, status: 'unreachable', reason: 'Studio didn\'t answer.' });
    await onStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Create on Studio' }));
    await screen.findByText(/Studio didn't answer/);
    fireEvent.change(screen.getByLabelText('New group project name'), { target: { value: 'Renamed' } });
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create on Studio' }));
    await waitFor(() => expect(createOnHost).toHaveBeenLastCalledWith(studio, 'Renamed', options, undefined));
  });

  it.each([
    ['declined', 'Declined.', 'A person there declined it. Nothing was created.'],
    ['expired', 'Expired.', 'Nobody answered the approval in time. Nothing was created. Ask again.'],
    ['refused', 'Refused.', 'That project isn\'t linked to a project on this computer. Link them first. Nothing was created.'],
    ['unsupported', 'Not available.', 'Studio needs a Clubhouse update to host group projects created here. Nothing was created.'],
  ] as const)('shows %s plainly, with a new request or this computer next', async (status, label, reason) => {
    vi.spyOn(window.clubhouse.groupProject, 'createOnHost').mockResolvedValue({ ...base, status, reason });
    await onStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Create on Studio' }));
    expect(await screen.findByText(`${label} ${reason}`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start a new request' }));
    expect(screen.queryByText(`${label} ${reason}`)).not.toBeInTheDocument();
    expect(hostRadio('Studio')).toBeChecked();
    expect(created).not.toHaveBeenCalled();
  });

  it('busy keeps the request id for Retry', async () => {
    const createOnHost = vi.spyOn(window.clubhouse.groupProject, 'createOnHost')
      .mockResolvedValue({ ...base, status: 'busy', reason: 'Too many approvals are waiting on this computer.' });
    await onStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Create on Studio' }));
    await screen.findByText(/Too many approvals/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(createOnHost).toHaveBeenLastCalledWith(studio, 'Launch', options, 'rc_1'));
  });

  it('shows when the computers can\'t be listed, with Check again', async () => {
    vi.mocked(window.clubhouse.groupProject.createHosts).mockRejectedValueOnce(new Error('Annex is restarting'));
    render(<CreateGroupProject defaultScope={{ level: 'app', reach: 'network' }} />);
    expect(await screen.findByText(/Could not list your computers: Annex is restarting/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(hostRadio('Studio')).toBeEnabled());
  });
});

describe('coverage preview for another host (#3547, #3568)', () => {
  it('says what this computer sees, and that the host verifies, only when another computer is chosen', async () => {
    vi.spyOn(window.clubhouse.groupProject, 'createHosts').mockResolvedValue([
      { machine: null, name: 'This computer', state: 'online' }, { machine: 'bb:bb', name: 'Studio', state: 'online' },
    ]);
    vi.mocked(window.clubhouse.groupProject.previewAutoJoin).mockResolvedValue({
      wouldJoin: [], unreadableProjects: [],
      coverage: { groupProjectId: 'preview', scoped: true, complete: true, localUnknown: false, repositoryMatches: [],
        copies: [{ machine: 'a', projectId: 'atlas', name: 'Atlas', thisComputer: true, state: 'verified' }] },
    } as never);
    render(<CreateGroupProject defaultScope={scope} />);
    expect(await screen.findByText('Covers Atlas.')).toBeInTheDocument();
    const host = within(await screen.findByRole('group', { name: 'Host' }));
    await waitFor(() => expect(host.getByRole('radio', { name: 'Studio' })).toBeEnabled());
    fireEvent.click(host.getByRole('radio', { name: 'Studio' }));
    expect(screen.getByText('As seen from this computer, it covers Atlas.')).toBeInTheDocument();
    expect(screen.getByText('Coverage is verified on the host when the group is created.')).toBeInTheDocument();
    fireEvent.click(host.getByRole('radio', { name: 'This computer' }));
    expect(screen.getByText('Covers Atlas.')).toBeInTheDocument();
  });
});

describe('synced sidebar inventory in the create preview (#3661)', () => {
  const remoteId = 'remote||laptop||proj_hidden';
  const coverage = { groupProjectId: 'preview', scoped: true, complete: false, localUnknown: false, repositoryMatches: [], copies: [
    { machine: 'self', projectId: 'atlas', name: 'Atlas', thisComputer: true, state: 'verified' as const },
    { machine: 'laptop', projectId: 'proj_hidden', name: 'proj_hidden on a linked computer', thisComputer: false, state: 'unknown' as const },
  ] };

  it('resolves project names, labels both computers, and shows cached agents separately without counting or selecting them', async () => {
    useRemoteProjectStore.setState({
      satelliteProjects: { laptop: [{ id: remoteId, name: 'Atlas copy', displayName: 'Remote Atlas', path: '__remote__', remote: true, satelliteId: 'laptop', satelliteName: 'Laptop' }] },
      remoteAgents: {
        cached: { id: 'remote||laptop||cached', name: 'Cached Bea', kind: 'durable', projectId: remoteId } as never,
        helper: { id: 'remote||laptop||helper', name: 'Helper', kind: 'durable', parentAgentId: 'cached', projectId: remoteId } as never,
        quick: { id: 'remote||laptop||quick', name: 'Quick', kind: 'quick', projectId: remoteId } as never,
        disposed: { id: 'remote||laptop||disposed', name: 'Disposed', kind: 'durable', disposedAt: '2026-01-01', projectId: remoteId } as never,
      },
    });
    vi.mocked(window.clubhouse.groupProject.previewAutoJoin).mockResolvedValue({
      coverage, wouldJoin: [{ ...preview.wouldJoin[0], projectId: 'atlas' }],
      unreadableProjects: [{ projectId: 'laptop/proj_hidden', name: 'proj_hidden on a linked computer', reason: 'Laptop is offline.' }],
    });
    const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockResolvedValue({ id: 'gp-new', name: 'Group' });
    render(<CreateGroupProject defaultScope={scope} />);
    const ada = await screen.findByRole('checkbox', { name: 'Ada (Atlas on this computer)' });
    expect(ada).toBeChecked();
    expect(screen.getByRole('option', { name: 'Atlas on this computer' })).toHaveProperty('selected', true);
    expect(screen.getByLabelText('Start with every agent in Atlas on this computer')).toBeChecked();
    const saved = screen.getByRole('list', { name: 'Last seen agents' });
    expect(within(saved).getAllByRole('listitem')).toHaveLength(1);
    expect(saved).toHaveTextContent("Cached Bea (Remote Atlas on Laptop). Last seen on Laptop; can't confirm right now.");
    expect(within(saved).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Projects with unconfirmed agents' })).toHaveTextContent('Remote Atlas on Laptop: Laptop is offline.');
    expect(screen.getByText('1 agent will join now.')).toBeInTheDocument();
    expect(screen.queryByText(/proj_hidden/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Exclude all' }));
    expect(ada).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('New group project name'), { target: { value: 'Group' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group project' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Group', expect.objectContaining({ membership: expect.objectContaining({ excluded: ['ada'] }) })));
  });

  it('keeps a single computer unqualified', async () => {
    vi.mocked(window.clubhouse.groupProject.previewAutoJoin).mockResolvedValue({
      wouldJoin: [{ ...preview.wouldJoin[0], projectId: 'atlas' }], unreadableProjects: [],
    });
    render(<CreateGroupProject defaultScope={scope} />);
    expect(await screen.findByRole('checkbox', { name: 'Ada (Atlas)' })).toBeChecked();
    expect(screen.getByRole('option', { name: 'Atlas' })).toHaveProperty('selected', true);
  });

  it('never exposes internal ids even when neither inventory has a name', async () => {
    vi.mocked(window.clubhouse.groupProject.previewAutoJoin).mockResolvedValue({ coverage,
      wouldJoin: [], unreadableProjects: [{ projectId: 'laptop/proj_hidden', name: 'proj_hidden on a linked computer' }],
    });
    render(<CreateGroupProject defaultScope={scope} />);
    const unknown = await screen.findByRole('list', { name: 'Projects with unconfirmed agents' });
    expect(unknown).toHaveTextContent('Linked project: The agent list has not synced yet.');
    expect(screen.queryByText(/proj_hidden/)).not.toBeInTheDocument();
  });
});

it('uses a plain project label throughout the form when a local project name is an internal id (#3661)', async () => {
  useProjectStore.setState({ projects: [{ id: 'atlas', name: 'proj_hidden', path: '/atlas' }] });
  vi.mocked(window.clubhouse.groupProject.previewAutoJoin).mockResolvedValue({
    wouldJoin: [{ ...preview.wouldJoin[0], projectId: 'atlas', projectName: 'proj_hidden' }], unreadableProjects: [],
  });
  render(<CreateGroupProject defaultScope={scope} />);
  expect(await screen.findByRole('checkbox', { name: 'Ada (This project)' })).toBeChecked();
  expect(screen.getByRole('option', { name: 'This project' })).toHaveProperty('selected', true);
  expect(screen.getByLabelText('Start with every agent in This project')).toBeChecked();
  expect(screen.queryByText(/proj_hidden/)).not.toBeInTheDocument();
});
