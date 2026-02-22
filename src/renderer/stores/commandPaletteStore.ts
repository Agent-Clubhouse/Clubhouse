import { create } from 'zustand';

const RECENTS_KEY = 'clubhouse_command_palette_recents';
const MAX_RECENTS = 20;

export type PaletteMode = 'all' | 'commands' | 'agents' | 'projects';

interface RecentCommand {
  id: string;
  timestamp: number;
}

function loadRecents(): RecentCommand[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveRecents(recents: RecentCommand[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch { /* ignore */ }
}

function deriveMode(query: string): PaletteMode {
  if (query.startsWith('>')) return 'commands';
  if (query.startsWith('@')) return 'agents';
  if (query.startsWith('#')) return 'projects';
  return 'all';
}

export type InteractionSource = 'keyboard' | 'pointer';

interface CommandPaletteState {
  isOpen: boolean;
  query: string;
  mode: PaletteMode;
  selectedIndex: number;
  lastInteraction: InteractionSource;
  recentCommands: RecentCommand[];
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  moveSelection: (delta: number, maxIndex: number) => void;
  setSelectedIndex: (index: number) => void;
  recordRecent: (commandId: string) => void;
  isRecent: (commandId: string) => boolean;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set, get) => ({
  isOpen: false,
  query: '',
  mode: 'all',
  selectedIndex: 0,
  lastInteraction: 'keyboard' as InteractionSource,
  recentCommands: loadRecents(),

  open: () => set({ isOpen: true, query: '', mode: 'all', selectedIndex: 0, lastInteraction: 'keyboard' }),
  close: () => set({ isOpen: false, query: '', mode: 'all', selectedIndex: 0, lastInteraction: 'keyboard' }),
  toggle: () => {
    const { isOpen } = get();
    if (isOpen) {
      get().close();
    } else {
      get().open();
    }
  },

  setQuery: (query) => {
    set({ query, mode: deriveMode(query), selectedIndex: 0 });
  },

  moveSelection: (delta, maxIndex) => {
    set((s) => {
      const next = s.selectedIndex + delta;
      if (next < 0) return { selectedIndex: maxIndex, lastInteraction: 'keyboard' };
      if (next > maxIndex) return { selectedIndex: 0, lastInteraction: 'keyboard' };
      return { selectedIndex: next, lastInteraction: 'keyboard' };
    });
  },

  setSelectedIndex: (index) => {
    set({ selectedIndex: index, lastInteraction: 'pointer' });
  },

  recordRecent: (commandId) => {
    const recents = get().recentCommands.filter((r) => r.id !== commandId);
    recents.unshift({ id: commandId, timestamp: Date.now() });
    const trimmed = recents.slice(0, MAX_RECENTS);
    set({ recentCommands: trimmed });
    saveRecents(trimmed);
  },

  isRecent: (commandId) => {
    return get().recentCommands.some((r) => r.id === commandId);
  },
}));
