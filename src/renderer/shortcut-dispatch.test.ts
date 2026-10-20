import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleShortcutKeydown } from './shortcut-dispatch';
import { EDITING_KEYS, KEY_PLATFORMS, type KeyPlatform } from './editing-keys';
import { chordEventInit } from './editing-keys.testing';
import { eventToBinding } from './stores/keyboardShortcutsStore';
import { pluginHotkeyRegistry } from './plugins/plugin-hotkeys';
import { useCommandPaletteStore } from './stores/commandPaletteStore';

const originalPlatform = window.clubhouse.platform;
const setPlatform = (p: KeyPlatform) => { (window.clubhouse as { platform: string }).platform = p; };

/** Dispatches the chord at `target` through the shortcut handler; true when something took the key. */
function press(chord: string, target: HTMLElement, extra: KeyboardEventInit = {}): boolean {
  const e = new KeyboardEvent('keydown', { ...chordEventInit(chord), ...extra });
  Object.defineProperty(e, 'target', { value: target });
  handleShortcutKeydown(e);
  return e.defaultPrevented;
}

describe('handleShortcutKeydown in text inputs (#2314)', () => {
  let textarea: HTMLTextAreaElement;
  let button: HTMLButtonElement;

  beforeEach(() => {
    textarea = document.body.appendChild(document.createElement('textarea'));
    button = document.body.appendChild(document.createElement('button'));
    pluginHotkeyRegistry.clear();
    useCommandPaletteStore.setState({ isOpen: false });
  });
  afterEach(() => {
    textarea.remove();
    button.remove();
    pluginHotkeyRegistry.clear();
    setPlatform(originalPlatform as KeyPlatform);
  });

  it.each(KEY_PLATFORMS)('no global binding takes an editing key in a textarea on %s', (platform) => {
    setPlatform(platform);
    const taken: string[] = [];
    for (const chord of EDITING_KEYS[platform]) {
      const binding = eventToBinding(new KeyboardEvent('keydown', chordEventInit(chord)))!;
      // A plugin claims exactly this key, globally. (A system shortcut on it keeps the plugin unbound.)
      pluginHotkeyRegistry.clear();
      useCommandPaletteStore.setState({ isOpen: false });
      const handler = vi.fn();
      pluginHotkeyRegistry.register('probe', 'probe', 'Probe', handler, binding, { global: true });
      const fired = press(chord, textarea) || handler.mock.calls.length > 0 || useCommandPaletteStore.getState().isOpen;
      if (fired) taken.push(chord);
      // Outside a text input the same binding still works, so the probe was live.
      if (pluginHotkeyRegistry.getBinding('probe', 'probe') === binding) {
        expect(press(chord, button)).toBe(true);
      }
    }
    expect(taken).toEqual([]);
  });

  it('keeps mac Ctrl+K (kill to end of line) from opening the command palette', () => {
    setPlatform('darwin');
    expect(press('Ctrl+K', textarea)).toBe(false);
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    expect(press('Meta+K', textarea)).toBe(true);
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
  });

  it('lets a global shortcut on a non-editing chord fire while typing', () => {
    setPlatform('win32');
    const handler = vi.fn();
    pluginHotkeyRegistry.register('review', 'review-next', 'Next Agent', handler, 'Meta+Alt+ArrowRight', { global: true });
    expect(press('Ctrl+Alt+ArrowRight', textarea)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // #2329: Czech AltGr+D types 'Đ' as Ctrl+Alt+D, which is toggle-agent-details (Meta+Alt+D, global).
  it('types AltGr+D in a textarea on Windows instead of toggling agent details', async () => {
    setPlatform('win32');
    const { useAgentDetailsStore } = await import('./features/agents/details/detailsStore');
    const toggle = vi.spyOn(useAgentDetailsStore.getState(), 'toggle');
    const altGr = new KeyboardEvent('keydown', { key: 'Đ', code: 'KeyD', ctrlKey: true, altKey: true, cancelable: true });
    expect(eventToBinding(altGr)).toBe('Meta+Alt+D');
    Object.defineProperty(altGr, 'target', { value: textarea });
    handleShortcutKeydown(altGr);
    expect(altGr.defaultPrevented).toBe(false);
    expect(toggle).not.toHaveBeenCalled();
    // Ctrl+Alt+D itself still toggles while typing.
    expect(press('Ctrl+Alt+D', textarea)).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
    toggle.mockRestore();
  });

  it('leaves AltGr characters to the input on Windows', () => {
    setPlatform('win32');
    const handler = vi.fn();
    pluginHotkeyRegistry.register('files', 'close-tab', 'Close Active Tab', handler, 'Meta+Alt+W', { global: true });
    const altGr = new KeyboardEvent('keydown', { key: '|', code: 'KeyW', ctrlKey: true, altKey: true, cancelable: true });
    Object.defineProperty(altGr, 'target', { value: textarea });
    Object.defineProperty(altGr, 'getModifierState', { value: (k: string) => k === 'AltGraph' });
    handleShortcutKeydown(altGr);
    expect(altGr.defaultPrevented).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
