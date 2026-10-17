import { create } from 'zustand';
import { isNewChromeEnabled } from '../chrome/chromeFlag';
import { CHROME_STORAGE_KEY } from '../chrome/storageKey';
import { reportChromeActionFailed } from '../chrome/telemetry';

/** The legacy shell's overrides. The new shell never writes it (docs/chrome-redesign-spec.md §5.3). */
const OVERRIDES_KEY = 'clubhouse_keyboard_shortcut_overrides';
const CHROME_SHORTCUTS_VERSION = 1;

export interface ShortcutDefinition {
  id: string;
  label: string;
  category: string;
  defaultBinding: string;
  /** Empty when unbound: a user binding took this action's default. */
  currentBinding: string;
  /** The action whose user binding took this one's default, if any. */
  conflictWith?: string;
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

/**
 * Map from Option-modified digit (macOS Option+1 fires '¡') to the underlying digit.
 */
const ALT_DIGIT_MAP: Record<string, string> = {
  '¡': '1',
  '™': '2',
  '£': '3',
  '¢': '4',
  '∞': '5',
  '§': '6',
  '¶': '7',
  '•': '8',
  'ª': '9',
};

/** Legacy overrides. `writeBack` saves the "Comma" → "," migration; the new shell reads without writing. */
function loadOverrides(writeBack = true): ShortcutOverrides {
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
      if (migrated && writeBack) {
        try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(parsed)); } catch { /* ignore */ }
      }
      return parsed;
    }
  } catch { /* ignore */ }
  return {};
}

/** The new shell's overrides, under `shortcuts` in clubhouse_chrome_v2. Null until first seeded. */
function loadChromeOverrides(): ShortcutOverrides | null {
  try {
    const raw = localStorage.getItem(CHROME_STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as { shortcuts?: { overrides?: unknown } } | null)?.shortcuts : undefined;
    if (!stored || typeof stored.overrides !== 'object' || stored.overrides === null) return null;
    return Object.fromEntries(
      Object.entries(stored.overrides as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch { /* ignore */ }
  return null;
}

function saveChromeOverrides(overrides: ShortcutOverrides): void {
  try {
    const raw = localStorage.getItem(CHROME_STORAGE_KEY);
    let state: Record<string, unknown> = {};
    try { state = raw ? JSON.parse(raw) ?? {} : {}; } catch { /* corrupt: chromeStore rewrites its own fields */ }
    state.shortcuts = { version: CHROME_SHORTCUTS_VERSION, overrides };
    localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[store:shortcuts] Failed to persist new-layout shortcut overrides (quota?):', err instanceof Error ? err.message : err);
    reportChromeActionFailed('shortcut_save', err);
  }
}

function saveOverrides(overrides: ShortcutOverrides): void {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  } catch { /* ignore */ }
}

type ShortcutSpec = Omit<ShortcutDefinition, 'currentBinding' | 'conflictWith'>;

const switchAgents = (binding: (n: number) => string): ShortcutSpec[] => Array.from({ length: 9 }, (_, i) => ({
  id: `switch-agent-${i + 1}`,
  label: `Switch to Agent ${i + 1}`,
  category: 'Agents',
  defaultBinding: binding(i + 1),
}));

/** The legacy shell's set, unchanged. */
export const LEGACY_SHORTCUTS: ShortcutSpec[] = [
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
  // Escape hatch for the "can scroll but can't type" xterm focus wedge: force
  // focus back to the active agent terminal without needing a mouse click
  // (clicks don't reliably refocus under Copilot CLI's mouse tracking).
  { id: 'focus-active-terminal', label: 'Focus Active Terminal', category: 'Agents', defaultBinding: 'Meta+Shift+T' },
  ...switchAgents((n) => `Meta+${n}`),

  // Projects
  { id: 'add-project', label: 'Add Project', category: 'Projects', defaultBinding: 'Meta+Shift+O' },
  { id: 'close-project', label: 'Close Project', category: 'Projects', defaultBinding: 'Meta+Shift+W' },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `switch-project-${i + 1}`,
    label: `Switch to Project ${i + 1}`,
    category: 'Projects',
    defaultBinding: `Meta+Alt+${i + 1}`,
  })),
];

/** Actions with the same id and meaning in both shells. */
const SHARED_IDS = [
  'command-palette', 'toggle-settings', 'toggle-help', 'toggle-sidebar',
  'new-quick-agent', 'focus-active-terminal', 'add-project', 'close-project',
];

/**
 * The new shell's set (spec §5.3): ⌘1–9 select title-bar tabs (⌘1 is Agents)
 * and ⌥⌘1–9 switch agents in sidebar order. No Home, accessory column or
 * project-N shortcuts.
 */
export const CHROME_SHORTCUTS: ShortcutSpec[] = [
  ...LEGACY_SHORTCUTS.filter((s) => SHARED_IDS.includes(s.id)).map((s) =>
    s.id === 'toggle-sidebar' ? { ...s, category: 'General' } : s),
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `tab-${i + 1}`,
    label: i === 0 ? 'Agents Tab' : `Tab ${i + 1}`,
    category: 'Tabs',
    defaultBinding: `Meta+${i + 1}`,
  })),
  ...switchAgents((n) => `Meta+Alt+${n}`),
];

/** Ids whose legacy overrides carry into the new shell: the shared actions and switch-agent-N. */
const SEEDABLE_IDS = new Set([...SHARED_IDS, ...Array.from({ length: 9 }, (_, i) => `switch-agent-${i + 1}`)]);

const LEGACY_DEFAULTS = new Map(LEGACY_SHORTCUTS.map((s) => [s.id, s.defaultBinding]));

/**
 * The new shell's first overrides: the legacy ones that mean the same thing
 * there. Retired ids are left out, and so is an "override" that only restates
 * the legacy default (⌘1 re-recorded for switch-agent-1), which would otherwise
 * take the new shell's ⌘1 from the Agents tab.
 */
export function seedChromeOverrides(legacy: ShortcutOverrides): ShortcutOverrides {
  return Object.fromEntries(Object.entries(legacy).filter(([id, binding]) =>
    SEEDABLE_IDS.has(id) && binding !== LEGACY_DEFAULTS.get(id)));
}

/**
 * Resolve each action's binding. With `resolveCollisions` (the new shell), a
 * user binding that equals another action's default wins: that action is left
 * unbound and records the conflict for Settings (spec §5.3).
 */
export function buildShortcuts(
  definitions: ShortcutSpec[],
  overrides: ShortcutOverrides,
  { resolveCollisions = false }: { resolveCollisions?: boolean } = {},
): Record<string, ShortcutDefinition> {
  const takenBy = new Map<string, string>();
  if (resolveCollisions) {
    for (const def of definitions) if (overrides[def.id]) takenBy.set(overrides[def.id], def.id);
  }
  const result: Record<string, ShortcutDefinition> = {};
  for (const def of definitions) {
    const override = overrides[def.id];
    const owner = !override ? takenBy.get(def.defaultBinding) : undefined;
    result[def.id] = owner && owner !== def.id
      ? { ...def, currentBinding: '', conflictWith: owner }
      : { ...def, currentBinding: override || def.defaultBinding };
  }
  return result;
}

/** The active shell's definitions and overrides; the new shell seeds its own on first run. */
function loadForActiveShell(): { definitions: ShortcutSpec[]; overrides: ShortcutOverrides; chrome: boolean } {
  if (!isNewChromeEnabled()) return { definitions: LEGACY_SHORTCUTS, overrides: loadOverrides(), chrome: false };
  let overrides = loadChromeOverrides();
  if (overrides === null) {
    overrides = seedChromeOverrides(loadOverrides(false));
    saveChromeOverrides(overrides);
  }
  return { definitions: CHROME_SHORTCUTS, overrides, chrome: true };
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
  // Each shell edits its own set and storage (spec §5.3); the layout is fixed per session.
  const shell = loadForActiveShell();
  const build = (overrides: ShortcutOverrides) => buildShortcuts(shell.definitions, overrides, { resolveCollisions: shell.chrome });
  const save = (overrides: ShortcutOverrides) => (shell.chrome ? saveChromeOverrides(overrides) : saveOverrides(overrides));
  return {
    shortcuts: build(shell.overrides),
    editingId: null,
    overrides: shell.overrides,

    setBinding: (id, binding) => {
      const newOverrides = { ...get().overrides, [id]: binding };
      set({ overrides: newOverrides, shortcuts: build(newOverrides), editingId: null });
      save(newOverrides);
    },

    resetBinding: (id) => {
      const { [id]: _, ...rest } = get().overrides;
      set({ overrides: rest, shortcuts: build(rest), editingId: null });
      save(rest);
    },

    resetAll: () => {
      set({ overrides: {}, shortcuts: build({}), editingId: null });
      save({});
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

  // On macOS, Option+1 fires key='¡' instead of '1'. Map alt-modified symbols back to digits.
  if (e.altKey && ALT_DIGIT_MAP[key]) {
    key = ALT_DIGIT_MAP[key];
  }

  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();

  parts.push(key);
  return parts.join('+');
}
