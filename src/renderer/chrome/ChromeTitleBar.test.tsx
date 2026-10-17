import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChromeTitleBar } from './ChromeTitleBar';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useChromeStore, SIDEBAR_DEFAULT } from './chromeStore';
import type { PluginManifest, PluginSource } from '../../shared/plugin-types';

const originalPlatform = window.clubhouse.platform;

function setPlatform(platform: string) {
  (window.clubhouse as { platform: string }).platform = platform;
}

function registerTabPlugin(id: string, label: string) {
  usePluginStore.getState().registerPlugin(
    { id, version: '0.1.0', apiVersion: 0.8, name: label, scope: 'project', contributes: { tab: { label } } } as unknown as PluginManifest,
    'builtin' as PluginSource,
    `/plugins/${id}`,
  );
  usePluginStore.setState((s) => ({
    plugins: { ...s.plugins, [id]: { ...s.plugins[id], status: 'activated' } },
  }));
}

beforeEach(() => {
  localStorage.clear();
  useUIStore.setState({ explorerTab: 'agents' });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Clubhouse', path: '/tmp/ch' }] as never, activeProjectId: 'p1' });
  usePluginStore.setState({ plugins: {}, pluginTitles: {}, projectEnabled: {}, appEnabled: [] });
  useChromeStore.setState({ sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false });
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('ChromeTitleBar', () => {
  it('keeps the legacy test ids for the root and tabs', () => {
    registerTabPlugin('files', 'Files');
    usePluginStore.setState({ projectEnabled: { p1: ['files'] } });
    render(<ChromeTitleBar />);
    expect(screen.getByTestId('chrome-title-bar')).toBeTruthy();
    expect(screen.getByTestId('explorer-tab-agents').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('explorer-tab-plugin:files').textContent).toContain('Files');
  });

  it('selects a tab for the active project', () => {
    registerTabPlugin('files', 'Files');
    usePluginStore.setState({ projectEnabled: { p1: ['files'] } });
    render(<ChromeTitleBar />);
    fireEvent.click(screen.getByTestId('explorer-tab-plugin:files'));
    expect(useUIStore.getState().explorerTab).toBe('plugin:files');
    expect(useUIStore.getState().projectExplorerTab.p1).toBe('plugin:files');
  });

  it('hides project tabs in Settings and shows a Settings breadcrumb', () => {
    useUIStore.setState({ explorerTab: 'settings' });
    render(<ChromeTitleBar />);
    expect(screen.queryByTestId('explorer-tab-agents')).toBeNull();
    expect(screen.getByTestId('title-bar').textContent).toBe('Settings');
  });

  it('shows the project name in the breadcrumb', () => {
    render(<ChromeTitleBar />);
    expect(screen.getByTestId('title-bar').textContent).toContain('Clubhouse');
  });

  it('names the tab in the title text, and only the title text carries title-bar', () => {
    registerTabPlugin('terminal', 'Terminal');
    usePluginStore.setState({ projectEnabled: { p1: ['terminal'] } });
    useUIStore.setState({ explorerTab: 'plugin:terminal' });
    render(<ChromeTitleBar />);
    expect(screen.getByTestId('title-bar').textContent).toBe('Clubhouse/Terminal');
    useUIStore.setState({ explorerTab: 'agents' });
  });

  it('prefers a plugin window title set with window.setTitle()', () => {
    registerTabPlugin('files', 'Files');
    usePluginStore.setState({ projectEnabled: { p1: ['files'] }, pluginTitles: { files: 'README.md' } });
    useUIStore.setState({ explorerTab: 'plugin:files' });
    render(<ChromeTitleBar />);
    expect(screen.getByTestId('title-bar').textContent).toContain('README.md');
  });

  it('toggles the sidebar', () => {
    render(<ChromeTitleBar />);
    fireEvent.click(screen.getByTestId('chrome-sidebar-toggle'));
    expect(useChromeStore.getState().sidebarCollapsed).toBe(true);
  });

  it('leaves room for the traffic lights on macOS', () => {
    setPlatform('darwin');
    render(<ChromeTitleBar />);
    const root = screen.getByTestId('chrome-title-bar');
    expect(root.className).toContain('pl-[78px]');
    expect(root.className).not.toContain('win-overlay-padding');
  });

  it('reserves the overlay controls on Windows', () => {
    setPlatform('win32');
    render(<ChromeTitleBar />);
    const root = screen.getByTestId('chrome-title-bar');
    expect(root.className).toContain('win-overlay-padding');
    expect(root.className).not.toContain('pl-[78px]');
  });
});
