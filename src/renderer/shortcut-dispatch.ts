import { useKeyboardShortcutsStore, eventToBinding } from './stores/keyboardShortcutsStore';
import { useCommandPaletteStore } from './stores/commandPaletteStore';
import { getCommandActions } from './features/command-palette/command-actions';
import { pluginHotkeyRegistry } from './plugins/plugin-hotkeys';
import { isEditingKeyEvent, isTextInputTarget, keyPlatform } from './editing-keys';

/** The window keydown handler for app and plugin shortcuts. */
export function handleShortcutKeydown(e: KeyboardEvent): void {
  // Skip if recording a new binding in settings
  if (useKeyboardShortcutsStore.getState().editingId) return;

  const binding = eventToBinding(e);
  if (!binding) return;

  const isTextInput = isTextInputTarget(e.target);
  // Editing keys in a text input belong to the input, even for global shortcuts (#2314).
  if (isTextInput && isEditingKeyEvent(e, keyPlatform())) return;

  // Find matching system shortcut
  const { shortcuts } = useKeyboardShortcutsStore.getState();
  const matched = Object.values(shortcuts).find((s) => s.currentBinding === binding);

  if (matched) {
    const actions = getCommandActions();
    const action = actions.find((a) => a.id === matched.id);
    if (!action) return;

    // Guard: skip non-global shortcuts when focus is in a text input
    if (isTextInput && !action.global) return;
    // Guard: skip non-palette shortcuts when palette is open
    if (useCommandPaletteStore.getState().isOpen && matched.id !== 'command-palette') return;

    e.preventDefault();
    action.execute();
    return;
  }

  // Check plugin hotkeys (system shortcuts take priority — first claimer wins)
  const pluginShortcut = pluginHotkeyRegistry.findByBinding(binding);
  if (pluginShortcut) {
    if (isTextInput && !pluginShortcut.global) return;
    if (useCommandPaletteStore.getState().isOpen) return;

    e.preventDefault();
    pluginShortcut.handler();
  }
}
