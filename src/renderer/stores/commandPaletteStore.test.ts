import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage
const storage: Record<string, string> = {};
Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: { platform: 'darwin' },
  },
  writable: true,
});
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: vi.fn((key: string) => storage[key] ?? null),
    setItem: vi.fn((key: string, val: string) => { storage[key] = val; }),
    removeItem: vi.fn((key: string) => { delete storage[key]; }),
  },
  writable: true,
});

import { useCommandPaletteStore } from './commandPaletteStore';

describe('commandPaletteStore', () => {
  beforeEach(() => {
    // Reset store state
    useCommandPaletteStore.setState({
      isOpen: false,
      query: '',
      mode: 'all',
      selectedIndex: 0,
      recentCommands: [],
    });
    for (const key of Object.keys(storage)) delete storage[key];
  });

  describe('open/close/toggle', () => {
    it('opens the palette', () => {
      useCommandPaletteStore.getState().open();
      expect(useCommandPaletteStore.getState().isOpen).toBe(true);
    });

    it('closes the palette and resets state', () => {
      useCommandPaletteStore.setState({ isOpen: true, query: 'test', selectedIndex: 3 });
      useCommandPaletteStore.getState().close();
      const state = useCommandPaletteStore.getState();
      expect(state.isOpen).toBe(false);
      expect(state.query).toBe('');
      expect(state.selectedIndex).toBe(0);
    });

    it('toggles open to close', () => {
      useCommandPaletteStore.setState({ isOpen: true });
      useCommandPaletteStore.getState().toggle();
      expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    });

    it('toggles closed to open', () => {
      useCommandPaletteStore.getState().toggle();
      expect(useCommandPaletteStore.getState().isOpen).toBe(true);
    });
  });

  describe('setQuery', () => {
    it('sets query and resets selectedIndex', () => {
      useCommandPaletteStore.setState({ selectedIndex: 5 });
      useCommandPaletteStore.getState().setQuery('hello');
      const state = useCommandPaletteStore.getState();
      expect(state.query).toBe('hello');
      expect(state.selectedIndex).toBe(0);
    });

    it('derives mode "commands" from > prefix', () => {
      useCommandPaletteStore.getState().setQuery('>settings');
      expect(useCommandPaletteStore.getState().mode).toBe('commands');
    });

    it('derives mode "agents" from @ prefix', () => {
      useCommandPaletteStore.getState().setQuery('@tapir');
      expect(useCommandPaletteStore.getState().mode).toBe('agents');
    });

    it('derives mode "projects" from # prefix', () => {
      useCommandPaletteStore.getState().setQuery('#myproj');
      expect(useCommandPaletteStore.getState().mode).toBe('projects');
    });

    it('derives mode "all" for no prefix', () => {
      useCommandPaletteStore.getState().setQuery('search');
      expect(useCommandPaletteStore.getState().mode).toBe('all');
    });
  });

  describe('moveSelection', () => {
    it('moves selection down', () => {
      useCommandPaletteStore.getState().moveSelection(1, 5);
      expect(useCommandPaletteStore.getState().selectedIndex).toBe(1);
    });

    it('wraps to beginning after max', () => {
      useCommandPaletteStore.setState({ selectedIndex: 5 });
      useCommandPaletteStore.getState().moveSelection(1, 5);
      expect(useCommandPaletteStore.getState().selectedIndex).toBe(0);
    });

    it('wraps to end before 0', () => {
      useCommandPaletteStore.setState({ selectedIndex: 0 });
      useCommandPaletteStore.getState().moveSelection(-1, 5);
      expect(useCommandPaletteStore.getState().selectedIndex).toBe(5);
    });
  });

  describe('recentCommands', () => {
    it('records a recent command', () => {
      useCommandPaletteStore.getState().recordRecent('cmd-1');
      expect(useCommandPaletteStore.getState().recentCommands[0].id).toBe('cmd-1');
    });

    it('moves duplicate to front', () => {
      useCommandPaletteStore.getState().recordRecent('cmd-1');
      useCommandPaletteStore.getState().recordRecent('cmd-2');
      useCommandPaletteStore.getState().recordRecent('cmd-1');
      const recents = useCommandPaletteStore.getState().recentCommands;
      expect(recents[0].id).toBe('cmd-1');
      expect(recents[1].id).toBe('cmd-2');
      expect(recents).toHaveLength(2);
    });

    it('limits to 20 recents', () => {
      for (let i = 0; i < 25; i++) {
        useCommandPaletteStore.getState().recordRecent(`cmd-${i}`);
      }
      expect(useCommandPaletteStore.getState().recentCommands).toHaveLength(20);
    });

    it('persists to localStorage', () => {
      useCommandPaletteStore.getState().recordRecent('cmd-1');
      expect(localStorage.setItem).toHaveBeenCalled();
    });

    it('checks if command is recent', () => {
      useCommandPaletteStore.getState().recordRecent('cmd-1');
      expect(useCommandPaletteStore.getState().isRecent('cmd-1')).toBe(true);
      expect(useCommandPaletteStore.getState().isRecent('cmd-2')).toBe(false);
    });
  });
});
