import type { Terminal } from '@xterm/xterm';

function platformIsMac(): boolean {
  return window.clubhouse.platform === 'darwin';
}

/**
 * Read text from the system clipboard.
 * Falls back to empty string on failure (e.g. permission denied).
 */
export async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

export interface ClipboardImageData {
  base64: string;
  mimeType: string;
}

/**
 * Read an image from the system clipboard as base64.
 *
 * Uses Electron's native clipboard.readImage() via IPC as the primary path
 * because navigator.clipboard.read() is unreliable for images in Electron.
 * Falls back to the web Clipboard API if the IPC bridge is unavailable.
 */
export async function readClipboardImage(): Promise<ClipboardImageData | null> {
  // Primary: Electron native clipboard (reliable for images)
  try {
    const result = await window.clubhouse.app.readClipboardImage();
    if (result) return result;
  } catch {
    // IPC bridge unavailable — fall through to web API
  }

  // Fallback: web Clipboard API
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return { base64: btoa(binary), mimeType: imageType };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write text to the system clipboard.
 */
export async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // silently ignore clipboard write failures
  }
}

/**
 * Paste clipboard text into the terminal, respecting bracketed paste mode.
 * If no text is found but an image is available and onImagePaste is provided,
 * the image will be forwarded via the callback.
 */
export async function pasteIntoTerminal(
  term: Terminal,
  writeToPty: (data: string) => void,
  onImagePaste?: (image: ClipboardImageData) => void,
): Promise<void> {
  const text = await readClipboard();
  if (text) {
    const data = term.modes.bracketedPasteMode
      ? `\x1b[200~${text}\x1b[201~`
      : text;
    writeToPty(data);
    return;
  }

  // No text — try image
  if (onImagePaste) {
    const image = await readClipboardImage();
    if (image) {
      onImagePaste(image);
    }
  }
}

/** Return true if the key event is a paste shortcut for this platform. */
function isPaste(e: KeyboardEvent): boolean {
  if (e.key !== 'v' && e.key !== 'V') return false;
  // Cmd+V on macOS, Ctrl+V or Ctrl+Shift+V on Windows/Linux
  return platformIsMac() ? e.metaKey : e.ctrlKey;
}

/** Return true if the key event is a copy shortcut for this platform. */
function isCopy(e: KeyboardEvent): boolean {
  if (e.key !== 'c' && e.key !== 'C') return false;
  // Cmd+C on macOS, Ctrl+Shift+C on Windows/Linux (Ctrl+C without shift is SIGINT)
  return platformIsMac() ? e.metaKey : (e.ctrlKey && e.shiftKey);
}

/**
 * Attach clipboard key handling and right-click context menu to a terminal.
 *
 * Returns a cleanup function that removes all listeners.
 *
 * Handles:
 * - Ctrl+V / Cmd+V — paste from clipboard
 * - Ctrl+Shift+V   — paste from clipboard (Linux/Windows alternate)
 * - Ctrl+Shift+C   — copy selection (Windows/Linux; Cmd+C on macOS)
 * - Ctrl+C (no shift, with selection on Windows/Linux) — copy selection
 * - Right-click     — paste if no selection, copy if selection exists
 */
export function attachClipboardHandlers(
  term: Terminal,
  container: HTMLElement,
  writeToPty: (data: string) => void,
  onImagePaste?: (image: ClipboardImageData) => void,
): () => void {
  // --- Suppress native paste events ---
  // On Windows/Electron, Ctrl+V fires both a keydown (handled below) and a
  // native browser `paste` event that xterm.js's internal textarea catches.
  // Since we handle paste ourselves via the keyboard shortcut, we suppress
  // the native paste event to prevent xterm from writing the clipboard text
  // a second time through onData.
  const onPaste = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  container.addEventListener('paste', onPaste, true);

  // --- Keyboard shortcuts ---
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true;

    // Paste: Cmd+V (mac) or Ctrl+V / Ctrl+Shift+V (win/linux)
    if (isPaste(e)) {
      // Ignore key-repeat events to prevent rapid repeated pastes when
      // the user holds Ctrl+V on Windows.
      if (!e.repeat) {
        pasteIntoTerminal(term, writeToPty, onImagePaste);
      }
      return false;
    }

    // Copy: Cmd+C (mac) or Ctrl+Shift+C (win/linux)
    if (isCopy(e)) {
      if (term.hasSelection()) {
        writeClipboard(term.getSelection());
        term.clearSelection();
      }
      return false;
    }

    // Ctrl+C without shift on Windows/Linux: copy if there's a selection,
    // otherwise let it through as SIGINT
    if (
      !platformIsMac() &&
      e.ctrlKey &&
      !e.shiftKey &&
      (e.key === 'c' || e.key === 'C') &&
      term.hasSelection()
    ) {
      writeClipboard(term.getSelection());
      term.clearSelection();
      return false;
    }

    return true;
  });

  // --- Right-click context menu ---
  // Use the capture phase so this fires before xterm.js's own contextmenu
  // handler (which focuses its hidden textarea and can trigger a second
  // native paste event on Windows/Electron).  stopPropagation prevents
  // the event from reaching xterm's handler, avoiding the double-paste.
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (term.hasSelection()) {
      writeClipboard(term.getSelection());
      term.clearSelection();
    } else {
      pasteIntoTerminal(term, writeToPty, onImagePaste);
    }
  };
  container.addEventListener('contextmenu', onContextMenu, true);

  return () => {
    container.removeEventListener('paste', onPaste, true);
    container.removeEventListener('contextmenu', onContextMenu, true);
  };
}
