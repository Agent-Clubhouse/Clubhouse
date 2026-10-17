import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  useChromeStore,
  loadChromeState,
  clampSidebarWidth,
  CHROME_STORAGE_KEY,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
} from './chromeStore';

describe('chromeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useChromeStore.setState({ sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('loadChromeState', () => {
    it('defaults to a 264px expanded sidebar when nothing is stored', () => {
      expect(loadChromeState()).toEqual({ sidebarWidth: 264, sidebarCollapsed: false });
    });

    it('reads persisted width and collapsed state', () => {
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 1, sidebarWidth: 300, sidebarCollapsed: true }));
      expect(loadChromeState()).toEqual({ sidebarWidth: 300, sidebarCollapsed: true });
    });

    it('clamps an out-of-range persisted width', () => {
      localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 1, sidebarWidth: 5000 }));
      expect(loadChromeState().sidebarWidth).toBe(SIDEBAR_MAX);
    });

    it('falls back to defaults on corrupt JSON', () => {
      localStorage.setItem(CHROME_STORAGE_KEY, '{not json');
      expect(loadChromeState()).toEqual({ sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false });
    });

    it('never reads the legacy panel sizes key', () => {
      localStorage.setItem('clubhouse_panel_sizes', JSON.stringify({ explorerWidth: 390, explorerCollapsed: true }));
      expect(loadChromeState()).toEqual({ sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false });
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
      expect(JSON.parse(localStorage.getItem(CHROME_STORAGE_KEY)!)).toEqual({ version: 1, sidebarWidth: 310, sidebarCollapsed: true });
      expect(localStorage.getItem('clubhouse_panel_sizes')).toBe('{"explorerWidth":200}');
    });
  });
});
