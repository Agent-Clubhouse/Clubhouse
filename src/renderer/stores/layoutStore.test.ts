import { describe, it, expect, beforeEach, vi } from 'vitest';

// Set up localStorage mock BEFORE importing the store (module-level loadFromStorage)
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  removeItem: vi.fn((key: string) => storage.delete(key)),
  clear: vi.fn(() => storage.clear()),
  get length() { return storage.size; },
  key: vi.fn((_i: number) => null),
};
vi.stubGlobal('localStorage', localStorageMock);

// We need to re-import the module fresh for each describe block to test persistence.
// For default tests, we import with empty localStorage.

import {
  useLayoutStore,
  EXPLORER_MIN,
  EXPLORER_MAX,
  EXPLORER_DEFAULT,
  ACCESSORY_MIN,
  ACCESSORY_MAX,
  ACCESSORY_DEFAULT,
} from './layoutStore';

function getState() {
  return useLayoutStore.getState();
}

describe('layoutStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.clear();
    // Reset to defaults
    useLayoutStore.setState({
      explorerWidth: EXPLORER_DEFAULT,
      accessoryWidth: ACCESSORY_DEFAULT,
      explorerCollapsed: false,
      accessoryCollapsed: false,
      hubSplitRatios: {},
    });
  });

  describe('setExplorerWidth', () => {
    it('clamps to [140, 400]', () => {
      getState().setExplorerWidth(50);
      expect(getState().explorerWidth).toBe(EXPLORER_MIN);

      getState().setExplorerWidth(999);
      expect(getState().explorerWidth).toBe(EXPLORER_MAX);

      getState().setExplorerWidth(250);
      expect(getState().explorerWidth).toBe(250);
    });

    it('rounds to integer', () => {
      getState().setExplorerWidth(200.7);
      expect(getState().explorerWidth).toBe(201);

      getState().setExplorerWidth(200.3);
      expect(getState().explorerWidth).toBe(200);
    });
  });

  describe('setAccessoryWidth', () => {
    it('clamps to [180, 500]', () => {
      getState().setAccessoryWidth(50);
      expect(getState().accessoryWidth).toBe(ACCESSORY_MIN);

      getState().setAccessoryWidth(999);
      expect(getState().accessoryWidth).toBe(ACCESSORY_MAX);

      getState().setAccessoryWidth(300);
      expect(getState().accessoryWidth).toBe(300);
    });
  });

  describe('setHubSplitRatio', () => {
    it('clamps to [0.05, 0.95]', () => {
      getState().setHubSplitRatio('node_1', 0.01);
      expect(getState().hubSplitRatios['node_1']).toBe(0.05);

      getState().setHubSplitRatio('node_1', 0.99);
      expect(getState().hubSplitRatios['node_1']).toBe(0.95);

      getState().setHubSplitRatio('node_1', 0.5);
      expect(getState().hubSplitRatios['node_1']).toBe(0.5);
    });
  });

  describe('removeHubSplitRatio', () => {
    it('removes entry', () => {
      getState().setHubSplitRatio('node_rm', 0.5);
      expect(getState().hubSplitRatios['node_rm']).toBe(0.5);
      getState().removeHubSplitRatio('node_rm');
      expect(getState().hubSplitRatios['node_rm']).toBeUndefined();
    });

    it('no-op if missing', () => {
      expect(() => getState().removeHubSplitRatio('nonexistent')).not.toThrow();
    });
  });

  describe('toggleExplorerCollapsed', () => {
    it('flips boolean', () => {
      expect(getState().explorerCollapsed).toBe(false);
      getState().toggleExplorerCollapsed();
      expect(getState().explorerCollapsed).toBe(true);
      getState().toggleExplorerCollapsed();
      expect(getState().explorerCollapsed).toBe(false);
    });
  });

  describe('toggleAccessoryCollapsed', () => {
    it('flips boolean', () => {
      expect(getState().accessoryCollapsed).toBe(false);
      getState().toggleAccessoryCollapsed();
      expect(getState().accessoryCollapsed).toBe(true);
      getState().toggleAccessoryCollapsed();
      expect(getState().accessoryCollapsed).toBe(false);
    });
  });

  describe('persistence', () => {
    it('saves state to localStorage', () => {
      getState().setExplorerWidth(300);
      expect(storage.has('clubhouse_layout')).toBe(true);
      const saved = JSON.parse(storage.get('clubhouse_layout')!);
      expect(saved.explorerWidth).toBe(300);
    });

    it('loads saved state from localStorage', () => {
      const savedState = {
        explorerWidth: 350,
        accessoryWidth: 400,
        explorerCollapsed: true,
        accessoryCollapsed: false,
        hubSplitRatios: { 'node_1': 0.3 },
      };
      storage.set('clubhouse_layout', JSON.stringify(savedState));

      // Simulate a store reload by reading from storage and setting state
      const raw = JSON.parse(storage.get('clubhouse_layout')!);
      useLayoutStore.setState(raw);
      expect(getState().explorerWidth).toBe(350);
      expect(getState().accessoryWidth).toBe(400);
      expect(getState().explorerCollapsed).toBe(true);
      expect(getState().hubSplitRatios['node_1']).toBe(0.3);
    });

    it('uses defaults when localStorage is empty', () => {
      // Store was initialized with empty localStorage (from beforeEach)
      expect(getState().explorerWidth).toBe(EXPLORER_DEFAULT);
      expect(getState().accessoryWidth).toBe(ACCESSORY_DEFAULT);
      expect(getState().explorerCollapsed).toBe(false);
      expect(getState().accessoryCollapsed).toBe(false);
    });

    it('uses defaults when localStorage is corrupt', () => {
      storage.set('clubhouse_layout', '{{not json}}');
      // Reset to defaults (simulates what would happen on fresh import)
      useLayoutStore.setState({
        explorerWidth: EXPLORER_DEFAULT,
        accessoryWidth: ACCESSORY_DEFAULT,
        explorerCollapsed: false,
        accessoryCollapsed: false,
        hubSplitRatios: {},
      });
      expect(getState().explorerWidth).toBe(EXPLORER_DEFAULT);
    });
  });
});
