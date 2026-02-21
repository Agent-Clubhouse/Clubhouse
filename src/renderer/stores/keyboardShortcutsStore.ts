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

/**
 * Map from shifted symbol (macOS Cmd+Shift+1 fires '!') to the underlying digit.
 */
const SHIFTED_DIGIT_MAP: Record<string, string> = {
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
};

function loadOverrides(): ShortcutOverrides {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (raw) {
      const parsed: ShortcutOverrides = JSON.parse(raw);
      // Migrate legacy "Comma" → "," in stored overrides
      let migrated = false;
      for (const [id, binding] of Object.entries(parsed)) {
        if (binding.includes('Comma')) {
          parsed[id] = binding.replace('Comma', ',');
          migrated = true;
        }
      }
      if (migrated) {
        try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(parsed)); } catch { /* ignore */ }
      }
      return parsed;
    }
  } catch { /* ignore */ }
  return {};
}

function saveOverrides(overrides: ShortcutOverrides): void {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  } catch { /* ignore */ }
}

const DEFAULT_SHORTCUTS: Omit<ShortcutDefinition, 'currentBinding'>[] = [
  // General
  { id: 'command-palette', label: 'Command Palette', category: 'General', defaultBinding: 'Meta+K' },
  { id: 'toggle-settings', label: 'Toggle Settings', category: 'General', defaultBinding: 'Meta+,' },
  { id: 'toggle-help', label: 'Toggle Help', category: 'General', defaultBinding: 'Meta+Shift+/' },

  // Navigation
  { id: 'go-home', label: 'Go to Home', category: 'Navigation', defaultBinding: 'Meta+Shift+H' },

  // Panels
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', category: 'Panels', defaultBinding: 'Meta+B' },
  { id: 'toggle-accessory', label: 'Toggle Accessory Panel', category: 'Panels', defaultBinding: 'Meta+Shift+B' },

  // Agents
  { id: 'new-quick-agent', label: 'New Quick Agent', category: 'Agents', defaultBinding: 'Meta+Shift+N' },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `switch-agent-${i + 1}`,
    label: `Switch to Agent ${i + 1}`,
    category: 'Agents',
    defaultBinding: `Meta+${i + 1}`,
  })),

  // Projects
  { id: 'add-project', label: 'Add Project', category: 'Projects', defaultBinding: 'Meta+Shift+O' },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `switch-project-${i + 1}`,
    label: `Switch to Project ${i + 1}`,
    category: 'Projects',
    defaultBinding: `Meta+Shift+${i + 1}`,
  })),
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
 * Convert a KeyboardEvent into a binding string (e.g., "Meta+K").
 * Normalizes macOS shifted-digit symbols (Cmd+Shift+1 fires '!' on macOS) back to the digit.
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

  // On macOS, Cmd+Shift+1 fires key='!' instead of '1'. Map shifted symbols back to digits.
  if (e.shiftKey && SHIFTED_DIGIT_MAP[key]) {
    key = SHIFTED_DIGIT_MAP[key];
  }

  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();

  parts.push(key);
  return parts.join('+');
}
