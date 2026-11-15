import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
