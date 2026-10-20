/**
 * Standard text-editing keys, per platform (#2314). While focus is in a text
 * input, these belong to the input: no app or plugin shortcut may take them,
 * global or not.
 *
 * Chords are physical: `Meta` is Cmd on macOS (the Windows key elsewhere) and
 * `Ctrl` is the Control key. Bindings can't tell these apart on macOS
 * (`eventToBinding` writes both as `Meta`), so the guard reads the event.
 */

export type KeyPlatform = 'darwin' | 'win32' | 'linux';

export const KEY_PLATFORMS: readonly KeyPlatform[] = ['darwin', 'win32', 'linux'];

export function keyPlatform(platform = typeof window !== 'undefined' ? window.clubhouse?.platform : undefined): KeyPlatform {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

/** Each chord, plus its Shift variant (which extends the selection). */
function withShift(chords: string[]): string[] {
  return chords.flatMap((c) => {
    const at = c.lastIndexOf('+');
    return [c, at < 0 ? `Shift+${c}` : `${c.slice(0, at)}+Shift+${c.slice(at + 1)}`];
  });
}

const prefixed = (mods: string[], keys: string[]) => mods.flatMap((m) => keys.map((k) => (m ? `${m}+${k}` : k)));

const MAC_EDITING = [
  // Caret by character, word (Option), line and document (Cmd); Home/End/Page scroll.
  ...withShift(prefixed(['', 'Alt', 'Meta'], ARROWS)),
  ...withShift(['Home', 'End', 'PageUp', 'PageDown']),
  // Emacs bindings in every Cocoa text field: line start/end, char and line moves, kill and yank.
  ...withShift(['Ctrl+A', 'Ctrl+E', 'Ctrl+B', 'Ctrl+F', 'Ctrl+N', 'Ctrl+P']),
  'Ctrl+D', 'Ctrl+H', 'Ctrl+K', 'Ctrl+O', 'Ctrl+T', 'Ctrl+V', 'Ctrl+Y',
  // Delete by character, word and line.
  ...prefixed(['', 'Alt', 'Meta'], ['Backspace', 'Delete']),
  // Clipboard, select all, undo and redo.
  'Meta+A', 'Meta+C', 'Meta+V', 'Meta+X', 'Meta+Z', 'Meta+Shift+Z', 'Meta+Alt+Shift+V',
  // Newlines: Shift and Option both give a soft return.
  'Enter', 'Shift+Enter', 'Alt+Enter',
];

const PC_EDITING = [
  // Caret by character and word (Ctrl); line (Home/End) and document (Ctrl+Home/End).
  ...withShift(prefixed(['', 'Ctrl'], ARROWS)),
  ...withShift(prefixed(['', 'Ctrl'], ['Home', 'End'])),
  ...withShift(['PageUp', 'PageDown']),
  // Delete by character and word.
  ...prefixed(['', 'Ctrl'], ['Backspace', 'Delete']),
  'Shift+Backspace',
  // Clipboard, select all, undo and redo, including the Insert-key forms.
  'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+Shift+V',
  'Ctrl+Insert', 'Shift+Insert', 'Shift+Delete',
  // Newlines: Shift and Alt both give a soft return.
  'Enter', 'Shift+Enter', 'Alt+Enter',
];

export const EDITING_KEYS: Readonly<Record<KeyPlatform, ReadonlySet<string>>> = {
  darwin: new Set(MAC_EDITING),
  win32: new Set(PC_EDITING),
  linux: new Set(PC_EDITING),
};

export interface ChordEvent {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
}

/** The physical chord for an event, in the form EDITING_KEYS uses ("Meta+Ctrl+Alt+Shift+Key"). */
export function eventChord(e: ChordEvent): string {
  let key = e.key;
  // Option changes the character (Option+K is '˚'); take the letter from the physical key.
  if (e.altKey && /^Key[A-Z]$/.test(e.code ?? '')) key = e.code!.slice(3);
  else if (key.length === 1) key = key.toUpperCase();
  const parts: string[] = [];
  if (e.metaKey) parts.push('Meta');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/**
 * Windows reports AltGr as Ctrl+Alt, so AltGr typing a character reads as a
 * Ctrl+Alt chord (#2329): Czech AltGr+D types 'Đ' as Ctrl+Alt+D, Hungarian
 * AltGr+W types '|' as Ctrl+Alt+W. It's typing when the key is a printable
 * character other than the physical key's own letter or digit. Off macOS only:
 * there Ctrl+Option types nothing, and Cmd+Option chords are Cmd's.
 */
function isAltGrCharacter(e: ChordEvent, platform: KeyPlatform): boolean {
  if (platform === 'darwin' || !e.ctrlKey || !e.altKey || e.metaKey) return false;
  if ([...e.key].length !== 1 || /\s/.test(e.key)) return false;
  const base = /^Key([A-Z])$/.exec(e.code ?? '')?.[1] ?? /^Digit([0-9])$/.exec(e.code ?? '')?.[1];
  return base === undefined || e.key.toUpperCase() !== base;
}

/**
 * True when the key belongs to text editing on this platform: an editing
 * chord, an IME composition keystroke, or AltGr typing a character.
 */
export function isEditingKeyEvent(e: ChordEvent, platform: KeyPlatform = keyPlatform()): boolean {
  if (e.isComposing || e.keyCode === 229) return true;
  if (e.getModifierState?.('AltGraph') || isAltGrCharacter(e, platform)) return true;
  return EDITING_KEYS[platform].has(eventChord(e));
}

/** Text inputs: input, textarea, contenteditable, and Monaco. xterm's helper textarea counts too. */
export function isTextInputTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true ||
    el.closest?.('[contenteditable]') != null || el.closest?.('.monaco-editor') != null;
}

/**
 * The chord a user presses for a binding on a platform: `Meta` in a binding is
 * Cmd on macOS and Ctrl elsewhere.
 */
export function bindingChord(binding: string, platform: KeyPlatform): string {
  const parts = binding.split('+');
  const key = parts.pop()!;
  const mods = new Set(parts);
  const out: string[] = [];
  if (mods.has('Meta') && platform === 'darwin') out.push('Meta');
  if (mods.has('Meta') && platform !== 'darwin') out.push('Ctrl');
  if (mods.has('Alt')) out.push('Alt');
  if (mods.has('Shift')) out.push('Shift');
  out.push(key);
  return out.join('+');
}

/** True when pressing this binding on the platform would be an editing key. */
export function bindingClaimsEditingKey(binding: string, platform: KeyPlatform): boolean {
  return !!binding && EDITING_KEYS[platform].has(bindingChord(binding, platform));
}
