import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  useChromeStore,
  loadChromeState,
  clampSidebarWidth,
  CHROME_STORAGE_KEY,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  syncProjectActivityWithAgents,
} from './chromeStore';
import { useAgentStore } from '../stores/agentStore';

describe('chromeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useChromeStore.setState({ sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false, lastProjectId: null, pinnedProjectIds: [], collapsedProjectIds: [], expandedFolds: [], tabMru: {}, projectActivity: {}, idleDays: 7, idleOpen: false, projectSort: 'manual', agentSort: 'manual', inactiveProjectIds: [], agentActivity: {}, collapsedAgentIds: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('loadChromeState', () => {
    it('defaults to a 264px expanded sidebar when nothing is stored', () => {
      expect(loadChromeState()).toEqual({ sidebarWidth: 264, sidebarCollapsed: false, lastProjectId: null, pinnedProjectIds: [], collapsedProjectIds: [], expandedFolds: [], tabMru: {}, projectActivity: {}, idleDays: 7, idleOpen: false, projectSort: 'manual', agentSort: 'manual', inactiveProjectIds: [], agentActivity: {}, collapsedAgentIds: [] });
    });

    it('reads persisted width and collapsed state', () => {
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 1, sidebarWidth: 300, sidebarCollapsed: true }));
      expect(loadChromeState()).toMatchObject({ sidebarWidth: 300, sidebarCollapsed: true });
    });

    it('clamps an out-of-range persisted width', () => {
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 1, sidebarWidth: 5000 }));
      expect(loadChromeState().sidebarWidth).toBe(SIDEBAR_MAX);
    });

    it('falls back to defaults on corrupt JSON', () => {
      localStorage.setItem(CHROME_STORAGE_KEY, '{not json');
      expect(loadChromeState()).toEqual({ sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false, lastProjectId: null, pinnedProjectIds: [], collapsedProjectIds: [], expandedFolds: [], tabMru: {}, projectActivity: {}, idleDays: 7, idleOpen: false, projectSort: 'manual', agentSort: 'manual', inactiveProjectIds: [], agentActivity: {}, collapsedAgentIds: [] });
    });

    it('reads the last selected project', () => {
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 1, lastProjectId: 'p2' }));
      expect(loadChromeState().lastProjectId).toBe('p2');
    });

    it('never reads the legacy panel sizes key', () => {
      localStorage.setItem('clubhouse_panel_sizes', JSON.stringify({ explorerWidth: 390, explorerCollapsed: true }));
      expect(loadChromeState()).toEqual({ sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false, lastProjectId: null, pinnedProjectIds: [], collapsedProjectIds: [], expandedFolds: [], tabMru: {}, projectActivity: {}, idleDays: 7, idleOpen: false, projectSort: 'manual', agentSort: 'manual', inactiveProjectIds: [], agentActivity: {}, collapsedAgentIds: [] });
    });
  });

  describe('tree state', () => {
    it('reads pins, collapsed projects and expanded folds, ignoring junk', () => {
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 2, pinnedProjectIds: ['a', 3], collapsedProjectIds: ['b'], expandedFolds: 'nope' }));
      expect(loadChromeState()).toMatchObject({ pinnedProjectIds: ['a'], collapsedProjectIds: ['b'], expandedFolds: [] });
    });

    it('reads a version 1 payload without tree state', () => {
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 1, sidebarWidth: 280, sidebarCollapsed: false }));
      expect(loadChromeState()).toEqual({ sidebarWidth: 280, sidebarCollapsed: false, lastProjectId: null, pinnedProjectIds: [], collapsedProjectIds: [], expandedFolds: [], tabMru: {}, projectActivity: {}, idleDays: 7, idleOpen: false, projectSort: 'manual', agentSort: 'manual', inactiveProjectIds: [], agentActivity: {}, collapsedAgentIds: [] });
    });

    it('togglePinned adds and removes a project', () => {
      useChromeStore.getState().togglePinned('p1');
      expect(useChromeStore.getState().pinnedProjectIds).toEqual(['p1']);
      useChromeStore.getState().togglePinned('p1');
      expect(useChromeStore.getState().pinnedProjectIds).toEqual([]);
    });

    it('toggleCollapseAll collapses everything, then expands everything', () => {
      useChromeStore.getState().setProjectCollapsed('p1', true);
      useChromeStore.getState().toggleCollapseAll(['p1', 'p2']);
      expect(new Set(useChromeStore.getState().collapsedProjectIds)).toEqual(new Set(['p1', 'p2']));
      useChromeStore.getState().toggleCollapseAll(['p1', 'p2']);
      expect(useChromeStore.getState().collapsedProjectIds).toEqual([]);
    });

    it('forgetProjects drops state for removed projects only', () => {
      useChromeStore.setState({ pinnedProjectIds: ['p1', 'p2'], collapsedProjectIds: ['p2'], expandedFolds: ['p2:sleeping', 'p1:finished'], lastProjectId: 'p2' });
      useChromeStore.getState().forgetProjects(['p2']);
      expect(useChromeStore.getState()).toMatchObject({ pinnedProjectIds: ['p1'], collapsedProjectIds: [], expandedFolds: ['p1:finished'], lastProjectId: null });
    });

    it('toggleFold tracks folds per project', () => {
      useChromeStore.getState().toggleFold('p1', 'sleeping');
      expect(useChromeStore.getState().expandedFolds).toEqual(['p1:sleeping']);
      useChromeStore.getState().toggleFold('p1', 'sleeping');
      expect(useChromeStore.getState().expandedFolds).toEqual([]);
    });
  });

  describe('clampSidebarWidth', () => {
    it('clamps to the 220px minimum and 480px maximum', () => {
      expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN);
      expect(clampSidebarWidth(900)).toBe(SIDEBAR_MAX);
      expect(clampSidebarWidth(250.4)).toBe(250);
    });

    it('returns the default for non-finite input', () => {
      expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT);
    });
  });

  describe('actions', () => {
    it('resizeSidebar applies the delta within bounds', () => {
      useChromeStore.getState().resizeSidebar(30);
      expect(useChromeStore.getState().sidebarWidth).toBe(294);
      useChromeStore.getState().resizeSidebar(-500);
      expect(useChromeStore.getState().sidebarWidth).toBe(SIDEBAR_MIN);
    });

    it('resizeSidebar is ignored while collapsed', () => {
      useChromeStore.setState({ sidebarCollapsed: true });
      useChromeStore.getState().resizeSidebar(40);
      expect(useChromeStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT);
    });

    it('toggleSidebar flips the collapsed state', () => {
      useChromeStore.getState().toggleSidebar();
      expect(useChromeStore.getState().sidebarCollapsed).toBe(true);
      useChromeStore.getState().toggleSidebar();
      expect(useChromeStore.getState().sidebarCollapsed).toBe(false);
    });

    it('persists to clubhouse_chrome_v2 after the debounce, leaving the legacy key alone', () => {
      vi.useFakeTimers();
      localStorage.setItem('clubhouse_panel_sizes', '{"explorerWidth":200}');
      useChromeStore.getState().setSidebarWidth(310);
      useChromeStore.getState().toggleSidebar();
      expect(localStorage.getItem(CHROME_STORAGE_KEY)).toBeNull();
      vi.advanceTimersByTime(400);
      expect(JSON.parse(localStorage.getItem(CHROME_STORAGE_KEY)!)).toEqual({ version: 2, sidebarWidth: 310, sidebarCollapsed: true, lastProjectId: null, pinnedProjectIds: [], collapsedProjectIds: [], expandedFolds: [], tabMru: {}, projectActivity: {}, idleDays: 7, idleOpen: false, projectSort: 'manual', agentSort: 'manual', inactiveProjectIds: [], agentActivity: {}, collapsedAgentIds: [] });
      expect(localStorage.getItem('clubhouse_panel_sizes')).toBe('{"explorerWidth":200}');
    });
  });

  describe('lazy load', () => {
    it('does not read localStorage at startup when the new layout is off', async () => {
      vi.resetModules();
      (window.clubhouse as { newChromeLayout?: boolean }).newChromeLayout = undefined;
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 1, sidebarWidth: 400 }));
      const getItem = vi.spyOn(Storage.prototype, 'getItem');
      const mod = await import('./chromeStore');
      expect(getItem).not.toHaveBeenCalledWith(CHROME_STORAGE_KEY);
      expect(mod.useChromeStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT);
      getItem.mockRestore();
    });

    it('loads the saved state on first use by the legacy agent list, and only then persists', async () => {
      vi.resetModules();
      (window.clubhouse as { newChromeLayout?: boolean }).newChromeLayout = undefined;
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 2, sidebarWidth: 400, pinnedProjectIds: ['p1'], collapsedAgentIds: ['lead'] }));
      const mod = await import('./chromeStore');
      expect(mod.useChromeStore.getState().collapsedAgentIds).toEqual([]);
      vi.useFakeTimers();
      // A fold change loads first, so the persist keeps what was saved.
      mod.useChromeStore.getState().toggleAgentCollapsed('other');
      expect(mod.useChromeStore.getState().collapsedAgentIds).toEqual(['lead', 'other']);
      vi.advanceTimersByTime(400);
      expect(mod.loadChromeState()).toMatchObject({ sidebarWidth: 400, pinnedProjectIds: ['p1'], collapsedAgentIds: ['lead', 'other'] });
      vi.useRealTimers();
    });

    it('loads persisted state at startup when the new layout is on', async () => {
      vi.resetModules();
      (window.clubhouse as { newChromeLayout?: boolean }).newChromeLayout = true;
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 1, sidebarWidth: 400 }));
      const mod = await import('./chromeStore');
      expect(mod.useChromeStore.getState().sidebarWidth).toBe(400);
      (window.clubhouse as { newChromeLayout?: boolean }).newChromeLayout = undefined;
    });
  });

  it('forgets every stored project with a prefix: an unpaired satellite', () => {
    useChromeStore.setState({
      pinnedProjectIds: ['p1', 'remote||s1||a'],
      collapsedProjectIds: ['remote||s1||b', 'remote||s2||c'],
      expandedFolds: ['remote||s1||a:sleeping', 'p1:finished'],
      lastProjectId: 'p1',
      tabMru: { p1: ['agents'], 'remote||s1||a': ['plugin:files'] },
    });
    useChromeStore.getState().forgetProjectsWithPrefix('remote||s1||');
    expect(useChromeStore.getState()).toMatchObject({
      pinnedProjectIds: ['p1'],
      collapsedProjectIds: ['remote||s2||c'],
      expandedFolds: ['p1:finished'],
      lastProjectId: 'p1',
      tabMru: { p1: ['agents'] },
    });
  });

  describe('tab MRU', () => {
    it('records tab opens per project, persists them, and forgets removed projects', () => {
      vi.useFakeTimers();
      try {
        useChromeStore.setState({ tabMru: {} });
        useChromeStore.getState().touchTab('p1', 'plugin:git');
        useChromeStore.getState().touchTab('p1', 'agents');
        useChromeStore.getState().touchTab('p2', 'plugin:files');
        expect(useChromeStore.getState().tabMru).toEqual({ p1: ['agents', 'plugin:git'], p2: ['plugin:files'] });
        vi.advanceTimersByTime(400);
        expect(loadChromeState().tabMru).toEqual({ p1: ['agents', 'plugin:git'], p2: ['plugin:files'] });
        useChromeStore.getState().forgetProjects(['p2']);
        expect(useChromeStore.getState().tabMru).toEqual({ p1: ['agents', 'plugin:git'] });
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores a malformed stored MRU', () => {
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 2, sidebarWidth: 300, tabMru: ['x'] }));
      expect(loadChromeState().tabMru).toEqual({});
    });
  });

  it('keeps the keyboard shortcut overrides that share its key when it saves', () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 2, shortcuts: { version: 1, overrides: { 'tab-2': 'Meta+Shift+2' } } }));
      useChromeStore.getState().setSidebarWidth(300);
      vi.advanceTimersByTime(400);
      const saved = JSON.parse(localStorage.getItem(CHROME_STORAGE_KEY)!);
      expect(saved.sidebarWidth).toBe(300);
      expect(saved.shortcuts).toEqual({ version: 1, overrides: { 'tab-2': 'Meta+Shift+2' } });
    } finally {
      vi.useRealTimers();
    }
  });

  describe('project activity', () => {
    it('records activity at most once a minute per project, and seeds only unknown projects', () => {
      useChromeStore.setState({ projectActivity: { p1: 1_000 } });
      useChromeStore.getState().markActivity('p1', 30_000);
      expect(useChromeStore.getState().projectActivity.p1).toBe(1_000);
      useChromeStore.getState().markActivity('p1', 70_000);
      expect(useChromeStore.getState().projectActivity.p1).toBe(70_000);
      useChromeStore.getState().seedActivity(['p1', 'p2'], 90_000);
      expect(useChromeStore.getState().projectActivity).toEqual({ p1: 70_000, p2: 90_000 });
      useChromeStore.getState().forgetProjects(['p2']);
      expect(useChromeStore.getState().projectActivity).toEqual({ p1: 70_000 });
    });

    it('opening a tab is activity', () => {
      useChromeStore.setState({ projectActivity: {}, tabMru: {} });
      useChromeStore.getState().touchTab('p3', 'plugin:files');
      expect(useChromeStore.getState().projectActivity.p3).toBeGreaterThan(0);
    });

    it('agent spawns are activity, through the agent subscription', () => {
      useChromeStore.setState({ projectActivity: {} });
      useAgentStore.setState({ agents: { a1: { id: 'a1', projectId: 'p4' } as never }, agentSpawnedAt: {} });
      const stop = syncProjectActivityWithAgents();
      try {
        useAgentStore.setState({ agentSpawnedAt: { a1: 123_000 } });
        expect(useChromeStore.getState().projectActivity.p4).toBe(123_000);
      } finally {
        stop();
      }
    });

    it('persists sort modes, inactive marks and agent activity, and reads bad values as defaults (#2116)', () => {
      vi.useFakeTimers();
      const s = useChromeStore.getState();
      s.setProjectSort('recent');
      s.setAgentSort('recent');
      s.markProjectInactive('p1');
      s.markAgentActivity('a1', 5_000);
      vi.advanceTimersByTime(400);
      expect(loadChromeState()).toMatchObject({ projectSort: 'recent', agentSort: 'recent', inactiveProjectIds: ['p1'], agentActivity: { a1: 5_000 } });

      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 2, projectSort: 'sideways', agentSort: 7, inactiveProjectIds: 'p1' }));
      expect(loadChromeState()).toMatchObject({ projectSort: 'manual', agentSort: 'manual', inactiveProjectIds: [] });
    });

    it('persists folded helpers per agent, and reads bad values as none (#2231)', () => {
      vi.useFakeTimers();
      const s = useChromeStore.getState();
      s.toggleAgentCollapsed('lead');
      s.toggleAgentCollapsed('other');
      s.toggleAgentCollapsed('other');
      vi.advanceTimersByTime(400);
      expect(loadChromeState().collapsedAgentIds).toEqual(['lead']);

      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 2, collapsedAgentIds: 'lead' }));
      expect(loadChromeState().collapsedAgentIds).toEqual([]);
    });

    it('unfolds given agents and forgets removed ones, leaving the rest', () => {
      vi.useFakeTimers();
      useChromeStore.setState({ collapsedAgentIds: ['lead', 'other', 'gone'], agentActivity: { gone: 1, lead: 2 } });
      const s = useChromeStore.getState();
      s.expandAgents(['other']);
      s.forgetAgents(['gone']);
      expect(useChromeStore.getState().collapsedAgentIds).toEqual(['lead']);
      expect(useChromeStore.getState().agentActivity).toEqual({ lead: 2 });
      vi.advanceTimersByTime(400);
      expect(loadChromeState().collapsedAgentIds).toEqual(['lead']);
    });

    it('marks a project inactive, but not a pinned one, and Mark active clears it and counts as activity now', () => {
      const s = useChromeStore.getState();
      useChromeStore.setState({ pinnedProjectIds: ['pinned'], projectActivity: { p1: 1_000 } });
      s.markProjectInactive('pinned');
      s.markProjectInactive('p1');
      s.markProjectInactive('p1');
      expect(useChromeStore.getState().inactiveProjectIds).toEqual(['p1']);
      // Unthrottled: well inside the activity write interval of the last write.
      s.markProjectActive('p1', 2_000);
      expect(useChromeStore.getState().inactiveProjectIds).toEqual([]);
      expect(useChromeStore.getState().projectActivity.p1).toBe(2_000);
    });

    it('forgets inactive marks for removed projects', () => {
      useChromeStore.setState({ inactiveProjectIds: ['p1', 'p2'] });
      useChromeStore.getState().forgetProjects(['p1']);
      expect(useChromeStore.getState().inactiveProjectIds).toEqual(['p2']);
    });

    it('agent wakes and turns starting are agent activity, through the agent subscription', () => {
      useAgentStore.setState({ agents: { a1: { id: 'a1', projectId: 'p4' } as never }, agentSpawnedAt: {}, agentDetailedStatus: {} });
      const stop = syncProjectActivityWithAgents();
      try {
        useAgentStore.setState({ agentSpawnedAt: { a1: 123_000 } });
        expect(useChromeStore.getState().agentActivity.a1).toBe(123_000);
        useChromeStore.setState({ agentActivity: {} });
        useAgentStore.setState({ agentDetailedStatus: { a1: { state: 'working', message: '', timestamp: 1 } } });
        expect(useChromeStore.getState().agentActivity.a1).toBeGreaterThan(0);
        // Still working: no new write.
        useChromeStore.setState({ agentActivity: { a1: 1 } });
        useAgentStore.setState({ agentDetailedStatus: { a1: { state: 'working', message: 'still', timestamp: 2 } } });
        expect(useChromeStore.getState().agentActivity.a1).toBe(1);
      } finally {
        stop();
      }
    });

    it('persists the idle window and the idle row state', () => {
      vi.useFakeTimers();
      try {
        useChromeStore.getState().setIdleDays(14);
        useChromeStore.setState({ idleOpen: false });
        useChromeStore.getState().toggleIdleOpen();
        vi.advanceTimersByTime(400);
        expect(loadChromeState()).toMatchObject({ idleDays: 14, idleOpen: true });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
