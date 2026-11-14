import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';

vi.mock('../panels/AccessoryPanel', async (orig) => ({
  ...(await orig<typeof import('../panels/AccessoryPanel')>()),
  AccessoryPanel: () => <div data-testid="accessory-panel" />,
}));

vi.mock('./sidebar/ChromeAgentDialogs', () => ({ ChromeAgentDialogs: () => null }));

import { ChromeSidebar } from './ChromeSidebar';
import { feedbackStatus, setFeedback } from '../features/feedback/feedback-test-utils';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useAnnexClientStore } from '../stores/annexClientStore';
import { useRemoteProjectStore, namespacedAgentId, namespacedProjectId } from '../stores/remoteProjectStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useChromeStore, SIDEBAR_DEFAULT, syncProjectScopeWithActiveAgent } from './chromeStore';
import { useNetworkSidebarStore, _resetNetworkSidebarForTesting } from './sidebar/networkSidebarStore';
import { useAgentSettingsPages } from '../features/agents/agentSettingsPages';
import type { PluginManifest, PluginSource } from '../../shared/plugin-types';
import type { Agent } from '../../shared/types';
import { useCommandPaletteStore } from '../stores/commandPaletteStore';
import { useKeyboardShortcutsStore } from '../stores/keyboardShortcutsStore';
import { useChromeFlagStore } from './chromeFlag';
import { useHelperStartRequestStore } from '../stores/helperStartRequestStore';
import { useAgentDetailsStore } from '../features/agents/details/detailsStore';
import { useLeadStore, _resetLeadStoreForTesting } from '../features/dispatcher/leadStore';
import { useDispatcherStore } from '../features/dispatcher/dispatcherStore';
import { useRemoteDispatcherSelection } from '../features/dispatcher/remoteDispatcherSelection';
import { useDispatcherDebugStore } from '../features/dispatcher/dispatcherDebug';
import { useGrantRequestStore } from '../stores/grantRequestStore';
import { useDispatcherSync } from '../features/dispatcher/useDispatcherSync';
import { DispatcherView } from '../features/dispatcher/DispatcherView';
import { DISPATCHER_PROJECT_ID, DISPATCHER_OFF, type DispatcherState } from '../../shared/dispatcher-types';
import type { DurableAgentConfig } from '../../shared/types';

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
  useUIStore.setState({ activeHostId: null });
  _resetNetworkSidebarForTesting();
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

  it('lists an orchestrator waiting to start a helper and opens its Helpers card (#2234)', () => {
    useHelperStartRequestStore.getState().add({
      requestId: 'hstart_1', projectPath: '/tmp/ch', orchestratorId: 'a1', orchestratorName: 'a1',
      args: { name: 'impl-api', task: 'Build the API' },
      createdAt: '2026-10-18T10:00:00.000Z', expiresAt: '2026-10-19T10:00:00.000Z',
    });
    useAgentStore.setState({ activeAgentId: 'b1' });
    try {
      render(<ChromeSidebar />);
      const row = screen.getByTestId('needs-you-row-a1');
      expect(row.textContent).toContain('Wants to start the helper impl-api');
      fireEvent.click(row);
      expect(useAgentStore.getState().activeAgentId).toBe('a1');
      expect(useAgentDetailsStore.getState().focus).toMatchObject({ agentId: 'a1', card: 'helpers' });
    } finally {
      useHelperStartRequestStore.setState({ requests: {} });
    }
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

    it('leaves out Agent from a template: New agent offers templates (#2901)', () => {
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('chrome-new'));
      expect(screen.getByRole('menuitem', { name: /Durable agent/ })).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: /Agent from a template/ })).toBeNull();
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

    it('lists every machine\'s projects and agents together, a remote agent with its machine and this machine\'s with none (#3065)', () => {
      render(<ChromeSidebar />);
      expect(screen.getByTestId('project-p1')).toBeTruthy();
      expect(screen.getByTestId(`project-${rp}`)).toBeTruthy();
      expect(within(screen.getByTestId(`agent-item-${ra}`)).getByTestId('agent-row-machine').textContent).toBe('Studio');
      expect(within(screen.getByTestId('agent-item-a1')).queryByTestId('agent-row-machine')).toBeNull();
      expect(screen.queryByTestId('host-switcher')).toBeNull();
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

    it('leaves out what changes a project here for another machine\'s projects, and keeps New for this one\'s', () => {
      render(<ChromeSidebar />);
      expect(within(screen.getByTestId(`project-group-${rp}`)).queryByLabelText('New agent in Site')).toBeNull();
      expect(within(screen.getByTestId('project-group-p3')).getByLabelText('New agent in Site')).toBeTruthy();
      expect((screen.getByTestId('chrome-new') as HTMLButtonElement).disabled).toBe(false);
      fireEvent.contextMenu(screen.getByTestId(`project-${rp}`));
      expect(screen.queryByTestId('project-menu-settings')).toBeNull();
    });

    it('narrows to one computer with Show, and back to all', () => {
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('show-menu'));
      fireEvent.click(screen.getByTestId('show-s1'));
      expect(screen.queryByTestId('project-p1')).toBeNull();
      expect(screen.getByTestId(`project-${rp}`)).toBeTruthy();
      expect(screen.getByTestId('show-menu').textContent).toContain('Studio');
      fireEvent.click(screen.getByTestId('show-menu'));
      fireEvent.click(screen.getByTestId('show-local'));
      expect(screen.getByTestId('project-p1')).toBeTruthy();
      expect(screen.queryByTestId(`project-${rp}`)).toBeNull();
      fireEvent.click(screen.getByTestId('show-menu'));
      fireEvent.click(screen.getByTestId('show-all'));
      expect(screen.getByTestId('project-p1')).toBeTruthy();
      expect(screen.getByTestId(`project-${rp}`)).toBeTruthy();
    });

    it('merges a project with another machine\'s into one group, and splits it again; only the sidebar changes', () => {
      render(<ChromeSidebar />);
      fireEvent.contextMenu(screen.getByTestId('project-p3'));
      fireEvent.click(screen.getByText('Merge with…'));
      fireEvent.click(within(screen.getByTestId('project-merge-menu')).getByText('Site on Studio'));
      // One group, under this machine's project, with both machines' agents.
      expect(screen.queryByTestId(`project-${rp}`)).toBeNull();
      expect(within(screen.getByTestId('project-group-p3')).getByTestId(`agent-item-${ra}`)).toBeTruthy();
      expect(useNetworkSidebarStore.getState().links).toEqual([['p3', rp]]);
      expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
      fireEvent.contextMenu(screen.getByTestId('project-p3'));
      fireEvent.click(screen.getByText('Split per machine'));
      expect(screen.getByTestId(`project-${rp}`)).toBeTruthy();
      expect(useNetworkSidebarStore.getState().links).toEqual([]);
    });

    it('keeps an offline machine\'s agents listed, dimmed, saying offline instead of a time', () => {
      useAnnexClientStore.setState((st) => ({ satellites: st.satellites.map((x) => ({ ...x, state: 'disconnected' as const })) }));
      render(<ChromeSidebar />);
      const row = screen.getByTestId(`agent-item-${ra}`);
      expect(row.getAttribute('data-offline')).toBe('true');
      expect(within(row).getByTestId('agent-row-offline').textContent).toBe('offline');
      expect(screen.getByTestId('agent-item-a1').getAttribute('data-offline')).toBeNull();
    });

    it('selecting another machine\'s project shows that machine, and this machine\'s brings it back', () => {
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId(`project-${rp}`));
      expect(useUIStore.getState().activeHostId).toBe('s1');
      fireEvent.click(screen.getByTestId('project-p2'));
      expect(useUIStore.getState().activeHostId).toBeNull();
      expect(useProjectStore.getState().activeProjectId).toBe('p2');
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

    it('the + on this computer\'s project, with another computer\'s agent selected, comes back and selects that project first', () => {
      useChromeFlagStore.setState({ enabled: true });
      useUIStore.setState({ activeHostId: 's1' });
      useProjectStore.setState({ activeProjectId: rp });
      render(<ChromeSidebar />);
      fireEvent.click(within(screen.getByTestId('project-group-p2')).getByLabelText('New agent in Goobers'));
      expect(useUIStore.getState().activeHostId).toBeNull();
      expect(useProjectStore.getState().activeProjectId).toBe('p2');
      expect(useChromeStore.getState().newAgent).toMatchObject({ projectId: 'p2' });
      act(() => useChromeStore.getState().closeNewAgent());
    });

    it('an app view is this computer\'s: opening one comes back from another computer', () => {
      registerAppPlugin('canvas', 'Canvas');
      usePluginStore.setState({ appEnabled: ['canvas'] });
      useUIStore.setState({ activeHostId: 's1' });
      useProjectStore.setState({ activeProjectId: rp });
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByText('Canvas'));
      expect(useUIStore.getState().activeHostId).toBeNull();
    });

    it('keeps a saved Show choice through startup, before the paired list arrives', () => {
      useNetworkSidebarStore.getState().setShow('s1');
      useAnnexClientStore.setState({ satellites: [] });
      const { rerender } = render(<ChromeSidebar />);
      // Nothing paired yet: everything shows, and the choice is kept.
      expect(screen.getByTestId('project-p1')).toBeTruthy();
      expect(useNetworkSidebarStore.getState().show).toBe('s1');
      act(() => useAnnexClientStore.setState({ satellites: [{ id: 's1', alias: 'Studio', state: 'connected', fingerprint: 'fp1', icon: '', color: 'blue', host: 'h', mainPort: 1, pairingPort: 2, snapshot: null, lastError: null }] }));
      rerender(<ChromeSidebar />);
      expect(screen.queryByTestId('project-p1')).toBeNull();
      expect(screen.getByTestId(`project-${rp}`)).toBeTruthy();
    });

    it('opens Annex Network settings from Show', () => {
      render(<ChromeSidebar />);
      fireEvent.click(screen.getByTestId('show-menu'));
      fireEvent.click(screen.getByText('Annex Network settings'));
      expect(useUIStore.getState()).toMatchObject({ explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'annex' });
    });
  });
});

describe('ChromeSidebar Dispatcher (#2538)', () => {
  const dispatcher = agent('disp', DISPATCHER_PROJECT_ID, { name: 'Dispatcher', status: 'sleeping' });
  const turnOn = () => {
    useDispatcherStore.getState().setState({ enabled: true, flagOn: true, agentId: 'disp-work', path: 'dispatcher-work-dir', chatAgentId: 'disp', chatPath: 'dispatcher-dir', config: null });
    useAgentStore.setState((s) => ({ agents: { ...s.agents, disp: dispatcher } }));
  };
  beforeEach(() => { useUIStore.setState({ dispatcherOpen: false }); useRemoteDispatcherSelection.getState().select(null); });
  afterEach(() => { useDispatcherStore.getState().setState(DISPATCHER_OFF); _resetLeadStoreForTesting(); });

  it('has no row while the Dispatcher is off', () => {
    useAgentStore.setState((s) => ({ agents: { ...s.agents, disp: dispatcher } }));
    render(<ChromeSidebar />);
    expect(screen.queryByTestId('dispatcher-row')).toBeNull();
  });

  it('shows the row with no projects, and opens its view', () => {
    useProjectStore.setState({ projects: [], activeProjectId: null });
    useAgentStore.setState({ agents: {}, agentDetailedStatus: {}, activeAgentId: null });
    turnOn();
    render(<ChromeSidebar />);
    const row = within(screen.getByTestId('dispatcher-row')).getByTestId('agent-item-disp');
    expect(row.textContent).toContain('Dispatcher');
    expect(row.getAttribute('data-active')).toBe('false');
    fireEvent.click(row);
    expect(useUIStore.getState().dispatcherOpen).toBe(true);
    expect(row.getAttribute('data-active')).toBe('true');
    // It's in no project: nothing becomes the active project.
    expect(useProjectStore.getState().activeProjectId).toBeNull();
  });

  it('pins the row above Needs you and the projects, and keeps it out of the tree', () => {
    turnOn();
    render(<ChromeSidebar />);
    const row = screen.getByTestId('dispatcher-row');
    const following = (el: Element) => !!(row.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(following(screen.getByTestId('needs-you'))).toBe(true);
    expect(following(screen.getByTestId('agent-list'))).toBe(true);
    expect(within(screen.getByTestId('agent-list')).queryByTestId('agent-item-disp')).toBeNull();
  });

  it('shows another computer’s Dispatcher beneath this one and opens its chat', async () => {
    turnOn();
    const machine = 'fp1';
    const chat = agent('remote-chat', DISPATCHER_PROJECT_ID, { name: 'Tael', executionMode: 'chat' });
    const remoteId = namespacedAgentId('s1', chat.id);
    useAnnexClientStore.setState({ satellites: [{ id: 's1', alias: 'Mini', state: 'connected', fingerprint: machine, icon: '', color: 'blue', host: 'h', mainPort: 1, pairingPort: 2, snapshot: { dispatcher: { agent: chat } }, lastError: null } as never] });
    useRemoteProjectStore.setState({ remoteAgents: { [remoteId]: { ...chat, id: remoteId, projectId: namespacedProjectId('s1', DISPATCHER_PROJECT_ID) } } });
    const presence = vi.spyOn(window.clubhouse.dispatcher, 'getPresence').mockResolvedValue({ remotes: [{ machineId: machine, machineName: 'Mini', address: 'work@fp1', dispatcherName: 'Tael', label: 'Tael on Mini', state: 'online', link: { state: 'active' } }] });
    render(<ChromeSidebar />);
    const row = await screen.findByRole('button', { name: 'Tael on Mini' });
    expect(screen.getByTestId('dispatcher-group')).toContainElement(row);
    expect(screen.queryByTestId('remote-dispatcher-controller')).toBeNull();
    expect(row).not.toHaveClass('bg-surface-0');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveClass('bg-surface-0', 'text-ctp-text');
    expect(useRemoteDispatcherSelection.getState().agentId).toBe(remoteId);
    expect(useUIStore.getState().dispatcherOpen).toBe(true);
    act(() => useDispatcherDebugStore.setState({ on: true }));
    expect(screen.getByTestId('remote-dispatcher-controller')).toHaveTextContent('Dispatcher controller');
    presence.mockRestore();
    useDispatcherDebugStore.setState({ on: false });
  });

  it('keeps a followed lead nested under this computer’s Dispatcher', async () => {
    turnOn();
    const chat = agent('remote-chat', DISPATCHER_PROJECT_ID, { name: 'Tael' });
    useAnnexClientStore.setState({ satellites: [{ id: 's1', alias: 'Mini', state: 'connected', fingerprint: 'fp1', icon: '', color: 'blue', host: 'h', mainPort: 1, pairingPort: 2, snapshot: { dispatcher: { agent: chat } }, lastError: null } as never] });
    useLeadStore.setState({ state: { available: true, following: true, role: 'follower', lead: { machine: 'fp1', name: 'Mini', self: false, online: true }, choices: [], outbox: { waiting: 0, oldestAt: null, expired: 0, failed: null }, localNews: { count: 0, needsUser: false } } as never });
    const getLead = vi.spyOn(window.clubhouse.dispatcher, 'getLead').mockImplementation(async () => useLeadStore.getState().state!);
    const presence = vi.spyOn(window.clubhouse.dispatcher, 'getPresence').mockResolvedValue({ remotes: [{ machineId: 'fp1', machineName: 'Mini', address: 'work@fp1', dispatcherName: 'Tael', label: 'Tael on Mini', state: 'online', link: { state: 'active' } }] });
    render(<><ChromeSidebar /><DispatcherView /></>);
    const remote = await screen.findByRole('button', { name: 'Tael on Mini' });
    expect(screen.getByTestId('dispatcher-row')).toHaveTextContent('Dispatcher');
    expect(screen.getByTestId('dispatcher-group')).toContainElement(remote);
    const local = within(screen.getByTestId('dispatcher-row')).getByTestId('agent-item-disp');
    fireEvent.click(remote);
    expect(remote).toHaveClass('bg-surface-0', 'text-ctp-text');
    expect(screen.getByTestId('follower-heading')).toHaveTextContent('Following Tael on Mini');
    fireEvent.click(screen.getByTestId('follower-earlier-toggle'));
    expect(screen.getByTestId('follower-heading')).toHaveTextContent('earlier chat');
    expect(remote).not.toHaveAttribute('aria-current');
    expect(local).toHaveAttribute('data-active', 'true');
    fireEvent.click(remote);
    expect(screen.getByTestId('follower-heading')).toHaveTextContent('Following Tael on Mini');
    expect(remote).toHaveAttribute('aria-current', 'true');
    fireEvent.click(local);
    expect(screen.getByTestId('follower-heading')).toHaveTextContent('earlier chat');
    fireEvent.click(screen.getByTestId('follower-earlier-toggle'));
    expect(screen.getByTestId('follower-heading')).toHaveTextContent('Following Tael on Mini');
    expect(remote).toHaveAttribute('aria-current', 'true');
    fireEvent.click(local);
    expect(screen.getByTestId('follower-heading')).toHaveTextContent('earlier chat');
    expect(local).toHaveAttribute('data-active', 'true');
    presence.mockRestore(); getLead.mockRestore();
  });

  describe('debug view (#3188)', () => {
    afterEach(() => useDispatcherDebugStore.setState({ on: false, workOpen: false }));

    it('shows no controller row while the debug view is off', () => {
      turnOn();
      render(<ChromeSidebar />);
      expect(screen.getByTestId('dispatcher-row')).toBeTruthy();
      expect(screen.queryByTestId('dispatcher-work-row')).toBeNull();
    });

    it('shows the controller row under the Dispatcher\'s, which opens its chat in the Dispatcher\'s view', () => {
      turnOn();
      useDispatcherDebugStore.setState({ on: true });
      render(<ChromeSidebar />);
      const work = screen.getByTestId('dispatcher-work-row');
      expect(!!(screen.getByTestId('dispatcher-row').compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      expect(work.textContent).toContain('Dispatcher controller');
      const item = within(work).getByRole('treeitem', { name: 'Dispatcher controller' });
      expect(within(item).getByRole('img', { name: 'Sleeping' })).toBeTruthy();
      fireEvent.click(item);
      expect(useUIStore.getState().dispatcherOpen).toBe(true);
      expect(useDispatcherDebugStore.getState().workOpen).toBe(true);
      expect(item.getAttribute('aria-selected')).toBe('true');
      expect(item.getAttribute('aria-level')).toBe('2');
      const chat = within(screen.getByTestId('dispatcher-row')).getByTestId('agent-item-disp');
      expect(chat.getAttribute('data-active')).toBe('false');
      // The Dispatcher's own row goes back to its chat.
      fireEvent.click(chat);
      expect(useDispatcherDebugStore.getState().workOpen).toBe(false);
      expect(chat.getAttribute('data-active')).toBe('true');
      expect(item.getAttribute('aria-selected')).toBe('false');
    });
  });

  it('takes the selection while its view is open, and a project click closes it', () => {
    turnOn();
    useUIStore.setState({ dispatcherOpen: true });
    render(<ChromeSidebar />);
    expect(screen.getByTestId('agent-item-disp').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('agent-item-a1').getAttribute('data-active')).toBe('false');
    fireEvent.click(within(screen.getByTestId('project-p1')).getByText('Clubhouse'));
    expect(useUIStore.getState().dispatcherOpen).toBe(false);
  });

  it('shows the Dispatcher\'s Ask-first request on its own row, and opens that request (#3036)', () => {
    turnOn();
    useGrantRequestStore.setState({ requests: { r1: {
      requestId: 'r1', kind: 'call', agentId: 'disp-work', agentName: 'Dispatcher', projectPath: 'dispatcher-work-dir', actions: ['settings.app.write'],
      where: 'the app', toolName: 'set_helper_presets', createdAt: '2026-11-08T00:00:00.000Z', expiresAt: '2026-11-09T00:00:00.000Z',
    } }, reviewing: null });
    try {
      render(<ChromeSidebar />);
      const section = screen.getByTestId('needs-you');
      expect(within(section).queryByTestId('needs-you-row-disp-work')).toBeNull();
      const row = within(section).getByTestId('needs-you-row-disp');
      expect(row.textContent).toContain('Change app settings');
      fireEvent.click(row);
      expect(useGrantRequestStore.getState().reviewing).toBe('disp-work');
      expect(useUIStore.getState().dispatcherOpen).toBe(true);
      act(() => useGrantRequestStore.getState().add({
        ...useGrantRequestStore.getState().requests.r1, requestId: 'r2', agentId: 'disp',
        createdAt: '2026-11-08T00:00:01.000Z',
      }));
      expect(row).toHaveTextContent('2 requests');
      act(() => useGrantRequestStore.getState().remove(['r1']));
      expect(row).not.toHaveTextContent('2 requests');
      fireEvent.click(row);
      expect(useGrantRequestStore.getState().reviewing).toBe('disp');
      act(() => useGrantRequestStore.getState().remove(['r2']));
      expect(screen.queryByTestId('needs-you-row-disp')).not.toBeInTheDocument();
      expect(useGrantRequestStore.getState().reviewing).toBeNull();
    } finally {
      useGrantRequestStore.setState({ requests: {}, reviewing: null });
    }
  });

  it('lists the Dispatcher in Needs you despite its synthetic project id, and opens its view', () => {
    turnOn();
    useAgentStore.setState((s) => ({
      agentDetailedStatus: { ...s.agentDetailedStatus, disp: { state: 'needs_permission', message: 'Wants to run: gh pr list', timestamp: 2 } },
    }));
    render(<ChromeSidebar />);
    const section = screen.getByTestId('needs-you');
    const row = within(section).getByTestId('needs-you-row-disp');
    expect(row.textContent).toContain('Wants to run: gh pr list');
    expect(within(section).getByTestId('needs-you-row-b1')).toBeTruthy();
    fireEvent.click(row);
    expect(useUIStore.getState().dispatcherOpen).toBe(true);
    // The project and its agent stay as they were.
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
    expect(useAgentStore.getState().activeAgentId).toBe('a1');
  });

  it('leaves the Dispatcher out of Needs you once it is off', () => {
    turnOn();
    useAgentStore.setState((s) => ({
      agentDetailedStatus: { ...s.agentDetailedStatus, disp: { state: 'needs_permission', message: 'Wants to run: gh pr list', timestamp: 2 } },
    }));
    useDispatcherStore.getState().setState({ ...DISPATCHER_OFF, agentId: 'disp-work', path: 'dispatcher-work-dir', chatAgentId: 'disp', chatPath: 'dispatcher-dir' });
    render(<ChromeSidebar />);
    expect(screen.queryByTestId('needs-you-row-disp')).toBeNull();
  });

  describe('when its agent fails to load (#2572)', () => {
    const config = { id: 'disp', name: 'Dispatcher', color: 'indigo', createdAt: '2026-10-31T00:00:00.000Z' } as DurableAgentConfig;
    const ON: DispatcherState = { enabled: true, flagOn: true, agentId: 'disp-work', path: 'dispatcher-work-dir', chatAgentId: 'disp', chatPath: 'dispatcher-dir', config };
    const originals = { get: window.clubhouse.dispatcher.get, listDurable: window.clubhouse.agent.listDurable };
    /** The shell's pieces: the sync hook, the sidebar, and the view while it's open. */
    function Shell() {
      useDispatcherSync();
      const open = useUIStore((s) => s.dispatcherOpen);
      return <><ChromeSidebar />{open && <DispatcherView />}</>;
    }
    beforeEach(() => {
      useAgentStore.setState((s) => {
        const { disp: _gone, ...agents } = s.agents;
        return { agents };
      });
      window.clubhouse.dispatcher.get = vi.fn().mockResolvedValue(ON);
    });
    afterEach(() => {
      window.clubhouse.dispatcher.get = originals.get;
      window.clubhouse.agent.listDurable = originals.listDurable;
      useDispatcherStore.setState({ loadError: null });
    });

    it('still shows the row, which opens the view with the error and Retry, and Retry recovers', async () => {
      window.clubhouse.agent.listDurable = vi.fn()
        .mockRejectedValueOnce(new Error('disk unavailable'))
        .mockResolvedValue([config]);
      render(<Shell />);
      await waitFor(() => expect(useDispatcherStore.getState().loadError).toBe('disk unavailable'));

      const row = within(screen.getByTestId('dispatcher-row')).getByTestId('dispatcher-row-pending');
      const item = within(row).getByRole('treeitem', { name: 'Dispatcher' });
      expect(item.tabIndex).toBe(0);
      expect(item.getAttribute('aria-selected')).toBe('false');
      expect(within(item).getByRole('img', { name: 'Error' })).toBeTruthy();
      expect(item.getAttribute('aria-describedby')).toBeTruthy();
      expect(document.getElementById(item.getAttribute('aria-describedby')!)!.textContent).toBe('couldn’t load');

      fireEvent.keyDown(item, { key: 'Enter' });
      expect(useUIStore.getState().dispatcherOpen).toBe(true);
      expect(item.getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('alert').textContent).toBe('Couldn’t load the Dispatcher. disk unavailable');

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(screen.getByTestId('agent-item-disp')).toBeTruthy());
      expect(screen.queryByTestId('dispatcher-row-pending')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByTestId('dispatcher-view').getAttribute('data-agent-id')).toBe('disp');
    });

    it('shows a neutral loading status while the load is pending', () => {
      window.clubhouse.agent.listDurable = vi.fn(() => new Promise<never>(() => {}));
      useDispatcherStore.getState().setState(ON);
      render(<ChromeSidebar />);
      const item = within(screen.getByTestId('dispatcher-row-pending')).getByRole('treeitem', { name: 'Dispatcher' });
      expect(within(item).getByRole('img', { name: 'Starting' })).toBeTruthy();
      expect(item.textContent).toContain('loading');
    });

    it('shows no row while the Dispatcher is off, even with an agent id', () => {
      useDispatcherStore.getState().setState({ ...DISPATCHER_OFF, agentId: 'disp-work', path: 'dispatcher-work-dir', chatAgentId: 'disp', chatPath: 'dispatcher-dir' });
      useDispatcherStore.getState().setLoadError('disk unavailable');
      render(<ChromeSidebar />);
      expect(screen.queryByTestId('dispatcher-row')).toBeNull();
    });
  });

  it('offers Pop Out in its menu, which opens its chat in its own window (#3235)', () => {
    turnOn();
    const createPopout = vi.spyOn(window.clubhouse.window, 'createPopout').mockResolvedValue(1);
    render(<ChromeSidebar />);
    fireEvent.contextMenu(screen.getByTestId('agent-item-disp'));
    fireEvent.click(within(screen.getByTestId('agent-context-menu')).getByTestId('ctx-popout'));
    expect(createPopout).toHaveBeenCalledWith({ type: 'agent', agentId: 'disp', projectId: DISPATCHER_PROJECT_ID, title: 'Dispatcher' });
    createPopout.mockRestore();
  });

  it('offers no delete, duplicate or persona in its menu, and Settings opens Settings > Dispatcher', () => {
    turnOn();
    render(<ChromeSidebar />);
    fireEvent.contextMenu(screen.getByTestId('agent-item-disp'));
    const menu = screen.getByTestId('agent-context-menu');
    for (const id of ['delete', 'remove', 'apply-persona', 'extract-persona', 'duplicate']) {
      expect(within(menu).queryByTestId(`ctx-${id}`)).toBeNull();
    }
    expect(within(menu).getByTestId('ctx-wake')).toBeTruthy();
    fireEvent.click(within(menu).getByTestId('ctx-settings'));
    expect(useUIStore.getState()).toMatchObject({ explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'dispatcher', dispatcherOpen: false });
    expect(useAgentStore.getState().agentSettingsOpenFor).toBeNull();
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

