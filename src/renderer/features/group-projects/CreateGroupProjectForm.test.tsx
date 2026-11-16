import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../stores/projectStore';
import { CreateGroupProjectForm as CreateGroupProject } from './CreateGroupProjectForm';

const scope = { level: 'project' as const, projectId: 'atlas', reach: 'network' as const };
const preview = { wouldJoin: [
  { agentId: 'ada', name: 'Ada', kind: 'durable' as const, via: 'auto' as const, projectName: 'Atlas' },
  { agentId: 'bea@computer', name: 'Bea', kind: 'durable' as const, via: 'auto' as const, projectName: 'Atlas on Laptop' },
], unreadableProjects: [] };

beforeEach(() => {
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

  it('shows unavailable linked inventory as unknown and refreshes when membership changes', async () => {
    let changed!: (id: string) => void;
    vi.spyOn(window.clubhouse.groupProject, 'onMembershipChanged').mockImplementation((fn) => { changed = fn; return () => {}; });
    render(<CreateGroupProject />);
    await chooseProject();
    vi.mocked(window.clubhouse.groupProject.previewAutoJoin).mockResolvedValue({ wouldJoin: [], unreadableProjects: [{ projectId: 'remote', name: 'Atlas on Laptop' }] });
    await act(async () => changed('gp'));
    expect(screen.getByText(/Could not check agents in: Atlas on Laptop/)).toBeInTheDocument();
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
