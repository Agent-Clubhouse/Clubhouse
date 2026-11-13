import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProject } from '../../../shared/group-project-types';
import { createMockAPI } from '../../plugins/testing';
import { useGroupProjectContext } from '../../plugins/builtin/group-project/useGroupProjectContext';
import { initGroupProjectListener, useGroupProjectStore } from '../../stores/groupProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { GroupProjectsSettingsView } from './GroupProjectsSettingsView';

const alpha: GroupProject = {
  id: 'gp-alpha', name: 'Alpha', description: 'First group', instructions: '  original\n',
  scope: { level: 'app', reach: 'local' }, createdAt: '2026-11-12T00:00:00Z',
  metadata: { pollingEnabled: true, source: { preserved: true } },
};
const beta: GroupProject = { ...alpha, id: 'gp-beta', name: 'Beta', scope: undefined };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function select(name = 'Alpha') {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('GroupProjectsSettingsView', () => {
  beforeEach(() => {
    useGroupProjectStore.setState({ projects: [], loaded: false, loadError: null, directorySelection: null });
    useProjectStore.setState({ activeProjectId: 'selected-project' });
    vi.spyOn(window.clubhouse.groupProject, 'list').mockResolvedValue([alpha, beta]);
  });

  it('opens a group project selected by a directory navigation request', async () => {
    useGroupProjectStore.getState().selectDirectoryProject('gp-beta');
    render(<GroupProjectsSettingsView />);
    expect(await screen.findByLabelText('Name')).toHaveValue('Beta');
  });

  it('offers the selected polling project a switch to notices', async () => {
    const setPolling = vi.spyOn(window.clubhouse.groupProject, 'setPolling').mockResolvedValue(undefined);
    render(<GroupProjectsSettingsView />);
    await screen.findByRole('list');
    select('Beta');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to notices' }));
    await waitFor(() => expect(setPolling).toHaveBeenCalledWith('gp-beta', false));
  });

  it('edits permissions for the selected group project', async () => {
    const setOwnGrant = vi.spyOn(window.clubhouse.groupProject, 'setOwnGrant');
    render(<GroupProjectsSettingsView />);
    await screen.findByRole('list');
    select('Beta');
    const wake = await screen.findByLabelText('Wake a sleeping member when a lead taps it');
    fireEvent.change(wake, { target: { value: 'allow' } });
    await waitFor(() => expect(setOwnGrant).toHaveBeenCalledWith('gp-beta', 'wake', 'allow'));
  });

  it('previews the agents who will join and warns about unreadable projects', async () => {
    vi.spyOn(window.clubhouse.groupProject, 'previewAutoJoin').mockResolvedValue({
      wouldJoin: [{ agentId: 'ada', name: 'Ada', kind: 'durable', via: 'auto', projectName: 'Work' }],
      unreadableProjects: [{ projectId: 'unreadable', name: 'Offline' }],
    });
    render(<GroupProjectsSettingsView />);
    expect(await screen.findByText('1 agent will join now.')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Agents who will join' })).toHaveTextContent('Ada (Work)');
    expect(screen.getByText(/Could not check agents in: Offline/)).toBeInTheDocument();
  });

  it('refreshes the creation preview when projects or membership change', async () => {
    let projectsChanged!: () => void;
    const membershipListeners: Array<(id: string) => void> = [];
    vi.spyOn(window.clubhouse.project, 'onChanged').mockImplementation((cb) => { projectsChanged = cb; return () => {}; });
    vi.spyOn(window.clubhouse.groupProject, 'onMembershipChanged').mockImplementation((cb) => { membershipListeners.push(cb); return () => {}; });
    const preview = vi.spyOn(window.clubhouse.groupProject, 'previewAutoJoin').mockResolvedValue({ wouldJoin: [], unreadableProjects: [] });
    render(<GroupProjectsSettingsView />);
    await screen.findByText('0 agents will join now.');
    const initial = preview.mock.calls.length;
    await act(async () => { projectsChanged(); });
    expect(preview.mock.calls.length).toBeGreaterThan(initial);
    const afterProject = preview.mock.calls.length;
    await act(async () => { membershipListeners.forEach((listener) => listener('gp-alpha')); });
    expect(preview.mock.calls.length).toBeGreaterThan(afterProject);
  });

  it('lists every local registry record without a Canvas, and leaves legacy scope unresolved', async () => {
    render(<GroupProjectsSettingsView />);
    expect(await screen.findByRole('list', { name: 'Local group projects' })).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(await screen.findAllByText('0 members')).toHaveLength(2);
    expect(screen.getAllByText('Host: This computer')).toHaveLength(2);
    expect(screen.getAllByText('Polling on')).toHaveLength(2);
    select('Beta');
    expect(screen.getByLabelText('Name')).toHaveValue('Beta');
    expect(screen.getAllByText(/Scope unresolved: legacy or missing scope/)).toHaveLength(2);
    expect(screen.getByText(/including network copies/)).toBeInTheDocument();
    // Network reach is disabled, with its reason, in both creation and the scope editor (#3355).
    await waitFor(() => expect(screen.getAllByText(/Network reach needs Annex Network/)).toHaveLength(2));
  });

  it('shows loading and empty states, refuses blank creation, and preserves a failed create draft', async () => {
    const list = deferred<GroupProject[]>();
    vi.mocked(window.clubhouse.groupProject.list).mockReturnValue(list.promise);
    const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockRejectedValue(new Error('Disk unavailable'));
    render(<GroupProjectsSettingsView />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading group projects');
    await act(async () => { list.resolve([]); });
    expect(screen.getByText('No group projects stored on this machine.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create group project' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a group project name');
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('New group project name'), { target: { value: 'Keep my draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not created. Disk unavailable');
    expect(screen.getByLabelText('New group project name')).toHaveValue('Keep my draft');
  });

  it('creates app/local with a project selected and publishes through the real store and onChanged path used by Canvas', async () => {
    const created: GroupProject = { ...alpha, id: 'gp-created', name: 'Directory group' };
    const pending = deferred<GroupProject>();
    const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockReturnValue(pending.promise);
    let publish!: (projects: unknown[]) => void;
    vi.spyOn(window.clubhouse.groupProject, 'onChanged').mockImplementation((callback) => {
      publish = callback;
      return () => {};
    });
    const cleanup = initGroupProjectListener();
    const { result } = renderHook(() => useGroupProjectContext(created.id, false, null, createMockAPI().annex));
    render(<GroupProjectsSettingsView />);
    await screen.findByRole('list');
    fireEvent.change(screen.getByLabelText('New group project name'), { target: { value: '  Directory group  ' } });
    const button = screen.getByRole('button', { name: 'Create group project' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(create).toHaveBeenCalledExactlyOnceWith('Directory group', { scope: { level: 'app', reach: 'local' } });
    expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled();
    await act(async () => {
      // The registry can publish CHANGED before the CREATE response arrives.
      publish([alpha, beta, created]);
      pending.resolve(created);
    });
    expect(useProjectStore.getState().activeProjectId).toBe('selected-project');
    expect(screen.getAllByText('Directory group')).toHaveLength(1);
    expect(result.current.project).toEqual(created);
    expect(result.current.loaded).toBe(true);
    act(() => { publish([alpha, beta, { ...created, description: 'Changed on Canvas' }]); });
    expect(result.current.project?.description).toBe('Changed on Canvas');
    select('Directory group');
    expect(screen.getByLabelText('Description')).toHaveValue('Changed on Canvas');
    cleanup();
  });

  it('saves only requested fields, preserves instructions whitespace and source metadata, and shows persisted values on reselection', async () => {
    const next = { ...alpha, name: 'Renamed', description: ' New purpose ', instructions: '  exact\n\ninstructions  \n' };
    const update = vi.spyOn(window.clubhouse.groupProject, 'update').mockResolvedValue(next);
    const { result } = renderHook(() => useGroupProjectContext(alpha.id, false, null, createMockAPI().annex));
    render(<GroupProjectsSettingsView />);
    await screen.findByRole('list');
    select();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Renamed ' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: next.description } });
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: next.instructions } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved to the local registry.')).toBeInTheDocument();
    expect(update).toHaveBeenCalledExactlyOnceWith(alpha.id, {
      name: next.name, description: next.description, instructions: next.instructions,
    });
    expect(result.current.project).toEqual(next);
    expect(useGroupProjectStore.getState().projects[0].metadata).toEqual(alpha.metadata);
    select('Beta');
    select('Renamed');
    expect(screen.getByLabelText('Instructions')).toHaveValue(next.instructions);
  });

  it.each(['refused', 'rejected', 'partial', 'malformed'] as const)('refuses blank names and keeps unsaved edits when the write is %s', async (outcome) => {
    const update = vi.spyOn(window.clubhouse.groupProject, 'update');
    if (outcome === 'refused') update.mockResolvedValue(null);
    else if (outcome === 'rejected') update.mockRejectedValue(new Error('Write failed'));
    else if (outcome === 'partial') update.mockResolvedValue({ id: alpha.id, name: 'Partial response' });
    else update.mockResolvedValue({ ...alpha, instructions: 7 });
    render(<GroupProjectsSettingsView />);
    await screen.findByRole('list');
    select();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Not saved. Enter a group project name');
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved name' } });
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: '  keep this draft\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        outcome === 'rejected' ? 'Not saved. Write failed' : 'Not saved. Group project update was not confirmed',
      );
    });
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved name');
    expect(screen.getByLabelText('Instructions')).toHaveValue('  keep this draft\n');
    expect(useGroupProjectStore.getState().projects[0]).toEqual(alpha);
    expect(screen.queryByText('Changes saved to the local registry.')).not.toBeInTheDocument();
  });

  it('surfaces load errors, hides stale inventory, and retries the actual list request', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    useGroupProjectStore.setState({ projects: [alpha] });
    vi.mocked(window.clubhouse.groupProject.list).mockRejectedValueOnce(new Error('Registry unreadable'));
    render(<GroupProjectsSettingsView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The inventory is unavailable. Registry unreadable');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create group project' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(await screen.findByRole('list')).toBeInTheDocument();
    expect(window.clubhouse.groupProject.list).toHaveBeenCalledTimes(2);
    expect(useGroupProjectStore.getState().loadError).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('does not cross selection or overwrite another draft when a pending save finishes: %s', async (outcome) => {
    const pending = deferred<GroupProject | null>();
    const update = vi.spyOn(window.clubhouse.groupProject, 'update').mockReturnValue(pending.promise);
    render(<GroupProjectsSettingsView />);
    await screen.findByRole('list');
    select();
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Alpha update' } });
    const button = screen.getByRole('button', { name: 'Save changes' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    select('Beta');
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Beta unsaved draft' } });
    await act(async () => {
      if (outcome === 'resolve') pending.resolve({ ...alpha, description: 'Alpha update' });
      else pending.reject(new Error('Write refused'));
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Name')).toHaveValue('Beta');
    expect(screen.getByLabelText('Instructions')).toHaveValue('Beta unsaved draft');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Changes saved to the local registry.')).not.toBeInTheDocument();
  });

  describe('scope (#3355)', () => {
    const projects = [
      { id: 'proj-a', name: 'Proj A', path: '/a' },
      { id: 'proj-b', name: 'Proj B', path: '/b' },
    ];
    beforeEach(() => {
      useProjectStore.setState({ projects: projects as never });
    });

    it('disables network reach with its reason when Annex Network is off', async () => {
      render(<GroupProjectsSettingsView />);
      await screen.findByRole('list', { name: 'Local group projects' });
      await waitFor(() => {
        const network = screen.getAllByRole('radio', { name: 'Network' });
        expect(network[0]).toBeDisabled();
        expect(network[0]).toHaveAccessibleDescription(/Network reach needs Annex Network/);
      });
    });

    it('creates with the project the person chooses, on this computer', async () => {
      const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockResolvedValue({ ...alpha, id: 'gp-new', name: 'New' });
      const preview = vi.spyOn(window.clubhouse.groupProject, 'previewAutoJoin');
      render(<GroupProjectsSettingsView />);
      await screen.findByRole('list', { name: 'Local group projects' });
      fireEvent.change(screen.getByLabelText('New group project name'), { target: { value: 'New' } });
      fireEvent.change(screen.getAllByLabelText('Covers')[0], { target: { value: 'project:proj-b' } });
      expect(screen.getByText('Agents in Proj B on this computer.')).toBeInTheDocument();
      await waitFor(() => expect(preview).toHaveBeenLastCalledWith({ level: 'project', projectId: 'proj-b', reach: 'local' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Create group project' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Create group project' }));
      await waitFor(() => expect(create).toHaveBeenCalledWith('New', { scope: { level: 'project', projectId: 'proj-b', reach: 'local' } }));
    });

    it('shows who would leave before narrowing, and applies with exactly those members confirmed', async () => {
      const preview = vi.spyOn(window.clubhouse.groupProject, 'previewScope').mockResolvedValue({
        scope: { level: 'project', projectId: 'proj-a', reach: 'local' },
        leaving: [{ address: 'agent-b', name: 'builder-b', projectId: 'proj-b' }],
      });
      const narrowed = { ...alpha, scope: { level: 'project' as const, projectId: 'proj-a', reach: 'local' as const } };
      const setScope = vi.spyOn(window.clubhouse.groupProject, 'setScope').mockResolvedValue({ project: narrowed, left: [] });
      render(<GroupProjectsSettingsView />);
      await screen.findByRole('list', { name: 'Local group projects' });
      select('Alpha');
      const editor = screen.getByRole('region', { name: 'Scope' });
      fireEvent.change(within(editor).getByLabelText('Covers'), { target: { value: 'project:proj-a' } });
      fireEvent.click(within(editor).getByRole('button', { name: 'Review change' }));
      expect(await within(editor).findByRole('list', { name: 'Members who would leave' })).toHaveTextContent('builder-b (Proj B)');
      expect(setScope).not.toHaveBeenCalled();
      expect(preview).toHaveBeenCalledWith('gp-alpha', { level: 'project', projectId: 'proj-a', reach: 'local' });
      fireEvent.click(within(editor).getByRole('button', { name: 'Apply and remove 1' }));
      await waitFor(() => expect(setScope).toHaveBeenCalledWith('gp-alpha', { level: 'project', projectId: 'proj-a', reach: 'local' }, { confirmLeaving: ['agent-b'] }));
      expect(await within(editor).findByRole('status')).toHaveTextContent('Scope changed.');
    });

    it('keeps the scope and says why when the host refuses the change', async () => {
      vi.spyOn(window.clubhouse.groupProject, 'previewScope').mockResolvedValue({ scope: { level: 'app', reach: 'local' }, leaving: [] });
      vi.spyOn(window.clubhouse.groupProject, 'setScope').mockRejectedValue(new Error('The members who would leave have changed.'));
      render(<GroupProjectsSettingsView />);
      await screen.findByRole('list', { name: 'Local group projects' });
      select('Beta');
      const editor = screen.getByRole('region', { name: 'Scope' });
      fireEvent.click(within(editor).getByRole('button', { name: 'Review change' }));
      expect(await within(editor).findByText('No members leave.')).toBeInTheDocument();
      fireEvent.click(within(editor).getByRole('button', { name: 'Apply scope' }));
      expect(await within(editor).findByRole('alert')).toHaveTextContent(/Scope not changed.*have changed/);
    });

    it('shows agents a wider scope lets back in before applying it', async () => {
      vi.spyOn(window.clubhouse.groupProject, 'previewScope').mockResolvedValue({
        scope: { level: 'app', reach: 'local' }, leaving: [],
        returning: [{ address: 'agent-o', name: 'outsider', projectId: 'proj-b' }],
      });
      useGroupProjectStore.setState({ projects: [{ ...alpha, scope: { level: 'project', projectId: 'proj-a', reach: 'local' } }], loaded: true, loadError: null });
      render(<GroupProjectsSettingsView />);
      select('Alpha');
      const editor = screen.getByRole('region', { name: 'Scope' });
      fireEvent.change(within(editor).getByLabelText('Covers'), { target: { value: 'app' } });
      fireEvent.click(within(editor).getByRole('button', { name: 'Review change' }));
      expect(await within(editor).findByRole('list', { name: 'Agents who can join again' })).toHaveTextContent('outsider (Proj B)');
      expect(within(editor).getByText('No members leave.')).toBeInTheDocument();
    });

    it('replaces an untouched draft when the scope changes elsewhere', async () => {
      render(<GroupProjectsSettingsView />);
      await screen.findByRole('list', { name: 'Local group projects' });
      select('Alpha');
      const editor = screen.getByRole('region', { name: 'Scope' });
      expect(within(editor).getByLabelText('Covers')).toHaveValue('app');
      act(() => {
        useGroupProjectStore.setState((state) => ({
          projects: state.projects.map((p) => (p.id === 'gp-alpha' ? { ...p, scope: { level: 'project', projectId: 'proj-b', reach: 'local' } } : p)),
        }));
      });
      await waitFor(() => expect(within(editor).getByLabelText('Covers')).toHaveValue('project:proj-b'));
      expect(within(editor).getByRole('button', { name: 'Review change' })).toBeDisabled();
    });
  });

  describe('network group projects (#3363)', () => {
    const copy: GroupProject = {
      ...alpha, id: 'gp-copy', name: 'Launch', scope: { level: 'app', reach: 'network' },
      host: { machine: Array.from({ length: 32 }, () => 'aa').join(':') }, hostName: 'Desk',
      network: {
        role: 'replica', state: 'cached', waitingWrites: 2, refusals: [
          { id: 'r1', groupProjectId: 'gp-copy', op: 'post', reason: 'This group project was deleted.', at: 't', author: { label: 'builder@Studio' } },
        ],
      },
    };

    it('names the host, never its fingerprint, with whether it is reachable and what waits for it', async () => {
      vi.spyOn(window.clubhouse.groupProject, 'list').mockResolvedValue([alpha, copy]);
      render(<GroupProjectsSettingsView />);
      await screen.findByRole('list', { name: 'Local group projects' });
      expect(screen.getByText('Host: Desk, offline. Showing a saved copy, 2 changes wait for it.')).toBeInTheDocument();
      expect(screen.getByText('Host: This computer')).toBeInTheDocument();
      expect(screen.queryByText(/aa:aa/)).not.toBeInTheDocument();
    });

    it('shows the host\'s refusals to the person, clears them, and offers no scope change on a copy', async () => {
      vi.spyOn(window.clubhouse.groupProject, 'list').mockResolvedValue([copy]);
      const dismiss = vi.spyOn(window.clubhouse.groupProject, 'dismissRefusals');
      render(<GroupProjectsSettingsView />);
      await screen.findByRole('list', { name: 'Local group projects' });
      select('Launch');
      expect(screen.getByRole('list', { name: 'Changes the host refused' })).toHaveTextContent('A post by builder@Studio: This group project was deleted.');
      expect(screen.queryByRole('region', { name: 'Scope' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Clear this list' }));
      await waitFor(() => expect(dismiss).toHaveBeenCalledWith('gp-copy'));
      await waitFor(() => expect(screen.queryByRole('list', { name: 'Changes the host refused' })).not.toBeInTheDocument());
    });
  });
});
