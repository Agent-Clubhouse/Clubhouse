import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

vi.mock('../panels/AccessoryPanel', async (orig) => ({
  ...(await orig<typeof import('../panels/AccessoryPanel')>()),
  AccessoryPanel: () => <div data-testid="accessory-panel" />,
}));

vi.mock('./sidebar/ChromeAgentDialogs', async () => {
  const { create } = await import('zustand');
  const store = create<{ request: unknown; openNewAgent: (id: string) => void; openGallery: (id: string) => void; close: () => void }>((set) => ({
    request: null,
    openNewAgent: (projectId) => set({ request: { kind: 'durable', projectId } }),
    openGallery: (projectId) => set({ request: { kind: 'gallery', projectId } }),
    close: () => set({ request: null }),
  }));
  return { ChromeAgentDialogs: () => null, useChromeDialogStore: store };
});

import { ChromeSidebar } from './ChromeSidebar';
import { useChromeDialogStore } from './sidebar/ChromeAgentDialogs';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useChromeStore, SIDEBAR_DEFAULT } from './chromeStore';
import type { PluginManifest, PluginSource } from '../../shared/plugin-types';
import type { Agent } from '../../shared/types';

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
  { id: 'p3', name: 'Site', path: '/tmp/site' },
];

const agent = (id: string, projectId: string, over: Partial<Agent> = {}): Agent =>
  ({ id, projectId, name: id, kind: 'durable', status: 'running', color: 'blue', ...over }) as Agent;

beforeEach(() => {
  localStorage.clear();
  useUIStore.setState({ explorerTab: 'agents', projectExplorerTab: {} });
  useProjectStore.setState({ projects: projects as never, activeProjectId: 'p1', projectIcons: {} });
  useAgentStore.setState({
    agents: {
      a1: agent('a1', 'p1'),
      a2: agent('a2', 'p1', { status: 'sleeping' }),
      a3: agent('a3', 'p1', { status: 'sleeping' }),
      b1: agent('b1', 'p2'),
    },
    agentDetailedStatus: { b1: { state: 'needs_permission', message: 'Wants to run: npm test', timestamp: 1 } },
    activeAgentId: 'a1',
    projectActiveAgent: {},
  });
  useQuickAgentStore.setState({
    completedAgents: {
      p1: [
        { id: 'q1', projectId: 'p1', name: 'fix-flaky', mission: 'fix it', summary: 'Deflaked a test', filesModified: [], exitCode: 0, completedAt: 1 },
        { id: 'q2', projectId: 'p1', name: 'triage', mission: 'triage', summary: null, filesModified: [], exitCode: 0, completedAt: 2 },
      ],
    },
    selectedCompletedId: null,
  });
  usePluginStore.setState({ plugins: {}, appEnabled: [] });
  useChromeStore.setState({ sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false, pinnedProjectIds: [], collapsedProjectIds: [], expandedFolds: [] });
  useChromeDialogStore.setState({ request: null });
});

describe('ChromeSidebar', () => {
  it('renders the tree with legacy test ids and 30px agent rows for awake agents', () => {
    render(<ChromeSidebar />);
    expect(screen.getByTestId('agent-list')).toBeTruthy();
    expect(screen.getByTestId('project-p1').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('agent-item-a1').getAttribute('data-active')).toBe('true');
    // Sleeping agents are folded away until the fold is opened.
    expect(screen.queryByTestId('agent-item-a2')).toBeNull();
    expect(screen.getByTestId('sleeping-fold-p1').textContent).toContain('2 sleeping');
  });

  it('opens the sleeping fold', () => {
    render(<ChromeSidebar />);
    fireEvent.click(screen.getByTestId('sleeping-fold-p1'));
    expect(screen.getByTestId('agent-item-a2')).toBeTruthy();
    expect(useChromeStore.getState().expandedFolds).toEqual(['p1:sleeping']);
  });

  it('selects an agent in another project and switches to its Agents tab', () => {
    useUIStore.setState({ explorerTab: 'plugin:files' });
    render(<ChromeSidebar />);
    fireEvent.click(screen.getByTestId('agent-item-b1'));
    expect(useProjectStore.getState().activeProjectId).toBe('p2');
    expect(useAgentStore.getState().activeAgentId).toBe('b1');
    expect(useUIStore.getState().explorerTab).toBe('agents');
    expect(useUIStore.getState().projectExplorerTab.p2).toBe('agents');
  });

  it('collapses one project, then all, then expands all', () => {
    render(<ChromeSidebar />);
    fireEvent.click(screen.getByLabelText('Collapse Clubhouse'));
    expect(screen.queryByTestId('agent-item-a1')).toBeNull();
    fireEvent.click(screen.getByTestId('project-collapse-all'));
    expect(new Set(useChromeStore.getState().collapsedProjectIds)).toEqual(new Set(['p1', 'p2', 'p3']));
    fireEvent.click(screen.getByTestId('project-collapse-all'));
    expect(useChromeStore.getState().collapsedProjectIds).toEqual([]);
  });

  it('puts pinned projects first', () => {
    useChromeStore.setState({ pinnedProjectIds: ['p3'] });
    render(<ChromeSidebar />);
    const tree = screen.getByTestId('project-tree');
    const order = within(tree).getAllByTestId(/^project-group-/).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['project-group-p3', 'project-group-p1', 'project-group-p2']);
  });

  it('lists agents waiting on the user in Needs you', () => {
    render(<ChromeSidebar />);
    const row = screen.getByTestId('needs-you-row-b1');
    expect(row.textContent).toContain('Wants to run: npm test');
    expect(row.textContent).toContain('Goobers');
    fireEvent.click(row);
    expect(useAgentStore.getState().activeAgentId).toBe('b1');
  });

  it('hides Needs you when nothing is waiting', () => {
    useAgentStore.setState({ agentDetailedStatus: {} });
    render(<ChromeSidebar />);
    expect(screen.queryByTestId('needs-you')).toBeNull();
  });

  it('folds finished quick agents, with Dismiss and Clear all', () => {
    render(<ChromeSidebar />);
    fireEvent.click(screen.getByTestId('finished-quick-p1'));
    expect(screen.getByTestId('finished-quick-row-q1')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Dismiss fix-flaky'));
    expect(useQuickAgentStore.getState().completedAgents.p1.map((c) => c.id)).toEqual(['q2']);
    fireEvent.click(screen.getByText('Clear all'));
    expect(useQuickAgentStore.getState().completedAgents.p1 ?? []).toEqual([]);
  });

  it('shows Canvas and Review inline and other app items in the overflow menu', () => {
    registerAppPlugin('canvas', 'Canvas');
    registerAppPlugin('review', 'Review');
    registerAppPlugin('goobers', 'Goobers');
    usePluginStore.setState({ appEnabled: ['canvas', 'review', 'goobers'] });
    render(<ChromeSidebar />);
    fireEvent.click(screen.getByTitle('Canvas'));
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:canvas');
    expect(screen.queryByText('Goobers', { selector: '[role=menuitem]' })).toBeNull();
    fireEvent.click(screen.getByLabelText('More app views'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Goobers/ }));
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:goobers');
  });

  it('opens the new-agent dialog from a project header', () => {
    render(<ChromeSidebar />);
    const header = screen.getByTestId('project-p2').parentElement!;
    fireEvent.mouseEnter(header);
    fireEvent.click(screen.getByLabelText('New agent in Goobers'));
    expect(useChromeDialogStore.getState().request).toEqual({ kind: 'durable', projectId: 'p2' });
  });

  it('keeps the footer test ids', () => {
    render(<ChromeSidebar />);
    fireEvent.click(screen.getByTestId('nav-settings'));
    expect(useUIStore.getState().explorerTab).toBe('settings');
    fireEvent.click(screen.getByTestId('nav-help'));
    expect(useUIStore.getState().explorerTab).toBe('help');
    expect(screen.getByTestId('nav-add-project')).toBeTruthy();
  });

  it('marks rows with data-agent-id for E2E', () => {
    render(<ChromeSidebar />);
    expect(screen.getByTestId('agent-item-a1').getAttribute('data-agent-id')).toBe('a1');
    expect(screen.getByTestId('needs-you-row-b1').getAttribute('data-agent-id')).toBe('b1');
  });

  it('gives the Canvas and Review buttons the app-row test ids', () => {
    registerAppPlugin('canvas', 'Canvas');
    registerAppPlugin('review', 'Review');
    usePluginStore.setState({ appEnabled: ['canvas', 'review'] });
    render(<ChromeSidebar />);
    expect(screen.getByTestId('app-row-canvas')).toBeTruthy();
    expect(screen.getByTestId('app-row-review')).toBeTruthy();
  });

  describe('drag to reorder', () => {
    const dataTransfer = { setData: () => {}, effectAllowed: '', dropEffect: '' };
    const drag = (fromId: string, toId: string) => {
      const from = screen.getByTestId(`project-${fromId}`).parentElement!;
      const to = screen.getByTestId(`project-group-${toId}`);
      fireEvent.dragStart(from, { dataTransfer });
      fireEvent.dragOver(to, { dataTransfer });
      fireEvent.drop(to, { dataTransfer });
    };

    it('reorders in display order, so a drop lands where it is shown', () => {
      const reorder = vi.fn(async () => {});
      useProjectStore.setState({ reorderProjects: reorder } as never);
      useChromeStore.setState({ pinnedProjectIds: ['p3'] });
      render(<ChromeSidebar />);
      // Shown: p3 (pinned) | p1, p2. Dropping p2 on p1 puts it first among the rest.
      drag('p2', 'p1');
      expect(reorder).toHaveBeenCalledWith(['p3', 'p2', 'p1']);
    });

    it('ignores drops across the pinned and unpinned sections', () => {
      const reorder = vi.fn(async () => {});
      useProjectStore.setState({ reorderProjects: reorder } as never);
      useChromeStore.setState({ pinnedProjectIds: ['p3'] });
      render(<ChromeSidebar />);
      drag('p1', 'p3');
      expect(reorder).not.toHaveBeenCalled();
    });
  });

  it('forgets pins, collapsed state and folds for a removed project', () => {
    useChromeStore.setState({ pinnedProjectIds: ['p3'], collapsedProjectIds: ['p3'], expandedFolds: ['p3:sleeping'] });
    render(<ChromeSidebar />);
    act(() => { useProjectStore.setState({ projects: projects.slice(0, 2) as never }); });
    expect(useChromeStore.getState()).toMatchObject({ pinnedProjectIds: [], collapsedProjectIds: [], expandedFolds: [] });
  });

  describe('scope and sidebar modes', () => {
    function registerTab(id: string, label: string, layout?: 'full' | 'sidebar-content') {
      usePluginStore.getState().registerPlugin(
        { id, version: '0.1.0', apiVersion: 0.8, name: label, scope: 'project', contributes: { tab: { label, ...(layout ? { layout } : {}) } } } as unknown as PluginManifest,
        'builtin' as PluginSource,
        `/plugins/${id}`,
      );
    }

    it('selecting a project header makes the project root the scope; selecting an agent clears it', () => {
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('project-p1'));
      expect(useChromeStore.getState().projectScopeId).toBe('p1');
      expect(screen.getByTestId('project-p1').getAttribute('aria-current')).toBe('true');
      expect(screen.getByTestId('agent-item-a1').getAttribute('aria-current')).toBeNull();
      fireEvent.click(screen.getByTestId('agent-item-a1'));
      expect(useChromeStore.getState().projectScopeId).toBeNull();
    });

    it('keeps a scope-following tab (Terminal) when an agent is selected', () => {
      useUIStore.setState({ explorerTab: 'plugin:terminal' });
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('sleeping-fold-p1'));
      fireEvent.click(screen.getByTestId('agent-item-a2'));
      expect(useUIStore.getState().explorerTab).toBe('plugin:terminal');
      expect(useAgentStore.getState().activeAgentId).toBe('a2');
    });

    it('swaps the tree for a tab list, with the breadcrumb and the Needs you strip', () => {
      registerTab('files', 'Files');
      useUIStore.setState({ explorerTab: 'plugin:files' });
      render(<ChromeSidebar />);
      expect(screen.getByTestId('sidebar-list')).toBeTruthy();
      expect(screen.getByTestId('accessory-panel')).toBeTruthy();
      expect(screen.getByTestId('list-breadcrumb').textContent).toContain('Files');
      expect(screen.getByTestId('needs-you-strip').textContent).toContain('1 needs you');
      expect(screen.queryByTestId('needs-you')).toBeNull();
      fireEvent.click(screen.getByText('Agents'));
      expect(useUIStore.getState().explorerTab).toBe('agents');
    });

    it('keeps the tree for full-layout tabs', () => {
      registerTab('canvas', 'Canvas', 'full');
      useUIStore.setState({ explorerTab: 'plugin:canvas' });
      render(<ChromeSidebar />);
      expect(screen.queryByTestId('sidebar-list')).toBeNull();
      expect(screen.getByTestId('needs-you')).toBeTruthy();
    });

    it('shows the settings navigator in Settings', () => {
      useUIStore.setState({ explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'about' });
      render(<ChromeSidebar />);
      expect(screen.getByTestId('settings-nav')).toBeTruthy();
      expect(screen.getByTestId('list-breadcrumb').textContent).toContain('Settings');
    });
  });
});
