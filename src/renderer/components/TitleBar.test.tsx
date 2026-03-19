import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { TitleBar } from './TitleBar';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { usePluginStore } from '../plugins/plugin-store';
import type { PluginManifest, PluginSource } from '../../shared/plugin-types';

function registerPlugin(id: string, manifest: Partial<PluginManifest>) {
  usePluginStore.getState().registerPlugin(
    { id, version: '0.1.0', apiVersion: 0.6, name: id, ...manifest } as PluginManifest,
    'builtin' as PluginSource,
    `/plugins/${id}`,
  );
}

beforeEach(() => {
  useUIStore.setState({ explorerTab: 'agents' });
  useProjectStore.setState({ projects: [], activeProjectId: null });
  usePluginStore.setState({ plugins: {}, pluginTitles: {} });
});

describe('TitleBar', () => {
  it('shows core label for built-in tabs', () => {
    useUIStore.setState({ explorerTab: 'settings' });
    render(<TitleBar />);
    expect(screen.getByTestId('title-bar').textContent).toBe('Settings');
  });

  it('shows manifest label for project-scoped plugin tab', () => {
    registerPlugin('terminal', {
      name: 'Terminal',
      contributes: {
        tab: { label: 'Terminal' },
        permissions: [],
        helpTopics: [],
      },
    });
    useUIStore.setState({ explorerTab: 'plugin:terminal' });
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'proj', path: '/tmp' }] as any,
      activeProjectId: 'p1',
    });
    render(<TitleBar />);
    expect(screen.getByTestId('title-bar').textContent).toBe('Terminal (proj)');
  });

  it('shows manifest label for app-scoped plugin tab (canvas)', () => {
    registerPlugin('canvas', {
      name: 'Canvas',
      contributes: {
        railItem: { label: 'Canvas', icon: '<svg/>' },
        permissions: [],
        helpTopics: [],
      },
    });
    useUIStore.setState({ explorerTab: 'plugin:app:canvas' });
    render(<TitleBar />);
    // Should show "Canvas", NOT "plugin:app:canvas" or "app:canvas"
    expect(screen.getByTestId('title-bar').textContent).toBe('Canvas');
  });

  it('shows manifest label for app-scoped plugin tab (hub)', () => {
    registerPlugin('hub', {
      name: 'Hub',
      contributes: {
        railItem: { label: 'Hub', icon: '<svg/>' },
        permissions: [],
        helpTopics: [],
      },
    });
    useUIStore.setState({ explorerTab: 'plugin:app:hub' });
    render(<TitleBar />);
    expect(screen.getByTestId('title-bar').textContent).toBe('Hub');
  });

  it('shows dynamic title from window.setTitle() for app-scoped plugin', () => {
    registerPlugin('canvas', {
      name: 'Canvas',
      contributes: {
        railItem: { label: 'Canvas', icon: '<svg/>' },
        permissions: [],
        helpTopics: [],
      },
    });
    usePluginStore.getState().setPluginTitle('canvas', 'My Workspace');
    useUIStore.setState({ explorerTab: 'plugin:app:canvas' });
    render(<TitleBar />);
    expect(screen.getByTestId('title-bar').textContent).toBe('My Workspace');
  });

  it('shows railItem.title over railItem.label when both present', () => {
    registerPlugin('canvas', {
      name: 'Canvas',
      contributes: {
        railItem: { label: 'Canvas Rail', icon: '<svg/>', title: 'Canvas Title' },
        permissions: [],
        helpTopics: [],
      },
    });
    useUIStore.setState({ explorerTab: 'plugin:app:canvas' });
    render(<TitleBar />);
    expect(screen.getByTestId('title-bar').textContent).toBe('Canvas Title');
  });

  it('falls back to explorerTab string when plugin not in store', () => {
    // No plugin registered — should fall back gracefully
    useUIStore.setState({ explorerTab: 'plugin:app:unknown' });
    render(<TitleBar />);
    // Without plugin entry, falls through CORE_LABELS → explorerTab
    expect(screen.getByTestId('title-bar').textContent).toBe('plugin:app:unknown');
  });

  it('appends project name in parentheses when project is active', () => {
    registerPlugin('canvas', {
      name: 'Canvas',
      contributes: {
        railItem: { label: 'Canvas', icon: '<svg/>' },
        permissions: [],
        helpTopics: [],
      },
    });
    useUIStore.setState({ explorerTab: 'plugin:app:canvas' });
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'my-project', path: '/tmp', displayName: 'My Project' }] as any,
      activeProjectId: 'p1',
    });
    render(<TitleBar />);
    expect(screen.getByTestId('title-bar').textContent).toBe('Canvas (My Project)');
  });
});
