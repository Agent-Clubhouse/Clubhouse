import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { feedbackStatus, setFeedback } from '../features/feedback/feedback-test-utils';
import { useChromeDialogStore } from './sidebar/ChromeAgentDialogs';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useAnnexClientStore } from '../stores/annexClientStore';
import { useRemoteProjectStore, namespacedAgentId, namespacedProjectId } from '../stores/remoteProjectStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useChromeStore, SIDEBAR_DEFAULT, syncProjectScopeWithActiveAgent } from './chromeStore';
import { useAgentSettingsPages } from '../features/agents/agentSettingsPages';
import type { PluginManifest, PluginSource } from '../../shared/plugin-types';
import type { Agent } from '../../shared/types';
import { useCommandPaletteStore } from '../stores/commandPaletteStore';
import { useKeyboardShortcutsStore } from '../stores/keyboardShortcutsStore';
import { useChromeFlagStore } from './chromeFlag';

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
  useUIStore.setState({ activeHostId: null });
  useAnnexClientStore.setState({ satellites: [] });
  useRemoteProjectStore.setState({ satelliteProjects: {}, remoteAgents: {}, remoteAgentDetailedStatus: {}, remoteProjectIcons: {} });
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
    fireEvent.click(screen.getByTestId('app-row-canvas'));
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:canvas');
    expect(screen.queryByText('Goobers', { selector: '[role=menuitem]' })).toBeNull();
    fireEvent.click(screen.getByLabelText('More app views'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Goobers/ }));
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:goobers');
  });

  describe('New agent page', () => {
    beforeEach(() => { useChromeFlagStore.setState({ enabled: true }); useChromeStore.setState({ newAgent: null }); });
    afterEach(() => useChromeFlagStore.setState({ enabled: false }));

    it("opens from a project header's + with that project", () => {
      render(<ChromeSidebar />);
      const header = screen.getByTestId('project-p2').parentElement!;
      fireEvent.mouseEnter(header);
      fireEvent.click(screen.getByLabelText('New agent in Goobers'));
      expect(useChromeStore.getState().newAgent).toMatchObject({ kind: 'durable', projectId: 'p2' });
      expect(useChromeDialogStore.getState().request).toBeNull();
    });

    it('opens from each New menu item with that kind chosen', () => {
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('chrome-new'));
      fireEvent.click(screen.getByRole('menuitem', { name: /Quick agent/ }));
      expect(useChromeStore.getState().newAgent).toMatchObject({ kind: 'quick' });
      expect(useUIStore.getState().quickAgentDialogOpen).toBe(false);
      fireEvent.click(screen.getByTestId('chrome-new'));
      fireEvent.click(screen.getByRole('menuitem', { name: /Durable agent/ }));
      expect(useChromeStore.getState().newAgent).toMatchObject({ kind: 'durable' });
    });

    it("shows the New agent shortcut the platform's way", () => {
      const platform = window.clubhouse.platform;
      useKeyboardShortcutsStore.setState({ shortcuts: { 'new-quick-agent': { id: 'new-quick-agent', label: 'New Agent', category: 'Agents', defaultBinding: 'Meta+Shift+N', currentBinding: 'Meta+Shift+N' } } as never });
      try {
        (window.clubhouse as { platform: string }).platform = 'darwin';
        render(<ChromeSidebar />);
        fireEvent.click(screen.getByTestId('chrome-new'));
        expect(screen.getByRole('menuitem', { name: /Durable agent/ }).textContent).toBe('Durable agent…⇧⌘N');
      } finally {
        (window.clubhouse as { platform: string }).platform = platform;
      }
    });

    it('closes when an agent is opened from the tree', () => {
      useChromeStore.getState().openNewAgent('durable');
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('agent-item-a1'));
      expect(useChromeStore.getState().newAgent).toBeNull();
    });
  });

  it('puts the app-wide notices slot above the footer', () => {
    render(<ChromeSidebar />);
    const slot = screen.getByTestId('sidebar-notices');
    expect(slot.nextElementSibling).toContainElement(screen.getByTestId('nav-settings'));
  });

  it('labels footer icon buttons with a Tooltip instead of title=', () => {
    render(<ChromeSidebar />);
    const settings = screen.getByTestId('nav-settings');
    expect(settings).not.toHaveAttribute('title');
    fireEvent.keyDown(document, { key: 'Tab' });
    act(() => { settings.focus(); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Settings');
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

  it('opens Review from Needs you with Needs you only for that visit, and plainly from the app row', () => {
    registerAppPlugin('review', 'Review');
    usePluginStore.setState({ appEnabled: ['review'] });
    render(<ChromeSidebar />);
    fireEvent.click(within(screen.getByTestId('needs-you')).getByText('Review'));
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:review');
    expect(useChromeStore.getState().appLaunch).toMatchObject({ id: 'review', params: { needsYouOnly: true } });
    fireEvent.click(screen.getByTestId('app-row-review'));
    expect(useChromeStore.getState().appLaunch).toMatchObject({ id: 'review', params: {} });
  });

  it('selects the agent Review is showing while Review is open', () => {
    registerAppPlugin('review', 'Review');
    usePluginStore.setState({ appEnabled: ['review'] });
    useUIStore.setState({ explorerTab: 'plugin:app:review' });
    act(() => useChromeStore.getState().setAppViewAgent('a1'));
    render(<ChromeSidebar />);
    expect(screen.getByTestId('agent-item-a1').getAttribute('data-active')).toBe('true');
    act(() => useChromeStore.getState().setAppViewAgent(null));
  });

  describe('filter and palette button', () => {
    afterEach(() => { useCommandPaletteStore.setState({ isOpen: false, query: '', mode: 'all' }); });

    it('narrows the tree in place, sleeping matches included, with the match marked', () => {
      render(<ChromeSidebar />);
      fireEvent.change(screen.getByTestId('chrome-filter'), { target: { value: 'a' } });
      const results = screen.getByTestId('filter-results');
      expect(within(results).getByTestId('agent-item-a1')).toBeTruthy();
      expect(within(results).getByTestId('agent-item-a2')).toBeTruthy();
      expect(within(results).queryByTestId('agent-item-b1')).toBeNull();
      expect(screen.queryByTestId('project-tree')?.closest('.hidden')).toBeTruthy();
      expect(within(results).getByTestId('agent-item-a3').querySelector('mark')?.textContent).toBe('a');
      expect(results.textContent).toContain('3 matches');
    });

    it('clears on Esc', () => {
      render(<ChromeSidebar />);
      const field = screen.getByTestId('chrome-filter') as HTMLInputElement;
      fireEvent.change(field, { target: { value: 'b1' } });
      fireEvent.keyDown(field, { key: 'Escape' });
      expect(field.value).toBe('');
      expect(screen.queryByTestId('filter-results')).toBeNull();
    });

    it('opens the first match on Enter', () => {
      render(<ChromeSidebar />);
      const field = screen.getByTestId('chrome-filter');
      fireEvent.change(field, { target: { value: 'b1' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(useAgentStore.getState().activeAgentId).toBe('b1');
    });

    it('hands the query to the palette when nothing matches', () => {
      render(<ChromeSidebar />);
      fireEvent.change(screen.getByTestId('chrome-filter'), { target: { value: 'deploy' } });
      expect(screen.getByTestId('filter-results').textContent).toContain('No matches');
      fireEvent.click(screen.getByTestId('filter-search-everything'));
      expect(useCommandPaletteStore.getState()).toMatchObject({ isOpen: true, query: 'deploy' });
    });

    it('shows the ⌘ glyph on macOS and a Ctrl K keycap elsewhere', () => {
      const platform = window.clubhouse.platform;
      useKeyboardShortcutsStore.setState({ shortcuts: { 'command-palette': { id: 'command-palette', label: 'Command Palette', category: 'General', defaultBinding: 'Meta+K', currentBinding: 'Meta+K' } } as never });
      try {
        (window.clubhouse as { platform: string }).platform = 'darwin';
        const { unmount } = render(<ChromeSidebar />);
        expect(screen.getByTestId('chrome-palette-button').textContent).toBe('');
        unmount();
        (window.clubhouse as { platform: string }).platform = 'win32';
        render(<ChromeSidebar />);
        expect(screen.getByTestId('chrome-palette-button').textContent).toBe('Ctrl K');
        fireEvent.click(screen.getByTestId('chrome-palette-button'));
        expect(useCommandPaletteStore.getState().isOpen).toBe(true);
        expect(screen.getByTestId('chrome-palette-button').getAttribute('aria-pressed')).toBe('true');
      } finally {
        (window.clubhouse as { platform: string }).platform = platform;
      }
    });
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

    it('drags an agent in the tree and persists the order through reorderAgents (#2115)', async () => {
      const reorderDurable = vi.fn(async () => {});
      (window.clubhouse.agent as unknown as { reorderDurable: typeof reorderDurable }).reorderDurable = reorderDurable;
      useChromeStore.setState({ expandedFolds: ['p1:sleeping'] });
      render(<ChromeSidebar />);
      // Saved order a1, a2, a3; a2 and a3 sleep. Drop a3 on a2: it goes first among the sleeping.
      fireEvent.dragStart(screen.getByTestId('agent-item-a3'), { dataTransfer });
      fireEvent.dragOver(screen.getByTestId('agent-item-a2'), { dataTransfer });
      fireEvent.drop(screen.getByTestId('agent-item-a2'), { dataTransfer });
      expect(reorderDurable).toHaveBeenCalledWith('/tmp/ch', ['a1', 'a3', 'a2']);
      await act(async () => {});
      expect(Object.keys(useAgentStore.getState().agents).filter((id) => id.startsWith('a'))).toEqual(['a1', 'a3', 'a2']);
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

  it('orders the tree and the filter results most recent first in Recent mode (#2116)', () => {
    const now = Date.now();
    useChromeStore.setState({
      projectSort: 'recent', agentSort: 'recent',
      projectActivity: { p1: now - 3_000, p2: now - 1_000, p3: now - 2_000 },
      agentActivity: { a1: 1, a3: 5 },
      expandedFolds: ['p1:sleeping'],
    });
    try {
      render(<ChromeSidebar />);
      const projectOrder = () => [...document.querySelectorAll<HTMLElement>('[data-testid^="project-group-"]')].map((el) => el.dataset.testid!.slice(14));
      expect(projectOrder()).toEqual(['p2', 'p3', 'p1']);
      // Sleeping a2, a3: a3 woke last.
      const sleeping = [...document.querySelectorAll<HTMLElement>('[data-agent-id]')].map((el) => el.dataset.agentId).filter((id) => id === 'a2' || id === 'a3');
      expect(sleeping).toEqual(['a3', 'a2']);

      // The filter results use the same order.
      fireEvent.change(screen.getByTestId('chrome-filter'), { target: { value: 'a' } });
      const results = screen.getByTestId('filter-results');
      const matched = [...results.querySelectorAll<HTMLElement>('[data-agent-id]')].map((el) => el.dataset.agentId);
      expect(matched.indexOf('a3')).toBeLessThan(matched.indexOf('a2'));
    } finally {
      useChromeStore.setState({ projectSort: 'manual', agentSort: 'manual', projectActivity: {}, agentActivity: {} });
    }
  });

  it('forgets pins, collapsed state and folds for a removed project', () => {
    useChromeStore.setState({ pinnedProjectIds: ['p3'], collapsedProjectIds: ['p3'], expandedFolds: ['p3:sleeping'] });
    render(<ChromeSidebar />);
    act(() => { useProjectStore.setState({ projects: projects.slice(0, 2) as never }); });
    expect(useChromeStore.getState()).toMatchObject({ pinnedProjectIds: [], collapsedProjectIds: [], expandedFolds: [] });
  });

  describe('scope and sidebar modes', () => {
    // ChromeBody starts this in the app.
    let stopSync: () => void;
    beforeEach(() => { stopSync = syncProjectScopeWithActiveAgent(); });
    afterEach(() => stopSync());

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

    it('keeps the project scope through the project-switch restore of a remembered agent', () => {
      useAgentStore.setState({ projectActiveAgent: { p2: 'b1' } });
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('project-p2'));
      // App.tsx runs restoreProjectAgent after the project changes.
      act(() => useAgentStore.getState().restoreProjectAgent('p2'));
      expect(useAgentStore.getState().activeAgentId).toBeNull();
      expect(useChromeStore.getState().projectScopeId).toBe('p2');
    });

    it('ends the project scope when anything else makes an agent active', () => {
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('project-p1'));
      expect(useChromeStore.getState().projectScopeId).toBe('p1');
      // A notification click, the palette, switch-agent-N or a spawn.
      act(() => useAgentStore.getState().setActiveAgent('a1', 'p1'));
      expect(useChromeStore.getState().projectScopeId).toBeNull();
      expect(screen.getByTestId('project-p1').getAttribute('aria-current')).toBeNull();
    });

    it('opens the agent from a tab that does not follow the scope', () => {
      registerTab('canvas', 'Canvas', 'full');
      useUIStore.setState({ explorerTab: 'plugin:canvas' });
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('agent-item-a1'));
      expect(useUIStore.getState().explorerTab).toBe('agents');
    });

    it('returns to Agents on Esc from a list or Settings', () => {
      registerTab('files', 'Files');
      useUIStore.setState({ explorerTab: 'plugin:files' });
      const { unmount } = render(<ChromeSidebar />);
      fireEvent.keyDown(screen.getByTestId('list-breadcrumb'), { key: 'Escape' });
      expect(useUIStore.getState().explorerTab).toBe('agents');
      unmount();

      useUIStore.setState({ explorerTab: 'settings', previousExplorerTab: 'plugin:git', settingsContext: 'app', settingsSubPage: 'about' });
      render(<ChromeSidebar />);
      fireEvent.keyDown(screen.getByTestId('settings-nav-app-about'), { key: 'Escape' });
      expect(useUIStore.getState().explorerTab).toBe('plugin:git');
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

    it('swaps the tree for the agent settings pages, named in the breadcrumb', () => {
      useAgentStore.setState({ agentSettingsOpenFor: 'a1', activeAgentId: 'a1' });
      render(<ChromeSidebar />);
      expect(screen.getByTestId('agent-settings-nav')).toBeTruthy();
      expect(screen.getByTestId('list-breadcrumb').textContent).toContain('a1');
      expect(screen.queryByTestId('agent-item-a2')).toBeNull();
      fireEvent.click(screen.getByText('Agents'));
      expect(useAgentStore.getState().agentSettingsOpenFor).toBeNull();
      expect(screen.queryByTestId('agent-settings-nav')).toBeNull();
    });

    it('closes agent settings on Esc', () => {
      useAgentStore.setState({ agentSettingsOpenFor: 'a1', activeAgentId: 'a1' });
      render(<ChromeSidebar />);
      fireEvent.keyDown(screen.getByTestId('agent-settings-nav-general'), { key: 'Escape' });
      expect(useAgentStore.getState().agentSettingsOpenFor).toBeNull();
    });

    it('asks before opening another agent while settings edits are unsaved', () => {
      useAgentStore.setState({ agentSettingsOpenFor: 'a1', activeAgentId: 'a1' });
      useAgentSettingsPages.getState().setDirtyPages(['instructions']);
      render(<ChromeSidebar />);
      // The tree is hidden in agent settings; the Needs you strip opens b1.
      fireEvent.click(within(screen.getByTestId('needs-you-strip')).getAllByRole('button')[0]);
      const pending = useAgentSettingsPages.getState().pendingLeave;
      expect(pending).not.toBeNull();
      expect(useAgentStore.getState().activeAgentId).toBe('a1');
      expect(useAgentStore.getState().agentSettingsOpenFor).toBe('a1');

      // What the view's confirm does.
      act(() => {
        useAgentSettingsPages.getState().setPendingLeave(null);
        useAgentStore.getState().closeAgentSettings();
        pending!();
      });
      expect(useAgentStore.getState().activeAgentId).toBe('b1');
      useAgentSettingsPages.getState().reset();
    });

    it('opens another agent at once when nothing is unsaved', () => {
      useAgentStore.setState({ agentSettingsOpenFor: 'a1', activeAgentId: 'a1' });
      useAgentSettingsPages.getState().reset();
      render(<ChromeSidebar />);
      fireEvent.click(within(screen.getByTestId('needs-you-strip')).getAllByRole('button')[0]);
      expect(useAgentSettingsPages.getState().pendingLeave).toBeNull();
      expect(useAgentStore.getState().activeAgentId).toBe('b1');
      expect(useAgentStore.getState().agentSettingsOpenFor).toBeNull();
    });

    it('keeps the tree when settings are open for an agent outside the active project', () => {
      useAgentStore.setState({ agentSettingsOpenFor: 'b1', activeAgentId: 'b1' });
      render(<ChromeSidebar />);
      expect(screen.queryByTestId('agent-settings-nav')).toBeNull();
    });

    it('shows the settings navigator in Settings', () => {
      useUIStore.setState({ explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'about' });
      render(<ChromeSidebar />);
      expect(screen.getByTestId('settings-nav')).toBeTruthy();
      expect(screen.getByTestId('list-breadcrumb').textContent).toContain('Settings');
    });
  });

  describe('hosts', () => {
    const rp = namespacedProjectId('s1', 'site');
    const ra = namespacedAgentId('s1', 'bold-owl');
    beforeEach(() => {
      useAnnexClientStore.setState({
        satellites: [{ id: 's1', alias: 'Studio', state: 'connected', fingerprint: 'fp1', icon: '', color: 'blue', host: 'h', mainPort: 1, pairingPort: 2, snapshot: null, lastError: null }],
      });
      useRemoteProjectStore.setState({
        satelliteProjects: { s1: [{ id: rp, name: 'Site', path: '/srv/site', remote: true, satelliteId: 's1', satelliteName: 'Studio' }] as never },
        remoteAgents: { [ra]: agent(ra, rp) },
        remoteAgentDetailedStatus: { [ra]: { state: 'needs_permission', message: 'Wants to deploy', timestamp: 2 } },
      });
    });

    it('shows the host switcher once a satellite is paired', () => {
      render(<ChromeSidebar />);
      expect(screen.getByTestId('host-switcher').textContent).toContain('Local');
    });

    it('lists blocked agents from every host, tagged with the host', () => {
      render(<ChromeSidebar />);
      const section = screen.getByTestId('needs-you');
      expect(within(section).getByTestId('needs-you-row-b1')).toBeTruthy();
      expect(within(section).getByTestId(`needs-you-row-${ra}`).textContent).toContain('Site on Studio');
    });

    it('a remote Needs you row switches host and opens the agent', () => {
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId(`needs-you-row-${ra}`));
      expect(useUIStore.getState().activeHostId).toBe('s1');
      expect(useProjectStore.getState().activeProjectId).toBe(rp);
      expect(useAgentStore.getState().activeAgentId).toBe(ra);
      expect(useUIStore.getState().explorerTab).toBe('agents');
    });

    it('shows the satellite’s projects, read-only, while it is the host', () => {
      useUIStore.setState({ activeHostId: 's1' });
      useProjectStore.setState({ activeProjectId: null });
      render(<ChromeSidebar />);
      expect(screen.getByTestId(`project-${rp}`)).toBeTruthy();
      expect(screen.queryByTestId('project-p1')).toBeNull();
      expect(screen.getByTestId(`agent-item-${ra}`)).toBeTruthy();
      expect(screen.queryByLabelText('New agent in Site')).toBeNull();
      expect((screen.getByTestId('chrome-new') as HTMLButtonElement).disabled).toBe(true);
    });

    it('switches back to Local from the menu', () => {
      useUIStore.setState({ activeHostId: 's1' });
      useProjectStore.setState({ activeProjectId: rp });
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('host-switcher'));
      fireEvent.click(screen.getByTestId('host-menu-local'));
      expect(useUIStore.getState().activeHostId).toBeNull();
      expect(useProjectStore.getState().activeProjectId).toBeNull();
      expect(screen.getByTestId('project-p1')).toBeTruthy();
    });

    it('forgets an unpaired satellite’s pins, but keeps them while it is only offline', () => {
      useChromeStore.setState({ pinnedProjectIds: ['p1', rp] });
      const { rerender } = render(<ChromeSidebar />);
      act(() => useAnnexClientStore.setState((st) => ({ satellites: st.satellites.map((x) => ({ ...x, state: 'disconnected' as const })) })));
      rerender(<ChromeSidebar />);
      expect(useChromeStore.getState().pinnedProjectIds).toEqual(['p1', rp]);
      act(() => useAnnexClientStore.setState({ satellites: [] }));
      rerender(<ChromeSidebar />);
      expect(useChromeStore.getState().pinnedProjectIds).toEqual(['p1']);
    });

    it('opens Annex settings for pairing', () => {
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('host-switcher'));
      fireEvent.click(screen.getByText('Pair a satellite…'));
      expect(useUIStore.getState()).toMatchObject({ explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'annex-control' });
    });
  });
});

describe('ChromeSidebar feedback button', () => {
  it('shows Feedback in the footer before Help and Settings when it can capture', () => {
    setFeedback(true);
    render(<ChromeSidebar />);
    expect(screen.getByTestId('nav-feedback').nextElementSibling).toBe(screen.getByTestId('nav-help'));
  });

  it('hides it with the switch off or without capture', () => {
    setFeedback(false);
    const { unmount } = render(<ChromeSidebar />);
    expect(screen.queryByTestId('nav-feedback')).toBeNull();
    unmount();
    setFeedback(true, feedbackStatus({ canCapture: false }));
    render(<ChromeSidebar />);
    expect(screen.queryByTestId('nav-feedback')).toBeNull();
  });
});

