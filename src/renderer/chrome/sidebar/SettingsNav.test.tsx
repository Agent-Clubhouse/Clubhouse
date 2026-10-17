import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsNav } from './SettingsNav';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';

beforeEach(() => {
  useUIStore.setState({ explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'about' });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Clubhouse', path: '/ch' }, { id: 'p2', name: 'Goobers', path: '/gb' }] as never });
});

describe('SettingsNav', () => {
  it('lists the app pages and every project', () => {
    render(<SettingsNav />);
    expect(screen.getByTestId('settings-nav')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-app-about').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('settings-nav-project-p1')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-project-p2')).toBeTruthy();
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
    fireEvent.click(screen.getByTestId('settings-nav-project-notifications'));
    expect(useUIStore.getState()).toMatchObject({ settingsContext: 'p2', settingsSubPage: 'notifications' });
  });
});
