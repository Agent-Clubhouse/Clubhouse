import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProject } from '../../../shared/group-project-types';
import { useUIStore } from '../../stores/uiStore';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { GroupProjectsSettingsView } from '../settings/GroupProjectsSettingsView';
import { GroupProjectsPane } from './GroupProjectsPane';
import { openGroupProjectsForProject, openGroupProjectsHub, openGroupWorkspace } from './groupProjectsNav';
import { useGroupProjectsNavStore } from './groupProjectsNavStore';

const alpha: GroupProject = {
  id: 'gp-alpha', name: 'Alpha', description: 'First group', instructions: '', createdAt: '2026-11-15T00:00:00Z',
  scope: { level: 'app', reach: 'local' }, metadata: {},
};
const beta: GroupProject = { ...alpha, id: 'gp-beta', name: 'Beta', scope: { level: 'project', projectId: 'p1', reach: 'local' } };

beforeEach(() => {
  useGroupProjectStore.setState({ projects: [], loaded: false, loadError: null, directorySelection: null });
  useGroupProjectsNavStore.setState({ route: null, view: { kind: 'all' }, query: '' });
  useUIStore.setState({ explorerTab: 'agents', activeHostId: null });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Clubhouse', path: '/ch' }] as never });
  vi.spyOn(window.clubhouse.groupProject, 'list').mockResolvedValue([alpha, beta]);
});

describe('GroupProjectsPane, main pane', () => {
  it('shows the hub, and a row opens that group at the group-workspace route', async () => {
    render(<GroupProjectsPane surface="main" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
    expect(useGroupProjectsNavStore.getState().route).toEqual({ groupId: 'gp-alpha' });
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:group-projects');
    expect(await screen.findByTestId('group-project-workspace')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Alpha');
  });

  it('goes back to the hub with the view and search it left', async () => {
    useGroupProjectsNavStore.setState({ view: { kind: 'project', projectId: 'p1' }, query: 'beta' });
    render(<GroupProjectsPane surface="main" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Beta' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to Group Projects' }));
    expect(await screen.findByRole('button', { name: 'Beta' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search group projects' })).toHaveValue('beta');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Clubhouse and app-wide');
  });

  it('opens a route set elsewhere, loading the directory first', async () => {
    act(() => openGroupWorkspace({ groupId: 'gp-beta', section: 'members' }));
    render(<GroupProjectsPane surface="main" />);
    expect(await screen.findByLabelText('Name')).toHaveValue('Beta');
    expect(useGroupProjectsNavStore.getState().route).toEqual({ groupId: 'gp-beta', section: 'members' });
  });

  it('says a group is gone when its id is no longer known, and goes back from there', async () => {
    useGroupProjectsNavStore.setState({ route: { groupId: 'gp-gone' } });
    render(<GroupProjectsPane surface="main" />);
    expect(await screen.findByText('This group project is no longer available on this computer.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Group Projects' }));
    expect(await screen.findByRole('button', { name: 'Alpha' })).toBeInTheDocument();
  });
});

describe('opening Group Projects', () => {
  it('opens the hub for all groups, closes an open group, and keeps the search', () => {
    useGroupProjectsNavStore.setState({ route: { groupId: 'gp-alpha' }, view: { kind: 'project', projectId: 'p1' }, query: 'q' });
    openGroupProjectsHub();
    expect(useGroupProjectsNavStore.getState()).toMatchObject({ route: null, view: { kind: 'all' }, query: 'q' });
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:group-projects');
  });

  it('opens one project\'s view', () => {
    openGroupProjectsForProject('p1');
    expect(useGroupProjectsNavStore.getState()).toMatchObject({ route: null, view: { kind: 'project', projectId: 'p1' } });
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:group-projects');
  });

  it('opens a group without a section on its default, and keeps a named section', () => {
    openGroupWorkspace({ groupId: 'gp-alpha' });
    expect(useGroupProjectsNavStore.getState().route).toEqual({ groupId: 'gp-alpha' });
    openGroupWorkspace({ groupId: 'gp-alpha', section: 'actions' });
    expect(useGroupProjectsNavStore.getState().route).toEqual({ groupId: 'gp-alpha', section: 'actions' });
  });
});

describe('Settings > Group Projects renders the same UI', () => {
  it('renders the same hub component as the main pane, not a manager of its own', async () => {
    const { unmount } = render(<GroupProjectsPane surface="main" />);
    const main = await screen.findByTestId('group-projects-hub');
    const mainRows = within(main).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    unmount();
    render(<GroupProjectsSettingsView />);
    const settings = await screen.findByTestId('group-projects-hub');
    const settingsRows = within(settings).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(settingsRows).toEqual(mainRows);
    expect(within(settings).getByRole('searchbox', { name: 'Search group projects' })).toBeInTheDocument();
    expect(within(settings).getByRole('heading', { level: 2 })).toHaveTextContent('Group Projects');
  });

  it('keeps its deep link: a directory selection opens that group under the hub', async () => {
    useGroupProjectStore.getState().selectDirectoryProject('gp-beta');
    render(<GroupProjectsSettingsView />);
    expect(await screen.findByLabelText('Name')).toHaveValue('Beta');
    expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens the selected group in the main view, at the same route, leaving Settings', async () => {
    useUIStore.setState({ explorerTab: 'settings' });
    useGroupProjectStore.getState().selectDirectoryProject('gp-beta');
    render(<GroupProjectsSettingsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in main view' }));
    expect(useGroupProjectsNavStore.getState().route).toEqual({ groupId: 'gp-beta' });
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:group-projects');
  });

  it('keeps its own view and search, apart from the main pane', async () => {
    useGroupProjectsNavStore.setState({ view: { kind: 'project', projectId: 'p1' }, query: 'beta' });
    render(<GroupProjectsSettingsView />);
    expect(await screen.findByRole('button', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search group projects' })).toHaveValue('');
  });
});
