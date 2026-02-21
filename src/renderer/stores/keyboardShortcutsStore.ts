import { create } from 'zustand';

const OVERRIDES_KEY = 'clubhouse_keyboard_shortcut_overrides';

export interface ShortcutDefinition {
  id: string;
  label: string;
  category: string;
  defaultBinding: string;
  currentBinding: string;
}

type ShortcutOverrides = Record<string, string>;

function loadOverrides(): ShortcutOverrides {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function saveOverrides(overrides: ShortcutOverrides): void {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  } catch { /* ignore */ }
}

const DEFAULT_SHORTCUTS: Omit<ShortcutDefinition, 'currentBinding'>[] = [
  { id: 'command-palette', label: 'Command Palette', category: 'General', defaultBinding: 'Meta+K' },
  { id: 'toggle-settings', label: 'Toggle Settings', category: 'General', defaultBinding: 'Meta+Comma' },
  { id: 'switch-project-1', label: 'Switch to Project 1', category: 'Projects', defaultBinding: 'Meta+1' },
  { id: 'switch-project-2', label: 'Switch to Project 2', category: 'Projects', defaultBinding: 'Meta+2' },
  { id: 'switch-project-3', label: 'Switch to Project 3', category: 'Projects', defaultBinding: 'Meta+3' },
  { id: 'switch-project-4', label: 'Switch to Project 4', category: 'Projects', defaultBinding: 'Meta+4' },
  { id: 'switch-project-5', label: 'Switch to Project 5', category: 'Projects', defaultBinding: 'Meta+5' },
  { id: 'switch-project-6', label: 'Switch to Project 6', category: 'Projects', defaultBinding: 'Meta+6' },
  { id: 'switch-project-7', label: 'Switch to Project 7', category: 'Projects', defaultBinding: 'Meta+7' },
  { id: 'switch-project-8', label: 'Switch to Project 8', category: 'Projects', defaultBinding: 'Meta+8' },
  { id: 'switch-project-9', label: 'Switch to Project 9', category: 'Projects', defaultBinding: 'Meta+9' },
];

function buildShortcuts(overrides: ShortcutOverrides): Record<string, ShortcutDefinition> {
  const result: Record<string, ShortcutDefinition> = {};
  for (const def of DEFAULT_SHORTCUTS) {
    result[def.id] = {
      ...def,
      currentBinding: overrides[def.id] || def.defaultBinding,
    };
  }
  return result;
}

interface KeyboardShortcutsState {
  shortcuts: Record<string, ShortcutDefinition>;
  editingId: string | null;
  overrides: ShortcutOverrides;
  setBinding: (id: string, binding: string) => void;
  resetBinding: (id: string) => void;
  resetAll: () => void;
  startEditing: (id: string) => void;
  stopEditing: () => void;
  getBindingForAction: (actionId: string) => string;
}

export const useKeyboardShortcutsStore = create<KeyboardShortcutsState>((set, get) => {
  const overrides = loadOverrides();
  return {
    shortcuts: buildShortcuts(overrides),
    editingId: null,
    overrides,

    setBinding: (id, binding) => {
      const newOverrides = { ...get().overrides, [id]: binding };
      set({ overrides: newOverrides, shortcuts: buildShortcuts(newOverrides), editingId: null });
      saveOverrides(newOverrides);
    },

    resetBinding: (id) => {
      const { [id]: _, ...rest } = get().overrides;
      set({ overrides: rest, shortcuts: buildShortcuts(rest), editingId: null });
      saveOverrides(rest);
    },

    resetAll: () => {
      set({ overrides: {}, shortcuts: buildShortcuts({}), editingId: null });
      saveOverrides({});
    },

    startEditing: (id) => set({ editingId: id }),
    stopEditing: () => set({ editingId: null }),

    getBindingForAction: (actionId) => {
      const shortcut = get().shortcuts[actionId];
      return shortcut?.currentBinding || '';
    },
  };
});

/**
 * Format a binding string for display (e.g., "Meta+K" -> "Cmd+K" on macOS, "Ctrl+K" on other platforms)
 */
export function formatBinding(binding: string): string {
  const isMac = typeof window !== 'undefined' && window.clubhouse?.platform === 'darwin';
  if (isMac) {
    return binding.replace(/Meta/g, '\u2318').replace(/Shift/g, '\u21E7').replace(/Alt/g, '\u2325');
  }
  return binding.replace(/Meta/g, 'Ctrl');
}

/**
 * Convert a KeyboardEvent into a binding string (e.g., "Meta+K")
 */
export function eventToBinding(e: KeyboardEvent): string | null {
  // Ignore modifier-only keypresses
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null;

  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('Meta');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');

  // Normalize key
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();

  parts.push(key);
  return parts.join('+');
}
