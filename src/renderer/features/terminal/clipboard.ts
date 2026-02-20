import type { Terminal } from '@xterm/xterm';

function platformIsMac(): boolean {
  return window.clubhouse.platform === 'darwin';
}

/**
 * Read text from the system clipboard.
 * Falls back to empty string on failure (e.g. permission denied).
 */
async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

/**
 * Write text to the system clipboard.
 */
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // silently ignore clipboard write failures
  }
}

/**
 * Paste clipboard text into the terminal, respecting bracketed paste mode.
 */
async function pasteIntoTerminal(
  term: Terminal,
  writeToPty: (data: string) => void
): Promise<void> {
  const text = await readClipboard();
  if (!text) return;

  const data = term.modes.bracketedPasteMode
    ? `\x1b[200~${text}\x1b[201~`
    : text;
  writeToPty(data);
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
 * Returns a cleanup function that removes the context-menu listener.
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
  writeToPty: (data: string) => void
): () => void {
  // --- Keyboard shortcuts ---
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true;

    // Paste: Cmd+V (mac) or Ctrl+V / Ctrl+Shift+V (win/linux)
    if (isPaste(e)) {
      pasteIntoTerminal(term, writeToPty);
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
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    if (term.hasSelection()) {
      writeClipboard(term.getSelection());
      term.clearSelection();
    } else {
      pasteIntoTerminal(term, writeToPty);
    }
  };
  container.addEventListener('contextmenu', onContextMenu);

  return () => {
    container.removeEventListener('contextmenu', onContextMenu);
  };
}
