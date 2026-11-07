import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useChromeStore } from '../chromeStore';
import { useAgentStore } from '../../stores/agentStore';
import { SettingsNav } from './SettingsNav';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';

beforeEach(() => {
  useUIStore.setState({ explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'about' });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Clubhouse', path: '/ch' }, { id: 'p2', name: 'Goobers', path: '/gb' }] as never });
});

const visibleProjectOrder = () => [...screen.getByTestId('settings-nav')
  .querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
  .map((button) => button.dataset.testid!.replace('settings-nav-project-', ''));

describe('SettingsNav', () => {
  it('lists the app pages and every project', () => {
    render(<SettingsNav />);
    expect(screen.getByTestId('settings-nav')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-app-about').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('settings-nav-project-p1')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-project-p2')).toBeTruthy();
  });

  it('follows persisted manual reorder and retains selected expanded project and focus', async () => {
    useUIStore.setState({ settingsContext: 'p2', settingsSubPage: 'notifications' });
    render(<SettingsNav />);
    const selected = screen.getByTestId('settings-nav-project-p2');
    act(() => selected.focus());
    const projects = useProjectStore.getState().projects;
    vi.spyOn(window.clubhouse.project, 'reorder').mockResolvedValue([projects[1], projects[0]]);
    await act(async () => { await useProjectStore.getState().reorderProjects(['p2', 'p1']); });
    expect(window.clubhouse.project.reorder).toHaveBeenCalledWith(['p2', 'p1']);
    expect(visibleProjectOrder()).toEqual(['p2', 'p1']);
    expect(document.activeElement).toBe(selected);
    expect(selected).toHaveAttribute('aria-expanded', 'true');
    expect(useUIStore.getState()).toMatchObject({ settingsContext: 'p2', settingsSubPage: 'notifications' });
    expect(screen.getByTestId('settings-nav-project-page-notifications')).toHaveAttribute('aria-current', 'page');
  });
  it('does not reshuffle for display-name edits, Recent mode, pinned/idle groups or running agents', () => {
    useUIStore.setState({ settingsContext: 'p2', settingsSubPage: 'project' });
    render(<SettingsNav />);
    act(() => {
      useProjectStore.setState((state) => ({ projects: state.projects.map((project) => ({ ...project, displayName: project.id === 'p1' ? 'Zulu' : 'Alpha' })) }));
      useChromeStore.setState({ projectSort: 'recent', pinnedProjectIds: ['p2'], inactiveProjectIds: ['p1'], projectActivity: { p2: Date.now(), p1: 1 } });
      useAgentStore.setState({ agents: { a: { id: 'a', projectId: 'p1', name: 'a', kind: 'durable', status: 'running', color: 'blue' } } });
    });
    expect(visibleProjectOrder()).toEqual(['p1', 'p2']);
    expect(screen.getByTestId('settings-nav-project-p2')).toHaveTextContent('Alpha');
    expect(screen.getByTestId('settings-nav-project-p2')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Saved manual order/)).toBeVisible();
  });
  it('appends newly registered projects and removes only the closed entry, keeping selected scope', async () => {
    useUIStore.setState({ settingsContext: 'p2', settingsSubPage: 'plugins' });
    render(<SettingsNav />);
    vi.spyOn(window.clubhouse.project, 'add').mockResolvedValue({ id: 'p3', name: 'New', path: '/synthetic/new' });
    vi.spyOn(window.clubhouse.project, 'remove').mockResolvedValue(undefined);
    await act(async () => { await useProjectStore.getState().addProject('/synthetic/new'); });
    expect(visibleProjectOrder()).toEqual(['p1', 'p2', 'p3']);
    await act(async () => { await useProjectStore.getState().removeProject('p1'); });
    expect(visibleProjectOrder()).toEqual(['p2', 'p3']);
    expect(screen.getByTestId('settings-nav-project-p2')).toHaveAttribute('aria-expanded', 'true');
    expect(useUIStore.getState()).toMatchObject({ settingsContext: 'p2', settingsSubPage: 'plugins' });
  });
  it('keeps native keyboard tab order aligned with the visible project order', async () => {
    useProjectStore.setState((state) => ({ projects: [...state.projects].reverse() }));
    render(<SettingsNav />);
    const user = userEvent.setup();
    act(() => screen.getByTestId('settings-nav-project-p2').focus());
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('settings-nav-project-p1'));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByTestId('settings-nav-project-p2'));
  });

  it('shows the Managed agents group only with the flag on (#2819)', async () => {
    const { unmount } = render(<SettingsNav />);
    await act(async () => {});
    expect(screen.queryByTestId('settings-nav-group-managed')).toBeNull();
    expect(screen.queryByTestId('settings-nav-app-managed-blocks')).toBeNull();
    expect(screen.getByTestId('settings-nav-app-helpers')).toBeTruthy();
    unmount();

    vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue({ managedAgents: true } as never);
    render(<SettingsNav />);
    await screen.findByTestId('settings-nav-group-managed');
    const order = [...screen.getByTestId('settings-nav').querySelectorAll<HTMLElement>('[data-testid^="settings-nav-app-"], [data-testid="settings-nav-group-managed"]')]
      .slice(0, 9).map((el) => el.dataset.testid!.replace('settings-nav-app-', ''));
    expect(order).toEqual(['about', 'orchestrators', 'settings-nav-group-managed', 'managed-blocks', 'managed-skills', 'managed-mcp', 'managed-templates', 'managed-orchestration', 'helpers']);
    expect(screen.getByText('Agent parts')).toBeTruthy();
    expect(screen.getAllByTestId('settings-nav-app-helpers')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('settings-nav-app-managed-skills'));
    expect(useUIStore.getState()).toMatchObject({ settingsContext: 'app', settingsSubPage: 'managed-skills' });
  });

  it('opens an app page', () => {
    render(<SettingsNav />);
    fireEvent.click(screen.getByTestId('settings-nav-app-display'));
    expect(useUIStore.getState()).toMatchObject({ settingsContext: 'app', settingsSubPage: 'display' });
  });

  it('expands a project into its pages and opens them', () => {
    render(<SettingsNav />);
    fireEvent.click(screen.getByTestId('settings-nav-project-p2'));
    expect(useUIStore.getState()).toMatchObject({ settingsContext: 'p2', settingsSubPage: 'project' });
    fireEvent.click(screen.getByTestId('settings-nav-project-page-notifications'));
    expect(useUIStore.getState()).toMatchObject({ settingsContext: 'p2', settingsSubPage: 'notifications' });
  });
});
