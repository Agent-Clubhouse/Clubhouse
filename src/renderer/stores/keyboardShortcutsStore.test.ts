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

import { useKeyboardShortcutsStore, formatBinding, eventToBinding } from './keyboardShortcutsStore';

describe('keyboardShortcutsStore', () => {
  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key];
    useKeyboardShortcutsStore.setState({
      shortcuts: useKeyboardShortcutsStore.getState().shortcuts,
      editingId: null,
      overrides: {},
    });
    // Re-initialize with empty overrides
    useKeyboardShortcutsStore.getState().resetAll();
  });

  it('has default shortcuts loaded', () => {
    const { shortcuts } = useKeyboardShortcutsStore.getState();
    expect(shortcuts['command-palette']).toBeDefined();
    expect(shortcuts['command-palette'].defaultBinding).toBe('Meta+K');
    expect(shortcuts['command-palette'].currentBinding).toBe('Meta+K');
  });

  it('has toggle-settings with comma binding (not Comma)', () => {
    const { shortcuts } = useKeyboardShortcutsStore.getState();
    expect(shortcuts['toggle-settings'].defaultBinding).toBe('Meta+,');
  });

  it('has switch-agent-1..9 defaults', () => {
    const { shortcuts } = useKeyboardShortcutsStore.getState();
    for (let i = 1; i <= 9; i++) {
      expect(shortcuts[`switch-agent-${i}`]).toBeDefined();
      expect(shortcuts[`switch-agent-${i}`].defaultBinding).toBe(`Meta+${i}`);
      expect(shortcuts[`switch-agent-${i}`].category).toBe('Agents');
    }
  });

  it('has switch-project-1..9 with Shift modifier', () => {
    const { shortcuts } = useKeyboardShortcutsStore.getState();
    for (let i = 1; i <= 9; i++) {
      expect(shortcuts[`switch-project-${i}`]).toBeDefined();
      expect(shortcuts[`switch-project-${i}`].defaultBinding).toBe(`Meta+Shift+${i}`);
      expect(shortcuts[`switch-project-${i}`].category).toBe('Projects');
    }
  });

  it('has all new shortcuts defined', () => {
    const { shortcuts } = useKeyboardShortcutsStore.getState();
    expect(shortcuts['toggle-help']).toBeDefined();
    expect(shortcuts['toggle-help'].defaultBinding).toBe('Meta+Shift+/');
    expect(shortcuts['go-home']).toBeDefined();
    expect(shortcuts['go-home'].defaultBinding).toBe('Meta+Shift+H');
    expect(shortcuts['toggle-sidebar']).toBeDefined();
    expect(shortcuts['toggle-sidebar'].defaultBinding).toBe('Meta+B');
    expect(shortcuts['toggle-accessory']).toBeDefined();
    expect(shortcuts['toggle-accessory'].defaultBinding).toBe('Meta+Shift+B');
    expect(shortcuts['new-quick-agent']).toBeDefined();
    expect(shortcuts['new-quick-agent'].defaultBinding).toBe('Meta+Shift+N');
    expect(shortcuts['add-project']).toBeDefined();
    expect(shortcuts['add-project'].defaultBinding).toBe('Meta+Shift+O');
  });

  it('sets a custom binding', () => {
    useKeyboardShortcutsStore.getState().setBinding('command-palette', 'Meta+P');
    const shortcut = useKeyboardShortcutsStore.getState().shortcuts['command-palette'];
    expect(shortcut.currentBinding).toBe('Meta+P');
    expect(shortcut.defaultBinding).toBe('Meta+K');
  });

  it('persists overrides to localStorage', () => {
    useKeyboardShortcutsStore.getState().setBinding('command-palette', 'Meta+P');
    expect(localStorage.setItem).toHaveBeenCalled();
  });

  it('resets a single binding', () => {
    useKeyboardShortcutsStore.getState().setBinding('command-palette', 'Meta+P');
    useKeyboardShortcutsStore.getState().resetBinding('command-palette');
    const shortcut = useKeyboardShortcutsStore.getState().shortcuts['command-palette'];
    expect(shortcut.currentBinding).toBe('Meta+K');
  });

  it('resets all bindings', () => {
    useKeyboardShortcutsStore.getState().setBinding('command-palette', 'Meta+P');
    useKeyboardShortcutsStore.getState().setBinding('toggle-settings', 'Meta+S');
    useKeyboardShortcutsStore.getState().resetAll();
    const { shortcuts } = useKeyboardShortcutsStore.getState();
    expect(shortcuts['command-palette'].currentBinding).toBe('Meta+K');
    expect(shortcuts['toggle-settings'].currentBinding).toBe('Meta+,');
  });

  it('manages editing state', () => {
    useKeyboardShortcutsStore.getState().startEditing('command-palette');
    expect(useKeyboardShortcutsStore.getState().editingId).toBe('command-palette');
    useKeyboardShortcutsStore.getState().stopEditing();
    expect(useKeyboardShortcutsStore.getState().editingId).toBeNull();
  });

  it('stops editing after setBinding', () => {
    useKeyboardShortcutsStore.getState().startEditing('command-palette');
    useKeyboardShortcutsStore.getState().setBinding('command-palette', 'Meta+P');
    expect(useKeyboardShortcutsStore.getState().editingId).toBeNull();
  });

  it('returns binding for action', () => {
    const binding = useKeyboardShortcutsStore.getState().getBindingForAction('command-palette');
    expect(binding).toBe('Meta+K');
  });

  it('returns empty string for unknown action', () => {
    const binding = useKeyboardShortcutsStore.getState().getBindingForAction('nonexistent');
    expect(binding).toBe('');
  });
});

describe('formatBinding', () => {
  it('replaces Meta with command symbol on macOS', () => {
    // window.clubhouse.platform is 'darwin' in our mock
    expect(formatBinding('Meta+K')).toBe('\u2318+K');
  });

  it('replaces Shift with shift symbol on macOS', () => {
    expect(formatBinding('Meta+Shift+P')).toBe('\u2318+\u21E7+P');
  });
});

describe('eventToBinding', () => {
  const makeEvent = (overrides: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '', ...overrides } as KeyboardEvent);

  it('returns null for modifier-only keys', () => {
    expect(eventToBinding(makeEvent({ key: 'Meta', metaKey: true }))).toBeNull();
    expect(eventToBinding(makeEvent({ key: 'Shift', shiftKey: true }))).toBeNull();
  });

  it('converts Meta+K', () => {
    expect(eventToBinding(makeEvent({ key: 'k', metaKey: true }))).toBe('Meta+K');
  });

  it('converts Ctrl+K (as Meta)', () => {
    expect(eventToBinding(makeEvent({ key: 'k', ctrlKey: true }))).toBe('Meta+K');
  });

  it('converts Meta+Shift+P', () => {
    expect(eventToBinding(makeEvent({ key: 'p', metaKey: true, shiftKey: true }))).toBe('Meta+Shift+P');
  });

  it('converts space key', () => {
    expect(eventToBinding(makeEvent({ key: ' ', metaKey: true }))).toBe('Meta+Space');
  });

  it('converts comma key', () => {
    expect(eventToBinding(makeEvent({ key: ',', metaKey: true }))).toBe('Meta+,');
  });

  it('uppercases single letter keys', () => {
    expect(eventToBinding(makeEvent({ key: 'a', metaKey: true }))).toBe('Meta+A');
  });

  // Shifted-digit normalization tests
  it('normalizes Cmd+Shift+! to Meta+Shift+1 (macOS shifted digit)', () => {
    expect(eventToBinding(makeEvent({ key: '!', metaKey: true, shiftKey: true }))).toBe('Meta+Shift+1');
  });

  it('normalizes Cmd+Shift+@ to Meta+Shift+2', () => {
    expect(eventToBinding(makeEvent({ key: '@', metaKey: true, shiftKey: true }))).toBe('Meta+Shift+2');
  });

  it('normalizes Cmd+Shift+# to Meta+Shift+3', () => {
    expect(eventToBinding(makeEvent({ key: '#', metaKey: true, shiftKey: true }))).toBe('Meta+Shift+3');
  });

  it('normalizes all shifted digits', () => {
    const map: Record<string, string> = { '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9' };
    for (const [symbol, digit] of Object.entries(map)) {
      expect(eventToBinding(makeEvent({ key: symbol, metaKey: true, shiftKey: true }))).toBe(`Meta+Shift+${digit}`);
    }
  });

  it('does not normalize shifted symbols when Shift is not held', () => {
    // Without shiftKey, '!' should become Meta+! (uppercased is same)
    expect(eventToBinding(makeEvent({ key: '!', metaKey: true }))).toBe('Meta+!');
  });
});
