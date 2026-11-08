import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleShortcutKeydown } from './shortcut-dispatch';
import { buildShortcuts, CHROME_SHORTCUTS, LEGACY_SHORTCUTS, useKeyboardShortcutsStore } from './stores/keyboardShortcutsStore';
import { useChromeFlagStore } from './chrome/chromeFlag';
import { useChromeStore } from './chrome/chromeStore';
import { useQuickPromptStore } from './chrome/quickPromptStore';
import { useProjectStore } from './stores/projectStore';
import { useUIStore } from './stores/uiStore';
import { useCommandPaletteStore } from './stores/commandPaletteStore';

const originalShortcuts = useKeyboardShortcutsStore.getState().shortcuts;
const originalPlatform = window.clubhouse.platform;
function press(key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, metaKey: true, shiftKey, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  (window.clubhouse as { platform: string }).platform = 'darwin';
  useChromeFlagStore.setState({ enabled: true });
  useKeyboardShortcutsStore.setState({ shortcuts: buildShortcuts(CHROME_SHORTCUTS, {}, { resolveCollisions: true }), editingId: null });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Project', path: '/p' }] as never, activeProjectId: 'p1' });
  useUIStore.setState({ activeHostId: null, quickAgentDialogOpen: false });
  useCommandPaletteStore.setState({ isOpen: false });
  useChromeStore.setState({ newAgent: null, newAgentBusy: false });
  useQuickPromptStore.setState({ open: false });
  window.addEventListener('keydown', handleShortcutKeydown);
});
afterEach(() => {
  window.removeEventListener('keydown', handleShortcutKeydown);
  useKeyboardShortcutsStore.setState({ shortcuts: originalShortcuts });
  useChromeFlagStore.setState({ enabled: false });
  (window.clubhouse as { platform: string }).platform = originalPlatform;
});

describe('new agent shortcuts', () => {
  it('reproduces the prior definitions: Cmd+N is unbound and Cmd+Shift+N opens durable', () => {
    const prior = CHROME_SHORTCUTS.filter((s) => s.id !== 'open-quick-agent');
    useKeyboardShortcutsStore.setState({ shortcuts: buildShortcuts(prior, {}, { resolveCollisions: true }) });
    expect(press('n')).toBe(false);
    expect(useChromeStore.getState().newAgent).toBeNull();
    expect(press('N', true)).toBe(true);
    expect(useChromeStore.getState().newAgent?.kind).toBe('durable');
  });
  it('routes Cmd+N to the one-line quick prompt and Cmd+Shift+N to the durable page (#2812)', () => {
    expect(press('n')).toBe(true);
    expect(useQuickPromptStore.getState().open).toBe(true);
    expect(useChromeStore.getState().newAgent).toBeNull();
    useQuickPromptStore.setState({ open: false });
    expect(press('N', true)).toBe(true);
    expect(useChromeStore.getState().newAgent?.kind).toBe('durable');
  });
  it('routes Ctrl+N on Windows', () => {
    (window.clubhouse as { platform: string }).platform = 'win32';
    const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(useQuickPromptStore.getState().open).toBe(true);
  });
  it('honors a saved durable override that claims the quick default', () => {
    useKeyboardShortcutsStore.setState({ shortcuts: buildShortcuts(CHROME_SHORTCUTS, { 'new-quick-agent': 'Meta+N' }, { resolveCollisions: true }) });
    expect(press('n')).toBe(true);
    expect(useChromeStore.getState().newAgent?.kind).toBe('durable');
    expect(useKeyboardShortcutsStore.getState().shortcuts['open-quick-agent'].currentBinding).toBe('');
  });
  it('opens the Quick Agent dialog instead where the prompt has no local project', () => {
    useProjectStore.setState({ projects: [], activeProjectId: null });
    expect(press('n')).toBe(true);
    expect(useQuickPromptStore.getState().open).toBe(false);
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(true);
  });
  it('keeps the legacy Cmd+Shift+N quick dialog', () => {
    useChromeFlagStore.setState({ enabled: false });
    useKeyboardShortcutsStore.setState({ shortcuts: buildShortcuts(LEGACY_SHORTCUTS, {}) });
    expect(press('n')).toBe(false);
    expect(press('N', true)).toBe(true);
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(true);
  });
});
