import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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
    useGroupProjectStore.setState({ projects: [], loaded: false, loadError: null });
    useProjectStore.setState({ activeProjectId: 'selected-project' });
    vi.spyOn(window.clubhouse.groupProject, 'list').mockResolvedValue([alpha, beta]);
  });

  it('lists every local registry record without a Canvas, and leaves legacy scope unresolved', async () => {
    render(<GroupProjectsSettingsView />);
    expect(await screen.findByRole('list', { name: 'Local group projects' })).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    select('Beta');
    expect(screen.getByLabelText('Name')).toHaveValue('Beta');
    expect(screen.getAllByText(/Scope unresolved: legacy or missing scope/)).toHaveLength(2);
    expect(screen.getByText(/Stored on this machine/)).toBeInTheDocument();
    expect(screen.getByText(/Network creation needs an authoritative host backend/)).toBeInTheDocument();
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
    expect(await screen.findByRole('status')).toHaveTextContent('Changes saved to the local registry');
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
});
