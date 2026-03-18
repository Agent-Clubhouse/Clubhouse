/**
 * Terminal Edit Command Handler — bridges Electron menu edit commands to
 * focused terminal instances.
 *
 * When the Electron menu intercepts Cmd+V / Ctrl+V (via its accelerator),
 * the keyboard event never reaches the renderer, so xterm.js clipboard
 * handlers cannot fire.  This registry lets ShellTerminal register a
 * handler so the edit-command dispatcher in app-event-bridge.ts can route
 * paste/copy/selectAll to the correct terminal.
 */

import type { Terminal } from '@xterm/xterm';
import { pasteIntoTerminal, writeClipboard } from './clipboard';

export interface RegisteredTerminal {
  term: Terminal;
  writeToPty: (data: string) => void;
  container: HTMLElement;
}

let registered: RegisteredTerminal | null = null;

/**
 * Register a terminal as the active edit-command target.
 * Only one terminal can be registered at a time (the most-recently focused).
 */
export function registerTerminalEditHandler(entry: RegisteredTerminal): void {
  registered = entry;
}

/**
 * Unregister a terminal.  Only removes if it matches the currently registered one.
 */
export function unregisterTerminalEditHandler(entry: RegisteredTerminal): void {
  if (registered === entry) registered = null;
}

/**
 * Try to handle an edit command for the focused terminal.
 * Returns `true` if the command was consumed.
 */
export function handleTerminalEditCommand(command: string): boolean {
  if (!registered) return false;

  // Only handle when the terminal container (or a child, like xterm's
  // hidden textarea) currently has DOM focus.
  if (!registered.container.contains(document.activeElement)) return false;

  const { term, writeToPty } = registered;

  switch (command) {
    case 'paste':
      pasteIntoTerminal(term, writeToPty);
      return true;

    case 'copy':
      if (term.hasSelection()) {
        writeClipboard(term.getSelection());
        term.clearSelection();
        return true;
      }
      return false;

    case 'selectAll':
      term.selectAll();
      return true;

    default:
      return false;
  }
}
