import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../features/agents/AgentList', () => ({
  AgentList: () => <div data-testid="agent-list" />,
}));

import { ChromeSidebar } from './ChromeSidebar';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { usePluginStore } from '../plugins/plugin-store';
import type { PluginManifest, PluginSource } from '../../shared/plugin-types';

function registerAppPlugin(id: string, label: string, position: 'top' | 'bottom' = 'top') {
  usePluginStore.getState().registerPlugin(
    { id, version: '0.1.0', apiVersion: 0.8, name: label, scope: 'app', contributes: { railItem: { label, position } } } as unknown as PluginManifest,
    'builtin' as PluginSource,
    `/plugins/${id}`,
  );
}

const projects = [
  { id: 'p1', name: 'Clubhouse', path: '/tmp/ch' },
  { id: 'p2', name: 'Goobers', path: '/tmp/gb' },
];

beforeEach(() => {
  useUIStore.setState({ explorerTab: 'agents', projectExplorerTab: {} });
  useProjectStore.setState({ projects: projects as never, activeProjectId: 'p1', projectIcons: {} });
  usePluginStore.setState({ plugins: {}, appEnabled: [] });
});

describe('ChromeSidebar', () => {
  it('lists projects with the legacy project-<id> test ids and marks the active one', () => {
    render(<ChromeSidebar />);
    expect(screen.getByTestId('project-p1').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('project-p2').getAttribute('data-active')).toBe('false');
  });

  it('selects a project', () => {
    render(<ChromeSidebar />);
    fireEvent.click(screen.getByTestId('project-p2'));
    expect(useProjectStore.getState().activeProjectId).toBe('p2');
  });

  it('shows the active project agent list in project view only', () => {
    const { rerender } = render(<ChromeSidebar />);
    expect(screen.getByTestId('agent-list')).toBeTruthy();
    useUIStore.setState({ explorerTab: 'settings' });
    rerender(<ChromeSidebar />);
    expect(screen.queryByTestId('agent-list')).toBeNull();
  });

  it('keeps the footer test ids and toggles Settings and Help', () => {
    render(<ChromeSidebar />);
    fireEvent.click(screen.getByTestId('nav-settings'));
    expect(useUIStore.getState().explorerTab).toBe('settings');
    fireEvent.click(screen.getByTestId('nav-help'));
    expect(useUIStore.getState().explorerTab).toBe('help');
    expect(screen.getByTestId('nav-add-project')).toBeTruthy();
  });

  it('opens app-level plugin views from the app row', () => {
    registerAppPlugin('canvas', 'Canvas');
    registerAppPlugin('logs', 'Logs', 'bottom');
    usePluginStore.setState({ appEnabled: ['canvas', 'logs'] });
    render(<ChromeSidebar />);
    fireEvent.click(screen.getByTitle('Canvas'));
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:canvas');
    fireEvent.click(screen.getByLabelText('Logs'));
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:logs');
  });
});
