import type { Disposable } from '../../shared/plugin-types';

export interface PluginShortcut {
  /** Full command ID: pluginId:commandId */
  fullCommandId: string;
  pluginId: string;
  commandId: string;
  title: string;
  defaultBinding: string;
  currentBinding: string;
  global: boolean;
  handler: (...args: unknown[]) => void | Promise<void>;
}

const PLUGIN_OVERRIDES_KEY = 'clubhouse_plugin_shortcut_overrides';

type PluginOverrides = Record<string, string>;

function loadPluginOverrides(): PluginOverrides {
  try {
    const raw = localStorage.getItem(PLUGIN_OVERRIDES_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function savePluginOverrides(overrides: PluginOverrides): void {
  try {
    localStorage.setItem(PLUGIN_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch { /* ignore */ }
}

class PluginHotkeyRegistry {
  private shortcuts = new Map<string, PluginShortcut>();
  private overrides: PluginOverrides;
  private listeners = new Set<() => void>();
  /** Cached snapshot for useSyncExternalStore — must return the same reference until data changes. */
  private cachedSnapshot: PluginShortcut[] = [];

  constructor() {
    this.overrides = loadPluginOverrides();
  }

  /**
   * Register a plugin command with a hotkey binding.
   * First-claimer wins: if the binding is already taken (by system or another plugin),
   * the new registration proceeds but with an empty binding (unbound).
   */
  register(
    pluginId: string,
    commandId: string,
    title: string,
    handler: (...args: unknown[]) => void | Promise<void>,
    defaultBinding: string,
    options?: { global?: boolean },
  ): Disposable {
    const fullCommandId = `${pluginId}:${commandId}`;

    // Determine effective binding: user override > default
    let effectiveBinding = this.overrides[fullCommandId] ?? defaultBinding;

    // Check for collision with system shortcuts
    if (effectiveBinding && this.isSystemBinding(effectiveBinding)) {
      console.warn(
        `[PluginHotkeys] Binding "${effectiveBinding}" for ${fullCommandId} collides with a system shortcut — unbound`,
      );
      effectiveBinding = '';
    }

    // Check for collision with other plugin shortcuts
    if (effectiveBinding && this.isPluginBinding(effectiveBinding, fullCommandId)) {
      console.warn(
        `[PluginHotkeys] Binding "${effectiveBinding}" for ${fullCommandId} collides with another plugin shortcut — unbound`,
      );
      effectiveBinding = '';
    }

    const shortcut: PluginShortcut = {
      fullCommandId,
      pluginId,
      commandId,
      title,
      defaultBinding,
      currentBinding: effectiveBinding,
      global: options?.global ?? false,
      handler,
    };

    this.shortcuts.set(fullCommandId, shortcut);
    this.notifyListeners();

    return {
      dispose: () => {
        this.shortcuts.delete(fullCommandId);
        this.notifyListeners();
      },
    };
  }

  /** Get binding for a plugin command. */
  getBinding(pluginId: string, commandId: string): string | null {
    const fullId = `${pluginId}:${commandId}`;
    const shortcut = this.shortcuts.get(fullId);
    return shortcut?.currentBinding || null;
  }

  /** Clear binding for a plugin command. */
  clearBinding(pluginId: string, commandId: string): void {
    const fullId = `${pluginId}:${commandId}`;
    const shortcut = this.shortcuts.get(fullId);
    if (shortcut) {
      shortcut.currentBinding = '';
      this.overrides[fullId] = '';
      savePluginOverrides(this.overrides);
      this.notifyListeners();
    }
  }

  /** Set a new binding for a plugin command. */
  setBinding(fullCommandId: string, binding: string): void {
    const shortcut = this.shortcuts.get(fullCommandId);
    if (shortcut) {
      shortcut.currentBinding = binding;
      this.overrides[fullCommandId] = binding;
      savePluginOverrides(this.overrides);
      this.notifyListeners();
    }
  }

  /** Reset a plugin shortcut to its default binding. */
  resetBinding(fullCommandId: string): void {
    const shortcut = this.shortcuts.get(fullCommandId);
    if (shortcut) {
      const { [fullCommandId]: _, ...rest } = this.overrides;
      this.overrides = rest;
      shortcut.currentBinding = shortcut.defaultBinding;
      savePluginOverrides(this.overrides);
      this.notifyListeners();
    }
  }

  /** Find a shortcut matching the given binding string. */
  findByBinding(binding: string): PluginShortcut | undefined {
    for (const shortcut of this.shortcuts.values()) {
      if (shortcut.currentBinding === binding) return shortcut;
    }
    return undefined;
  }

  /** Get all registered plugin shortcuts (returns cached snapshot for useSyncExternalStore). */
  getAll(): PluginShortcut[] {
    return this.cachedSnapshot;
  }

  /** Get all shortcuts for a specific plugin. */
  getByPlugin(pluginId: string): PluginShortcut[] {
    return Array.from(this.shortcuts.values()).filter((s) => s.pluginId === pluginId);
  }

  /** Remove all shortcuts for a specific plugin (used on deactivation). */
  clearPlugin(pluginId: string): void {
    let changed = false;
    for (const [key, shortcut] of this.shortcuts) {
      if (shortcut.pluginId === pluginId) {
        this.shortcuts.delete(key);
        changed = true;
      }
    }
    if (changed) this.notifyListeners();
  }

  /** Subscribe to changes. */
  onChange(callback: () => void): Disposable {
    this.listeners.add(callback);
    return { dispose: () => { this.listeners.delete(callback); } };
  }

  /** Clear all shortcuts (used in tests). */
  clear(): void {
    this.shortcuts.clear();
    this.notifyListeners();
  }

  // ── Private helpers ────────────────────────────────────────────────

  private isSystemBinding(binding: string): boolean {
    // Lazy import to avoid circular deps
    try {
      const { useKeyboardShortcutsStore } = require('../stores/keyboardShortcutsStore');
      const { shortcuts } = useKeyboardShortcutsStore.getState();
      return Object.values(shortcuts).some(
        (s: { currentBinding: string }) => s.currentBinding === binding,
      );
    } catch {
      return false;
    }
  }

  private isPluginBinding(binding: string, excludeFullId: string): boolean {
    for (const [key, shortcut] of this.shortcuts) {
      if (key !== excludeFullId && shortcut.currentBinding === binding) return true;
    }
    return false;
  }

  private notifyListeners(): void {
    this.cachedSnapshot = Array.from(this.shortcuts.values());
    for (const listener of this.listeners) {
      try { listener(); } catch { /* ignore */ }
    }
  }
}

export const pluginHotkeyRegistry = new PluginHotkeyRegistry();
