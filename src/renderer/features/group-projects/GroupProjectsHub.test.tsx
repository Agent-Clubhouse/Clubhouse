import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProject, GroupProjectCoverage } from '../../../shared/group-project-types';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { GroupProjectsHub } from './GroupProjectsHub';
import type { GroupProjectsView } from './groupProjectsNavStore';

const group = (id: string, name: string, over: Partial<GroupProject> = {}): GroupProject => ({
  id, name, description: '', instructions: '', createdAt: '2026-11-15T00:00:00Z', metadata: {},
  scope: { level: 'app', reach: 'local' }, ...over,
});
const atlasGroup = group('g1', 'Release checks', { scope: { level: 'project', projectId: 'p-atlas', reach: 'local' } });
const appGroup = group('g2', 'Daily coordination');
const beaconGroup = group('g3', 'Beacon board', { scope: { level: 'project', projectId: 'p-beacon', reach: 'local' } });
const legacy = group('g4', 'Legacy review', { scope: undefined });
const copy = group('g5', 'Release planning', {
  scope: { level: 'project', projectId: 'host-project', reach: 'network' }, hostName: 'Studio Mac',
  network: { role: 'replica', state: 'cached', waitingWrites: 1, refusals: [] },
});

function Harness({ initial = { kind: 'all' } as GroupProjectsView, onOpen = () => {} }: { initial?: GroupProjectsView; onOpen?: (id: string) => void }) {
  const [view, setView] = useState<GroupProjectsView>(initial);
  const [query, setQuery] = useState('');
  return <GroupProjectsHub view={view} onViewChange={setView} query={query} onQueryChange={setQuery} onOpenGroup={onOpen} />;
}
beforeEach(() => {
  useGroupProjectStore.setState({ projects: [], loaded: false, loadError: null, directorySelection: null });
  useProjectStore.setState({ projects: [{ id: 'p-atlas', name: 'atlas', displayName: 'Atlas', path: '/a' }, { id: 'p-beacon', name: 'Beacon', path: '/b' }] as never });
  vi.spyOn(window.clubhouse.groupProject, 'list').mockResolvedValue([atlasGroup, appGroup, beaconGroup, legacy, copy]);
  vi.spyOn(window.clubhouse.groupProject, 'listMembers').mockResolvedValue({ members: [{}, {}] } as never);
});

describe('GroupProjectsHub states', () => {
  it('says it is loading, and keeps New group project off until the inventory is known', async () => {
    let resolve!: (v: GroupProject[]) => void;
    vi.mocked(window.clubhouse.groupProject.list).mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<Harness />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading group projects');
    expect(screen.getByRole('button', { name: 'New group project' })).toBeDisabled();
    await act(async () => { resolve([appGroup]); });
    expect(await screen.findByRole('button', { name: 'Daily coordination' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New group project' })).toBeEnabled();
  });

  it('says first run plainly, and offers to create one', async () => {
    vi.mocked(window.clubhouse.groupProject.list).mockResolvedValue([]);
    render(<Harness />);
    const first = await screen.findByTestId('group-projects-first-run');
    expect(first).toHaveTextContent('No group projects yet.');
    expect(first).toHaveTextContent('Give agents a shared board and coordinate work.');
    fireEvent.click(within(first).getByRole('button', { name: 'Create group project' }));
    expect(await screen.findByLabelText('New group project name')).toBeInTheDocument();
  });

  it('shows a load failure as an error, not as an empty list, and retries the real request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(window.clubhouse.groupProject.list).mockRejectedValueOnce(new Error('Registry unreadable'));
    render(<Harness />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The inventory is unavailable. Registry unreadable');
    expect(screen.queryByText('No group projects yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(await screen.findByRole('button', { name: 'Daily coordination' })).toBeInTheDocument();
    expect(window.clubhouse.groupProject.list).toHaveBeenCalledTimes(2);
  });
});

describe('GroupProjectsHub list', () => {
  it('sections by project and app-wide, with scope, reach and host in plain text', async () => {
    render(<Harness />);
    await screen.findByRole('button', { name: 'Daily coordination' });
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Atlas', 'Beacon', 'Projects on Studio Mac', 'App-wide', 'Needs scope review']);
    const atlasRow = screen.getByRole('button', { name: 'Release checks' });
    expect(atlasRow).toHaveTextContent('Scope: Atlas. Reach: This computer.');
    expect(atlasRow).toHaveTextContent('Host: This computer');
    expect(await within(atlasRow).findByText('2 members')).toBeInTheDocument();
    const copyRow = screen.getByRole('button', { name: 'Release planning' });
    expect(copyRow).toHaveTextContent('Scope: a project on Studio Mac. Reach: Network.');
    expect(copyRow).toHaveTextContent('Host: Studio Mac, offline. Showing a saved copy, 1 change waits for it.');
    expect(screen.getByRole('button', { name: 'Legacy review' })).toHaveTextContent('Scope unresolved. Existing members kept.');
    expect(screen.getByText(/Coverage not verified on this computer/)).toBeInTheDocument();
  });

  it('opens a group by its id when its row is clicked', async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Beacon board' }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('g3');
  });

  it('searches by name, project and host, counts results, and clears', async () => {
    render(<Harness />);
    await screen.findByRole('button', { name: 'Daily coordination' });
    const search = screen.getByRole('searchbox', { name: 'Search group projects' });
    expect(screen.getByText('5 group projects')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'studio' } });
    expect(screen.getByText('1 group project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Release planning' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Daily coordination' })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'atlas' } });
    expect(screen.getByRole('button', { name: 'Release checks' })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No matches.')).toBeInTheDocument();
    expect(screen.queryByText('No group projects yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(screen.getByText('5 group projects')).toBeInTheDocument();
  });

  it('lists rows as plain buttons, with no pressed state a screen reader would announce', async () => {
    render(<Harness />);
    const row = await screen.findByRole('button', { name: 'Daily coordination' });
    expect(row).not.toHaveAttribute('aria-pressed');
  });

  it('closes the form and opens the new group when one is created', async () => {
    const created = group('g9', 'Fresh group');
    vi.spyOn(window.clubhouse.groupProject, 'create').mockResolvedValue(created);
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    await screen.findByRole('button', { name: 'Daily coordination' });
    fireEvent.click(screen.getByRole('button', { name: 'New group project' }));
    fireEvent.change(await screen.findByLabelText('New group project name'), { target: { value: 'Fresh group' } });
    const submit = screen.getByRole('button', { name: 'Create group project' });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(onOpen).toHaveBeenCalledExactlyOnceWith('g9'));
    expect(screen.queryByLabelText('New group project name')).not.toBeInTheDocument();
  });
});

describe('GroupProjectsHub project view (lens)', () => {
  it('titles itself for the project and lists its verified groups, app-wide groups, and unverifiable copies', async () => {
    render(<Harness initial={{ kind: 'project', projectId: 'p-atlas' }} />);
    await screen.findByRole('button', { name: 'Release checks' });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Atlas and app-wide');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Atlas', 'App-wide', 'Copies from other computers']);
    expect(screen.getByRole('button', { name: 'Daily coordination' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Release planning' })).toBeInTheDocument();
    expect(screen.getByText(/Coverage not verified on this computer/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Beacon board' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Legacy review' })).not.toBeInTheDocument();
  });

  it('escapes to All groups from the header and from the count of what it hides', async () => {
    render(<Harness initial={{ kind: 'project', projectId: 'p-atlas' }} />);
    await screen.findByRole('button', { name: 'Release checks' });
    expect(screen.getByRole('status')).toHaveTextContent('2 other groups are not shown.');
    fireEvent.click(screen.getByRole('button', { name: 'Show all groups' }));
    expect(await screen.findByRole('button', { name: 'Beacon board' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Group Projects');
    expect(screen.queryByRole('button', { name: 'All groups' })).not.toBeInTheDocument();
  });

  it('has an All groups button that shows every group', async () => {
    render(<Harness initial={{ kind: 'project', projectId: 'p-atlas' }} />);
    await screen.findByRole('button', { name: 'Release checks' });
    fireEvent.click(screen.getByRole('button', { name: 'All groups' }));
    expect(await screen.findByRole('button', { name: 'Legacy review' })).toBeInTheDocument();
  });

  it('says so when the project has no group of its own, and still lists app-wide groups', async () => {
    vi.mocked(window.clubhouse.groupProject.list).mockResolvedValue([appGroup, beaconGroup]);
    render(<Harness initial={{ kind: 'project', projectId: 'p-atlas' }} />);
    expect(await screen.findByText('No group projects just for Atlas.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Daily coordination' })).toBeInTheDocument();
  });

  it('starts a new group on this project, on this computer', async () => {
    render(<Harness initial={{ kind: 'project', projectId: 'p-atlas' }} />);
    await screen.findByRole('button', { name: 'Release checks' });
    fireEvent.click(screen.getByRole('button', { name: 'New group project' }));
    await waitFor(() => expect(screen.getAllByLabelText('Covers')[0]).toHaveValue('project:p-atlas'));
  });

  it('searches inside the view', async () => {
    render(<Harness initial={{ kind: 'project', projectId: 'p-atlas' }} />);
    await screen.findByRole('button', { name: 'Release checks' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search group projects' }), { target: { value: 'daily' } });
    expect(screen.getByRole('button', { name: 'Daily coordination' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release checks' })).not.toBeInTheDocument();
  });
});

describe('GroupProjectsHub verified coverage (#3549)', () => {
  const coverage = (over: Partial<GroupProjectCoverage> = {}): GroupProjectCoverage => ({
    groupProjectId: 'g5', scoped: true, copies: [], localUnknown: false, complete: true, repositoryMatches: [], ...over,
  });
  const linked = coverage({ copies: [
    { machine: 'self', projectId: 'p-atlas', name: 'Atlas', thisComputer: true, state: 'verified' },
    { machine: 'host', projectId: 'host-project', name: 'Atlas on Studio Mac', thisComputer: false, state: 'verified' },
  ] });
  const show = (list: GroupProjectCoverage[]) => vi.spyOn(window.clubhouse.groupProject, 'getCoverage').mockResolvedValue(list);

  it('lists a copy linked to this project under the project, with what it covers', async () => {
    show([linked]);
    render(<Harness initial={{ kind: 'project', projectId: 'p-atlas' }} />);
    await screen.findByRole('button', { name: 'Release planning' });
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Atlas', 'App-wide']));
    expect(screen.getByText('Covers Atlas, Atlas on Studio Mac.')).toBeInTheDocument();
    expect(screen.queryByText(/Coverage not verified on this computer/)).not.toBeInTheDocument();
  });

  it('shows a copy this computer cannot check as not verified, and a checked non-covering copy not at all', async () => {
    show([coverage({ localUnknown: true, complete: false })]);
    const { unmount } = render(<Harness initial={{ kind: 'project', projectId: 'p-atlas' }} />);
    await screen.findByRole('button', { name: 'Release planning' });
    await waitFor(() => expect(screen.getAllByText(/Coverage not verified on this computer/).length).toBeGreaterThan(0));
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toContain('Copies from other computers');
    unmount();
    show([coverage()]);
    render(<Harness initial={{ kind: 'project', projectId: 'p-atlas' }} />);
    await screen.findByRole('button', { name: 'Daily coordination' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Release planning' })).not.toBeInTheDocument());
  });

  it('shows not verified, and says so, when coverage cannot be read', async () => {
    vi.spyOn(window.clubhouse.groupProject, 'getCoverage').mockRejectedValue(new Error('boom'));
    render(<Harness initial={{ kind: 'project', projectId: 'p-atlas' }} />);
    expect(await screen.findByText(/Coverage could not be read/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Release planning' })).toBeInTheDocument();
    expect(screen.getAllByText(/Coverage not verified on this computer/).length).toBeGreaterThan(0);
  });

  it('offers a link for a repository match without linking, covering or including it', async () => {
    show([coverage({ repositoryMatches: [{ projectId: 'p-atlas', name: 'Atlas' }] })]);
    const openProjectSettings = vi.fn();
    useUIStore.setState({ openProjectSettings });
    const link = vi.spyOn(window.clubhouse.groupProject, 'setAutomaticMembership');
    render(<Harness />);
    const offer = await screen.findByRole('button', { name: 'Offer to link Atlas' });
    expect(screen.getByText(/not linked, so it is not covered/)).toBeInTheDocument();
    fireEvent.click(offer);
    expect(openProjectSettings).toHaveBeenCalledExactlyOnceWith('p-atlas');
    expect(link).not.toHaveBeenCalled();
  });
});
