import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProject, GroupProjectOperation } from '../../../shared/group-project-types';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { GroupProjectDetailsSection } from './GroupProjectDetailsSection';

const GP = 'gp_details';
const api = () => window.clubhouse.groupProject;
const host: GroupProject = {
  id: GP, name: 'Release', description: 'Ship it', instructions: 'Be kind', createdAt: '2026-11-15T00:00:00Z',
  scope: { level: 'app', reach: 'local' }, metadata: {},
};
const copy: GroupProject = {
  ...host, scope: { level: 'app', reach: 'network' }, hostName: 'Studio Mac',
  network: { role: 'replica', state: 'cached', waitingWrites: 0, refusals: [] },
};
const since = '2026-11-16T10:00:00.000Z';
const waiting = (id = 'w1'): GroupProjectOperation => ({
  id, groupProjectId: GP, op: 'update', section: 'details', author: { label: 'user' }, since,
  outcome: { status: 'queued', waitingFor: 'Studio Mac', since },
});

function setup(project: GroupProject, afterSave: GroupProjectOperation[]) {
  useGroupProjectStore.setState({ projects: [project], loaded: true, loadError: null, operations: {} });
  // The change is forwarded when Save is pressed: until then nothing is waiting.
  let saved = false;
  vi.spyOn(api(), 'getOperations').mockImplementation(async () => ({ operations: saved ? afterSave : [], omittedQueued: 0 }));
  vi.spyOn(api(), 'update').mockImplementation(async (id, fields) => {
    saved = true;
    // A copy answers with its own current record: the host has not applied the change.
    return project.network ? project : { ...project, ...fields, id };
  });
  return render(<GroupProjectDetailsSection project={project} />);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('GroupProjectDetailsSection outcomes', () => {
  it('on the host, saves as before', async () => {
    setup(host, []);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Release 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved to the local registry.')).toBeInTheDocument();
    expect(screen.queryByTestId('group-operation-status')).toBeNull();
  });

  it('on a copy, a change only queued says it is waiting for the host and never says saved', async () => {
    setup(copy, [waiting()]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Release 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Details change: Waiting for Studio Mac since/)).toBeInTheDocument();
    expect(screen.queryByText(/^(Changes saved|Saved|Submitted)/)).toBeNull();
    // What was submitted stays in the form while it waits, rather than snapping back to the host's name.
    expect(screen.getByLabelText('Name')).toHaveValue('Release 2');
  });

  it('on a copy, an applied change says Applied', async () => {
    setup(copy, [{ ...waiting(), outcome: { status: 'applied' }, settledAt: '2026-11-16T10:00:05.000Z' }]);
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Details change: Applied')).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for/)).toBeNull();
  });

  it('when the host later refuses it, says why and goes back to the host\'s values', async () => {
    setup(copy, [waiting()]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Release 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText(/Waiting for Studio Mac/);
    expect(screen.getByLabelText('Name')).toHaveValue('Release 2');

    vi.mocked(api().getOperations).mockResolvedValue({
      operations: [{ ...waiting(), outcome: { status: 'refused', reason: 'Only an admin can do that.' }, settledAt: '2026-11-16T11:00:00.000Z' }], omittedQueued: 0,
    });
    await act(async () => { await useGroupProjectStore.getState().loadOperations(GP); });
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Release'));
    expect(screen.getByText('Details change: Refused: Only an admin can do that.')).toBeInTheDocument();
  });

  it('when nothing is waiting any more and the latest is not applied, the held form goes back to the host\'s values', async () => {
    setup(copy, [waiting()]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Release 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText(/Waiting for Studio Mac/);
    expect(screen.getByLabelText('Name')).toHaveValue('Release 2');

    // The status is gone (unknown), not applied: nothing holds the form.
    vi.mocked(api().getOperations).mockResolvedValue({ operations: [], omittedQueued: 0 });
    await act(async () => { await useGroupProjectStore.getState().loadOperations(GP); });
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Release'));
    expect(screen.queryByTestId('group-operation-status')).toBeNull();
  });

  it('a change refused at once is an error on the form, with the draft kept', async () => {
    useGroupProjectStore.setState({ projects: [copy], loaded: true, loadError: null, operations: {} });
    vi.spyOn(api(), 'getOperations').mockResolvedValue({ operations: [], omittedQueued: 0 });
    vi.spyOn(api(), 'update').mockRejectedValue(new Error('Studio Mac refused this change: Only an admin can do that.'));
    render(<GroupProjectDetailsSection project={copy} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved. Studio Mac refused this change');
    expect(screen.getByLabelText('Name')).toHaveValue('Nope');
  });
});
