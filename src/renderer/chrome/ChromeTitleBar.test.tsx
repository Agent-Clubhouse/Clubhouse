import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

const originalInnerWidth = window.innerWidth;

beforeEach(() => {
  localStorage.clear();
  window.innerWidth = 1400;
  useUIStore.setState({ explorerTab: 'agents' });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Clubhouse', path: '/tmp/ch' }] as never, activeProjectId: 'p1' });
  usePluginStore.setState({ plugins: {}, pluginTitles: {}, projectEnabled: {}, appEnabled: [] });
  useChromeStore.setState({ sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false, tabMru: {} });
});

afterEach(() => {
  setPlatform(originalPlatform);
  window.innerWidth = originalInnerWidth;
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

  it('reserves the overlay controls on Linux, which the new layout gives an overlay', () => {
    setPlatform('linux');
    render(<ChromeTitleBar />);
    expect(screen.getByTestId('chrome-title-bar').className).toContain('win-overlay-padding');
  });

  it('drops the project from the breadcrumb below 1100px', () => {
    render(<ChromeTitleBar />);
    expect(screen.getByTestId('title-bar').textContent).toBe('Clubhouse/Agents');
    act(() => {
      window.innerWidth = 1000;
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByTestId('title-bar').textContent).toBe('Agents');
  });

  describe('More menu', () => {
    beforeEach(() => {
      for (const [id, label] of [['files', 'Files'], ['git', 'Git'], ['terminal', 'Terminal']]) registerTabPlugin(id, label);
      usePluginStore.setState({ projectEnabled: { p1: ['files', 'git', 'terminal'] } });
      // Four 80px tabs in a 250px row with a 60px More button.
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(250);
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.tabId ? 80 : this.dataset.testid === 'title-more' ? 60 : 0;
      });
    });
    afterEach(() => vi.restoreAllMocks());

    it('keeps the active tab in the row and lists the rest by recent use', () => {
      useUIStore.setState({ explorerTab: 'plugin:terminal' });
      useChromeStore.setState({ tabMru: { p1: ['plugin:git', 'plugin:files'] } });
      render(<ChromeTitleBar />);
      expect(screen.getByTestId('explorer-tab-agents')).toBeTruthy();
      expect(screen.getByTestId('explorer-tab-plugin:terminal').getAttribute('data-active')).toBe('true');
      expect(screen.queryByTestId('explorer-tab-plugin:files')).toBeNull();

      fireEvent.click(screen.getByTestId('title-more'));
      const items = screen.getAllByRole('menuitem').map((el) => el.getAttribute('data-testid'));
      // terminal became the most recent on render, then git, then files.
      expect(items).toEqual(['explorer-tab-plugin:git', 'explorer-tab-plugin:files']);

      fireEvent.click(screen.getByTestId('explorer-tab-plugin:files'));
      expect(useUIStore.getState().explorerTab).toBe('plugin:files');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(screen.getByTestId('explorer-tab-plugin:files').getAttribute('data-active')).toBe('true');
    });

    it('records tab opens per project for the menu order', () => {
      useUIStore.setState({ explorerTab: 'plugin:git' });
      render(<ChromeTitleBar />);
      expect(useChromeStore.getState().tabMru.p1[0]).toBe('plugin:git');
    });
  });
});
