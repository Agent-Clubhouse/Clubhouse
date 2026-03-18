import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerTerminalEditHandler,
  unregisterTerminalEditHandler,
  handleTerminalEditCommand,
} from './terminal-edit-handler';
import type { RegisteredTerminal } from './terminal-edit-handler';

// --- Clipboard mocks ---

const clipboardReadText = vi.fn<() => Promise<string>>(async () => 'pasted text');
const clipboardWriteText = vi.fn<(text: string) => Promise<void>>(async () => {});
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { readText: clipboardReadText, writeText: clipboardWriteText },
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// --- Mock Terminal factory ---

function createMockTerminal(opts?: {
  bracketedPasteMode?: boolean;
  hasSelection?: boolean;
  selection?: string;
}) {
  return {
    modes: { bracketedPasteMode: opts?.bracketedPasteMode ?? false },
    hasSelection: vi.fn(() => opts?.hasSelection ?? false),
    getSelection: vi.fn(() => opts?.selection ?? ''),
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
  };
}

function createEntry(
  termOpts?: Parameters<typeof createMockTerminal>[0],
  focused = true,
): { entry: RegisteredTerminal; writeToPty: ReturnType<typeof vi.fn>; container: HTMLDivElement } {
  const term = createMockTerminal(termOpts);
  const writeToPty = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);

  if (focused) {
    // Simulate xterm's hidden textarea being focused inside the container
    const textarea = document.createElement('textarea');
    container.appendChild(textarea);
    textarea.focus();
  }

  const entry: RegisteredTerminal = {
    term: term as any,
    writeToPty,
    container,
  };

  return { entry, writeToPty, container };
}

describe('terminal-edit-handler', () => {
  beforeEach(() => {
    clipboardReadText.mockReset().mockResolvedValue('pasted text');
    clipboardWriteText.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up DOM
    document.body.innerHTML = '';
  });

  // ─── Registration ──────────────────────────────────────────────

  describe('registration', () => {
    it('returns false when no terminal is registered', () => {
      expect(handleTerminalEditCommand('paste')).toBe(false);
    });

    it('returns false after unregistering the only terminal', () => {
      const { entry } = createEntry();
      registerTerminalEditHandler(entry);
      unregisterTerminalEditHandler(entry);
      expect(handleTerminalEditCommand('paste')).toBe(false);
    });

    it('does not unregister if a different entry is passed', () => {
      const { entry: entry1 } = createEntry(undefined, true);
      const { entry: entry2 } = createEntry(undefined, false); // unfocused so it doesn't steal focus
      registerTerminalEditHandler(entry1);
      unregisterTerminalEditHandler(entry2); // wrong entry
      // entry1 should still be registered
      expect(handleTerminalEditCommand('paste')).toBe(true);
    });

    it('latest registration wins (single-slot registry)', async () => {
      const { entry: entry1, writeToPty: write1 } = createEntry(undefined, false);
      const { entry: entry2, writeToPty: write2 } = createEntry(undefined, true);
      registerTerminalEditHandler(entry1);
      registerTerminalEditHandler(entry2); // replaces entry1

      handleTerminalEditCommand('paste');
      await flush();
      expect(write1).not.toHaveBeenCalled();
      expect(write2).toHaveBeenCalledWith('pasted text');
    });
  });

  // ─── Focus detection ───────────────────────────────────────────

  describe('focus detection', () => {
    it('returns false when terminal container does not have focus', () => {
      const { entry } = createEntry(undefined, false);
      registerTerminalEditHandler(entry);
      expect(handleTerminalEditCommand('paste')).toBe(false);
    });

    it('returns true when focus is on a child of the container', () => {
      const { entry } = createEntry(undefined, true); // textarea child is focused
      registerTerminalEditHandler(entry);
      expect(handleTerminalEditCommand('paste')).toBe(true);
    });

    it('returns true when the container itself has focus', () => {
      const term = createMockTerminal();
      const writeToPty = vi.fn();
      const container = document.createElement('div');
      container.tabIndex = 0;
      document.body.appendChild(container);
      container.focus();

      const entry: RegisteredTerminal = {
        term: term as any,
        writeToPty,
        container,
      };
      registerTerminalEditHandler(entry);
      expect(handleTerminalEditCommand('paste')).toBe(true);
    });
  });

  // ─── Paste command ─────────────────────────────────────────────

  describe('paste', () => {
    it('reads clipboard and writes to PTY', async () => {
      const { entry, writeToPty } = createEntry();
      registerTerminalEditHandler(entry);

      const handled = handleTerminalEditCommand('paste');
      expect(handled).toBe(true);

      await flush();
      expect(clipboardReadText).toHaveBeenCalled();
      expect(writeToPty).toHaveBeenCalledWith('pasted text');
    });

    it('wraps text in bracketed paste sequences when mode is active', async () => {
      const { entry, writeToPty } = createEntry({ bracketedPasteMode: true });
      registerTerminalEditHandler(entry);

      handleTerminalEditCommand('paste');
      await flush();

      expect(writeToPty).toHaveBeenCalledWith('\x1b[200~pasted text\x1b[201~');
    });

    it('does not write to PTY when clipboard is empty', async () => {
      clipboardReadText.mockResolvedValue('');
      const { entry, writeToPty } = createEntry();
      registerTerminalEditHandler(entry);

      handleTerminalEditCommand('paste');
      await flush();

      expect(writeToPty).not.toHaveBeenCalled();
    });

    it('does not write to PTY when clipboard read fails', async () => {
      clipboardReadText.mockRejectedValue(new Error('denied'));
      const { entry, writeToPty } = createEntry();
      registerTerminalEditHandler(entry);

      handleTerminalEditCommand('paste');
      await flush();

      expect(writeToPty).not.toHaveBeenCalled();
    });
  });

  // ─── Copy command ──────────────────────────────────────────────

  describe('copy', () => {
    it('copies terminal selection to clipboard and clears selection', async () => {
      const { entry } = createEntry({ hasSelection: true, selection: 'selected text' });
      registerTerminalEditHandler(entry);

      const handled = handleTerminalEditCommand('copy');
      expect(handled).toBe(true);

      await flush();
      expect(clipboardWriteText).toHaveBeenCalledWith('selected text');
      expect(entry.term.clearSelection).toHaveBeenCalled();
    });

    it('returns false when there is no selection', () => {
      const { entry } = createEntry({ hasSelection: false });
      registerTerminalEditHandler(entry);

      const handled = handleTerminalEditCommand('copy');
      expect(handled).toBe(false);
      expect(clipboardWriteText).not.toHaveBeenCalled();
    });
  });

  // ─── Select All command ────────────────────────────────────────

  describe('selectAll', () => {
    it('calls term.selectAll() and returns true', () => {
      const { entry } = createEntry();
      registerTerminalEditHandler(entry);

      const handled = handleTerminalEditCommand('selectAll');
      expect(handled).toBe(true);
      expect(entry.term.selectAll).toHaveBeenCalled();
    });
  });

  // ─── Unrecognized commands ─────────────────────────────────────

  describe('unrecognized commands', () => {
    it('returns false for undo', () => {
      const { entry } = createEntry();
      registerTerminalEditHandler(entry);
      expect(handleTerminalEditCommand('undo')).toBe(false);
    });

    it('returns false for redo', () => {
      const { entry } = createEntry();
      registerTerminalEditHandler(entry);
      expect(handleTerminalEditCommand('redo')).toBe(false);
    });

    it('returns false for cut', () => {
      const { entry } = createEntry();
      registerTerminalEditHandler(entry);
      expect(handleTerminalEditCommand('cut')).toBe(false);
    });
  });

  // ─── Cleanup / lifecycle ───────────────────────────────────────

  describe('lifecycle', () => {
    it('unregister then re-register works correctly', async () => {
      const { entry, writeToPty } = createEntry();
      registerTerminalEditHandler(entry);
      unregisterTerminalEditHandler(entry);
      expect(handleTerminalEditCommand('paste')).toBe(false);

      registerTerminalEditHandler(entry);
      const handled = handleTerminalEditCommand('paste');
      expect(handled).toBe(true);
      await flush();
      expect(writeToPty).toHaveBeenCalledWith('pasted text');
    });
  });
});
