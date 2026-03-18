import { describe, it, expect, beforeEach, vi } from 'vitest';
import { attachClipboardHandlers, readClipboard, writeClipboard, pasteIntoTerminal } from './clipboard';

// --- Mocks ---

let mockPlatform = 'win32' as string;

// Override the default setup-renderer stub with a getter so tests can swap platform
Object.defineProperty(window, 'clubhouse', {
  configurable: true,
  get: () => ({
    platform: mockPlatform,
    pty: { write: vi.fn(), resize: vi.fn(), getBuffer: vi.fn(async () => ''), onData: () => vi.fn(), onExit: () => vi.fn() },
  }),
});

// navigator.clipboard is not available in jsdom — stub it
const clipboardReadText = vi.fn<() => Promise<string>>(async () => '');
const clipboardWriteText = vi.fn<(text: string) => Promise<void>>(async () => {});
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { readText: clipboardReadText, writeText: clipboardWriteText },
});

/** Create a minimal mock Terminal that captures the key handler and context menu behavior. */
function createMockTerminal(opts?: { bracketedPasteMode?: boolean; hasSelection?: boolean; selection?: string }) {
  let keyHandler: ((e: KeyboardEvent) => boolean) | null = null;

  return {
    modes: { bracketedPasteMode: opts?.bracketedPasteMode ?? false },
    hasSelection: vi.fn(() => opts?.hasSelection ?? false),
    getSelection: vi.fn(() => opts?.selection ?? ''),
    clearSelection: vi.fn(),
    attachCustomKeyEventHandler: vi.fn((handler: (e: KeyboardEvent) => boolean) => {
      keyHandler = handler;
    }),
    /** Call the registered key handler. Returns what the handler returns (false = consumed). */
    _fireKey(e: Partial<KeyboardEvent>): boolean {
      if (!keyHandler) throw new Error('No key handler attached');
      return keyHandler({ type: 'keydown', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', ...e } as KeyboardEvent);
    },
  };
}

function createContainer(): HTMLDivElement {
  return document.createElement('div');
}

// --- Helpers ---

/** Flush microtasks (await clipboard reads/writes). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('clipboard — keyboard shortcuts', () => {
  let writeToPty: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPlatform = 'win32';
    writeToPty = vi.fn();
    clipboardReadText.mockReset().mockResolvedValue('pasted text');
    clipboardWriteText.mockReset().mockResolvedValue(undefined);
  });

  // ---------- PASTE ----------

  describe('paste (Ctrl+V on Windows/Linux)', () => {
    it('intercepts Ctrl+V and writes clipboard text to PTY', async () => {
      const term = createMockTerminal();
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      const consumed = term._fireKey({ ctrlKey: true, key: 'v' });
      expect(consumed).toBe(false); // handler consumed the event

      await flush();
      expect(clipboardReadText).toHaveBeenCalled();
      expect(writeToPty).toHaveBeenCalledWith('pasted text');
    });

    it('intercepts Ctrl+Shift+V (Linux alternate)', async () => {
      const term = createMockTerminal();
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      const consumed = term._fireKey({ ctrlKey: true, shiftKey: true, key: 'v' });
      expect(consumed).toBe(false);

      await flush();
      expect(writeToPty).toHaveBeenCalledWith('pasted text');
    });

    it('wraps pasted text in bracketed paste sequences when mode is active', async () => {
      const term = createMockTerminal({ bracketedPasteMode: true });
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      term._fireKey({ ctrlKey: true, key: 'v' });
      await flush();

      expect(writeToPty).toHaveBeenCalledWith('\x1b[200~pasted text\x1b[201~');
    });

    it('does not write to PTY when clipboard is empty', async () => {
      clipboardReadText.mockResolvedValue('');
      const term = createMockTerminal();
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      term._fireKey({ ctrlKey: true, key: 'v' });
      await flush();

      expect(writeToPty).not.toHaveBeenCalled();
    });

    it('does not write to PTY when clipboard read fails', async () => {
      clipboardReadText.mockRejectedValue(new Error('denied'));
      const term = createMockTerminal();
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      term._fireKey({ ctrlKey: true, key: 'v' });
      await flush();

      expect(writeToPty).not.toHaveBeenCalled();
    });
  });

  describe('paste (Cmd+V on macOS)', () => {
    beforeEach(() => { mockPlatform = 'darwin'; });

    it('intercepts Cmd+V on macOS', async () => {
      const term = createMockTerminal();
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      const consumed = term._fireKey({ metaKey: true, key: 'v' });
      expect(consumed).toBe(false);

      await flush();
      expect(writeToPty).toHaveBeenCalledWith('pasted text');
    });

    it('does NOT intercept Ctrl+V on macOS (Ctrl+V is ^V in terminal)', () => {
      const term = createMockTerminal();
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      const consumed = term._fireKey({ ctrlKey: true, key: 'v' });
      expect(consumed).toBe(true); // not consumed — passes through
    });
  });

  // ---------- COPY ----------

  describe('copy (Ctrl+Shift+C on Windows/Linux)', () => {
    it('copies selection to clipboard when text is selected', async () => {
      const term = createMockTerminal({ hasSelection: true, selection: 'selected text' });
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      const consumed = term._fireKey({ ctrlKey: true, shiftKey: true, key: 'c' });
      expect(consumed).toBe(false);

      await flush();
      expect(clipboardWriteText).toHaveBeenCalledWith('selected text');
      expect(term.clearSelection).toHaveBeenCalled();
    });

    it('does nothing when there is no selection', async () => {
      const term = createMockTerminal({ hasSelection: false });
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      const consumed = term._fireKey({ ctrlKey: true, shiftKey: true, key: 'c' });
      expect(consumed).toBe(false); // still consumed (it's the copy shortcut)

      await flush();
      expect(clipboardWriteText).not.toHaveBeenCalled();
    });
  });

  describe('Ctrl+C (no shift) on Windows/Linux', () => {
    it('copies selection when text is selected', async () => {
      const term = createMockTerminal({ hasSelection: true, selection: 'some text' });
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      const consumed = term._fireKey({ ctrlKey: true, key: 'c' });
      expect(consumed).toBe(false);

      await flush();
      expect(clipboardWriteText).toHaveBeenCalledWith('some text');
      expect(term.clearSelection).toHaveBeenCalled();
    });

    it('passes through as SIGINT when no selection', () => {
      const term = createMockTerminal({ hasSelection: false });
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      const consumed = term._fireKey({ ctrlKey: true, key: 'c' });
      expect(consumed).toBe(true); // passes through to terminal
    });
  });

  describe('copy (Cmd+C on macOS)', () => {
    beforeEach(() => { mockPlatform = 'darwin'; });

    it('copies selection to clipboard', async () => {
      const term = createMockTerminal({ hasSelection: true, selection: 'mac selected' });
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      const consumed = term._fireKey({ metaKey: true, key: 'c' });
      expect(consumed).toBe(false);

      await flush();
      expect(clipboardWriteText).toHaveBeenCalledWith('mac selected');
    });

    it('does NOT intercept Ctrl+C on macOS (SIGINT)', () => {
      const term = createMockTerminal({ hasSelection: true, selection: 'text' });
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      const consumed = term._fireKey({ ctrlKey: true, key: 'c' });
      expect(consumed).toBe(true); // passes through
    });
  });

  // ---------- UNRELATED KEYS ----------

  describe('unrelated keys pass through', () => {
    it('lets regular keys pass through', () => {
      const term = createMockTerminal();
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      expect(term._fireKey({ key: 'a' })).toBe(true);
      expect(term._fireKey({ key: 'Enter' })).toBe(true);
      expect(term._fireKey({ ctrlKey: true, key: 'l' })).toBe(true);
    });

    it('ignores keyup events', () => {
      const term = createMockTerminal();
      attachClipboardHandlers(term as any, createContainer(), writeToPty);

      // keyup for Ctrl+V should pass through
      const result = term._fireKey({ type: 'keyup' as any, ctrlKey: true, key: 'v' });
      expect(result).toBe(true);
    });
  });
});

describe('clipboard — right-click context menu', () => {
  let writeToPty: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPlatform = 'win32';
    writeToPty = vi.fn();
    clipboardReadText.mockReset().mockResolvedValue('right-click paste');
    clipboardWriteText.mockReset().mockResolvedValue(undefined);
  });

  it('pastes from clipboard on right-click when no selection', async () => {
    const term = createMockTerminal({ hasSelection: false });
    const container = createContainer();
    attachClipboardHandlers(term as any, container, writeToPty);

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    container.dispatchEvent(event);

    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(writeToPty).toHaveBeenCalledWith('right-click paste');
  });

  it('stops propagation to prevent xterm double-paste (issue #760)', async () => {
    const term = createMockTerminal({ hasSelection: false });
    const container = createContainer();
    attachClipboardHandlers(term as any, container, writeToPty);

    // Simulate a child element (like xterm's internal element) that would
    // also handle the contextmenu event and trigger a second paste.
    const child = document.createElement('div');
    container.appendChild(child);
    const childHandler = vi.fn();
    child.addEventListener('contextmenu', childHandler);

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    child.dispatchEvent(event);

    await flush();
    // Our capture-phase handler should have stopped propagation,
    // preventing the child's own bubble-phase handler from firing.
    expect(childHandler).not.toHaveBeenCalled();
    expect(writeToPty).toHaveBeenCalledTimes(1);
  });

  it('copies selection on right-click when text is selected', async () => {
    const term = createMockTerminal({ hasSelection: true, selection: 'right-click copy' });
    const container = createContainer();
    attachClipboardHandlers(term as any, container, writeToPty);

    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    await flush();
    expect(clipboardWriteText).toHaveBeenCalledWith('right-click copy');
    expect(term.clearSelection).toHaveBeenCalled();
    expect(writeToPty).not.toHaveBeenCalled();
  });

  it('cleanup function removes the context-menu listener', async () => {
    const term = createMockTerminal({ hasSelection: false });
    const container = createContainer();
    const cleanup = attachClipboardHandlers(term as any, container, writeToPty);

    cleanup();

    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();

    expect(writeToPty).not.toHaveBeenCalled();
  });
});

// ─── Exported utility functions ──────────────────────────────────────────────
// These were made public so the terminal-edit-handler can reuse them for
// Electron menu-driven paste/copy routing.

describe('readClipboard', () => {
  beforeEach(() => {
    clipboardReadText.mockReset();
  });

  it('returns clipboard text on success', async () => {
    clipboardReadText.mockResolvedValue('hello');
    expect(await readClipboard()).toBe('hello');
  });

  it('returns empty string on failure', async () => {
    clipboardReadText.mockRejectedValue(new Error('denied'));
    expect(await readClipboard()).toBe('');
  });
});

describe('writeClipboard', () => {
  beforeEach(() => {
    clipboardWriteText.mockReset();
  });

  it('writes text to clipboard', async () => {
    await writeClipboard('test');
    expect(clipboardWriteText).toHaveBeenCalledWith('test');
  });

  it('silently ignores write failures', async () => {
    clipboardWriteText.mockRejectedValue(new Error('denied'));
    await expect(writeClipboard('test')).resolves.toBeUndefined();
  });
});

describe('pasteIntoTerminal', () => {
  beforeEach(() => {
    clipboardReadText.mockReset().mockResolvedValue('paste me');
  });

  it('reads clipboard and calls writeToPty', async () => {
    const term = createMockTerminal();
    const writeToPty = vi.fn();
    pasteIntoTerminal(term as any, writeToPty);
    await flush();
    expect(writeToPty).toHaveBeenCalledWith('paste me');
  });

  it('wraps in bracketed paste when mode is active', async () => {
    const term = createMockTerminal({ bracketedPasteMode: true });
    const writeToPty = vi.fn();
    pasteIntoTerminal(term as any, writeToPty);
    await flush();
    expect(writeToPty).toHaveBeenCalledWith('\x1b[200~paste me\x1b[201~');
  });

  it('does not call writeToPty when clipboard is empty', async () => {
    clipboardReadText.mockResolvedValue('');
    const term = createMockTerminal();
    const writeToPty = vi.fn();
    pasteIntoTerminal(term as any, writeToPty);
    await flush();
    expect(writeToPty).not.toHaveBeenCalled();
  });
});
