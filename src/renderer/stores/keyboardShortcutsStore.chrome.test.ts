import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useKeyboardShortcutsStore, buildShortcuts, seedChromeOverrides, CHROME_SHORTCUTS, LEGACY_SHORTCUTS } from './keyboardShortcutsStore';
import { useChromeFlagStore } from '../chrome/chromeFlag';
import { CHROME_STORAGE_KEY } from '../chrome/storageKey';

/** Shortcut migration for the new shell (docs/chrome-redesign-spec.md §5.3). */

const LEGACY_KEY = 'clubhouse_keyboard_shortcut_overrides';
const store = () => useKeyboardShortcutsStore.getState();
const chromeShortcuts = () => JSON.parse(localStorage.getItem(CHROME_STORAGE_KEY) ?? '{}').shortcuts;

function useShell(chrome: boolean) {
  useChromeFlagStore.setState({ enabled: chrome });
  store().reload();
}

beforeEach(() => localStorage.clear());
afterEach(() => useShell(false));

describe('new-shell shortcuts', () => {
  it('uses the new set with no overrides: ⌘1–9 for tabs, ⌥⌘1–9 for agents, no retired ids', () => {
    useShell(true);
    const { shortcuts } = store();
    expect(shortcuts['tab-1']).toMatchObject({ currentBinding: 'Meta+1', label: 'Agents Tab' });
    expect(shortcuts['switch-agent-1'].currentBinding).toBe('Meta+Alt+1');
    expect(shortcuts['command-palette'].currentBinding).toBe('Meta+K');
    expect(shortcuts['go-home']).toBeUndefined();
    expect(shortcuts['switch-project-1']).toBeUndefined();
    expect(shortcuts['toggle-accessory']).toBeUndefined();
    expect(chromeShortcuts()).toEqual({ version: 1, overrides: {} });
  });

  it('seeds shared and switch-agent overrides once, never retired ids, and never writes the legacy key', () => {
    const legacy = JSON.stringify({
      'command-palette': 'Meta+P',
      'switch-agent-2': 'Meta+Shift+2',
      'go-home': 'Meta+H',
      'switch-project-1': 'Meta+Alt+P',
      'toggle-accessory': 'Meta+J',
    });
    localStorage.setItem(LEGACY_KEY, legacy);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    useShell(true);
    expect(store().overrides).toEqual({ 'command-palette': 'Meta+P', 'switch-agent-2': 'Meta+Shift+2' });
    expect(store().shortcuts['command-palette'].currentBinding).toBe('Meta+P');
    expect(chromeShortcuts().overrides).toEqual({ 'command-palette': 'Meta+P', 'switch-agent-2': 'Meta+Shift+2' });
    expect(setItem.mock.calls.some(([key]) => key === LEGACY_KEY)).toBe(false);
    expect(localStorage.getItem(LEGACY_KEY)).toBe(legacy);
    setItem.mockRestore();

    // Later legacy changes don't reseed.
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ 'command-palette': 'Meta+L' }));
    store().reload();
    expect(store().shortcuts['command-palette'].currentBinding).toBe('Meta+P');
  });

  it('lets a user binding win over a new default, leaving that action unbound', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ 'toggle-help': 'Meta+1' }));
    useShell(true);
    expect(store().shortcuts['toggle-help'].currentBinding).toBe('Meta+1');
    expect(store().shortcuts['tab-1']).toMatchObject({ currentBinding: '', conflictWith: 'toggle-help' });
    // Resetting the user binding gives the default back.
    store().resetBinding('toggle-help');
    expect(store().shortcuts['tab-1']).toMatchObject({ currentBinding: 'Meta+1' });
    expect(store().shortcuts['tab-1'].conflictWith).toBeUndefined();
  });

  it('saves new-shell edits under clubhouse_chrome_v2 only', () => {
    useShell(true);
    store().setBinding('tab-2', 'Meta+Shift+2');
    expect(chromeShortcuts().overrides).toEqual({ 'tab-2': 'Meta+Shift+2' });
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('round-trips with the flag off: the legacy bindings are unchanged', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ 'switch-agent-1': 'Meta+Shift+1', 'go-home': 'Meta+H' }));
    useShell(true);
    store().setBinding('command-palette', 'Meta+P');
    useShell(false);
    const { shortcuts, overrides } = store();
    expect(overrides).toEqual({ 'switch-agent-1': 'Meta+Shift+1', 'go-home': 'Meta+H' });
    expect(shortcuts['switch-agent-1'].currentBinding).toBe('Meta+Shift+1');
    expect(shortcuts['switch-agent-2'].currentBinding).toBe('Meta+2');
    expect(shortcuts['switch-project-1'].currentBinding).toBe('Meta+Alt+1');
    expect(shortcuts['command-palette'].currentBinding).toBe('Meta+K');
    expect(shortcuts['tab-1']).toBeUndefined();
  });
});

describe('buildShortcuts and seeding', () => {
  it('leaves collisions alone in the legacy set', () => {
    const built = buildShortcuts(LEGACY_SHORTCUTS, { 'toggle-help': 'Meta+1' });
    expect(built['switch-agent-1'].currentBinding).toBe('Meta+1');
    expect(built['switch-agent-1'].conflictWith).toBeUndefined();
  });

  it('seeds only ids with the same meaning in both shells', () => {
    expect(seedChromeOverrides({ 'add-project': 'a', 'switch-agent-9': 'b', 'switch-project-2': 'c', 'go-home': 'd' }))
      .toEqual({ 'add-project': 'a', 'switch-agent-9': 'b' });
  });

  it('has no duplicate defaults in the new set', () => {
    const defaults = CHROME_SHORTCUTS.map((s) => s.defaultBinding);
    expect(new Set(defaults).size).toBe(defaults.length);
  });
});
