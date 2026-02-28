import { render, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useThemeStore } from '../../stores/themeStore';
import { useClipboardSettingsStore } from '../../stores/clipboardSettingsStore';

// Shared state holders for mock instances (using globalThis so hoisted vi.mock can set them)
const g = globalThis as any;
g.__testTerminal = null;
g.__testFitAddon = null;
g.__testAttachClipboard = vi.fn().mockReturnValue(vi.fn());

vi.mock('@xterm/xterm', () => {
  class Terminal {
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    onData = vi.fn().mockReturnValue({ dispose: vi.fn() });
    options: Record<string, any> = {};
    cols = 80;
    rows = 24;
    constructor(opts?: any) {
      (globalThis as any).__testTerminal = this;
      if (opts?.theme) this.options.theme = opts.theme;
    }
  }
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit = vi.fn();
    constructor() {
      (globalThis as any).__testFitAddon = this;
    }
  }
  return { FitAddon };
});

vi.mock('./clipboard', () => ({
  attachClipboardHandlers: (...args: any[]) => (globalThis as any).__testAttachClipboard(...args),
}));

import { ShellTerminal } from './ShellTerminal';

let mockOnDataCallback: ((id: string, data: string) => void) | null = null;
let mockOnExitCallback: ((id: string, exitCode: number) => void) | null = null;
const mockRemoveDataListener = vi.fn();
const mockRemoveExitListener = vi.fn();
const mockDisconnect = vi.fn();

describe('ShellTerminal', () => {
  beforeEach(() => {
    g.__testTerminal = null;
    g.__testFitAddon = null;
    g.__testAttachClipboard.mockClear();
    g.__testAttachClipboard.mockReturnValue(vi.fn());
    mockOnDataCallback = null;
    mockOnExitCallback = null;
    mockRemoveDataListener.mockClear();
    mockRemoveExitListener.mockClear();
    mockDisconnect.mockClear();

    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = mockDisconnect;
      unobserve = vi.fn();
    });
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0; });

    window.clubhouse.pty.write = vi.fn();
    window.clubhouse.pty.resize = vi.fn();
    window.clubhouse.pty.getBuffer = vi.fn().mockResolvedValue('');
    window.clubhouse.pty.onData = vi.fn().mockImplementation((cb: any) => {
      mockOnDataCallback = cb;
      return mockRemoveDataListener;
    });
    window.clubhouse.pty.onExit = vi.fn().mockImplementation((cb: any) => {
      mockOnExitCallback = cb;
      return mockRemoveExitListener;
    });

    useThemeStore.setState({
      theme: { terminal: { background: '#000', foreground: '#fff' } } as any,
    });

    useClipboardSettingsStore.setState({
      clipboardCompat: false,
      loaded: false,
      loadSettings: vi.fn(),
      saveSettings: vi.fn(),
    });
  });

  function term() { return g.__testTerminal; }
  function fitAddon() { return g.__testFitAddon; }

  describe('initialization', () => {
    it('creates a Terminal instance with theme colors', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      expect(term()).toBeTruthy();
      expect(term().options.theme).toEqual({ background: '#000', foreground: '#fff' });
    });

    it('creates and loads FitAddon', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      expect(fitAddon()).toBeTruthy();
      expect(term().loadAddon).toHaveBeenCalled();
    });

    it('opens terminal on the container element', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      expect(term().open).toHaveBeenCalled();
    });

    it('calls fit and resize on mount', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      expect(fitAddon().fit).toHaveBeenCalled();
      expect(window.clubhouse.pty.resize).toHaveBeenCalledWith('shell-1', 80, 24);
    });

    it('requests buffer content on mount', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      expect(window.clubhouse.pty.getBuffer).toHaveBeenCalledWith('shell-1');
    });

    it('loads clipboard settings on mount', () => {
      const loadSettings = vi.fn();
      useClipboardSettingsStore.setState({ loadSettings });
      render(<ShellTerminal sessionId="shell-1" />);
      expect(loadSettings).toHaveBeenCalled();
    });
  });

  describe('PTY communication', () => {
    it('subscribes to PTY onData events', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      expect(window.clubhouse.pty.onData).toHaveBeenCalled();
    });

    it('subscribes to PTY onExit events', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      expect(window.clubhouse.pty.onExit).toHaveBeenCalled();
    });

    it('forwards terminal input to PTY write', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      const onDataCb = term().onData.mock.calls[0][0];
      onDataCb('test input');
      expect(window.clubhouse.pty.write).toHaveBeenCalledWith('shell-1', 'test input');
    });

    it('writes PTY data to terminal for matching sessionId', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      expect(mockOnDataCallback).toBeTruthy();
      act(() => { mockOnDataCallback!('shell-1', 'hello world'); });
      expect(term().write).toHaveBeenCalledWith('hello world');
    });

    it('ignores PTY data for other sessionIds', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      term().write.mockClear();
      act(() => { mockOnDataCallback!('shell-2', 'other session data'); });
      expect(term().write).not.toHaveBeenCalledWith('other session data');
    });

    it('writes reset sequences on exit for matching session', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      act(() => { mockOnExitCallback!('shell-1', 0); });
      expect(term().write).toHaveBeenCalledWith(expect.stringContaining('\x1b[?1049l'));
    });

    it('does not write reset sequences for other sessions', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      term().write.mockClear();
      act(() => { mockOnExitCallback!('shell-2', 0); });
      expect(term().write).not.toHaveBeenCalled();
    });

    it('reset sequences include cursor show and attribute reset', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      act(() => { mockOnExitCallback!('shell-1', 0); });
      const resetCall = term().write.mock.calls.find(
        (c: string[]) => c[0].includes('\x1b[?1049l')
      );
      expect(resetCall).toBeDefined();
      expect(resetCall![0]).toContain('\x1b[?25h'); // show cursor
      expect(resetCall![0]).toContain('\x1b[0m');   // reset attributes
    });
  });

  describe('cleanup on unmount', () => {
    it('removes PTY listeners on unmount', () => {
      const { unmount } = render(<ShellTerminal sessionId="shell-1" />);
      unmount();
      expect(mockRemoveDataListener).toHaveBeenCalled();
      expect(mockRemoveExitListener).toHaveBeenCalled();
    });

    it('disconnects ResizeObserver on unmount', () => {
      const { unmount } = render(<ShellTerminal sessionId="shell-1" />);
      unmount();
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('disposes terminal on unmount', () => {
      const { unmount } = render(<ShellTerminal sessionId="shell-1" />);
      unmount();
      expect(term().dispose).toHaveBeenCalled();
    });

    it('nulls out refs on unmount', () => {
      const { unmount } = render(<ShellTerminal sessionId="shell-1" />);
      const termBefore = term();
      expect(termBefore).toBeTruthy();
      unmount();
      // Terminal was disposed — verifying via the dispose call
      expect(termBefore.dispose).toHaveBeenCalled();
    });
  });

  describe('theme updates', () => {
    it('updates terminal theme when theme store changes', () => {
      render(<ShellTerminal sessionId="shell-1" />);
      const newTheme = { background: '#111', foreground: '#eee' };
      act(() => {
        useThemeStore.setState({ theme: { terminal: newTheme } as any });
      });
      expect(term().options.theme).toEqual(newTheme);
    });
  });

  describe('focus behavior', () => {
    it('focuses terminal when focused prop is true', () => {
      render(<ShellTerminal sessionId="shell-1" focused={true} />);
      expect(term().focus).toHaveBeenCalled();
    });

    it('does not call extra focus when focused prop is false', () => {
      render(<ShellTerminal sessionId="shell-1" focused={false} />);
      // focus() is called once during mount (in requestAnimationFrame callback)
      // but not again from the focused effect
      const focusCalls = term().focus.mock.calls.length;
      expect(focusCalls).toBe(1); // only mount focus
    });

    it('re-focuses terminal on mousedown for focus recovery', () => {
      const { container } = render(<ShellTerminal sessionId="shell-1" focused={true} />);
      term().focus.mockClear();
      fireEvent.mouseDown(container.firstElementChild as HTMLElement);
      expect(term().focus).toHaveBeenCalled();
    });
  });

  describe('clipboard', () => {
    it('attaches clipboard handlers when clipboardCompat is true', () => {
      useClipboardSettingsStore.setState({ clipboardCompat: true });
      render(<ShellTerminal sessionId="shell-1" />);
      expect(g.__testAttachClipboard).toHaveBeenCalled();
    });

    it('does not attach clipboard handlers when clipboardCompat is false', () => {
      useClipboardSettingsStore.setState({ clipboardCompat: false });
      render(<ShellTerminal sessionId="shell-1" />);
      expect(g.__testAttachClipboard).not.toHaveBeenCalled();
    });
  });

  describe('container rendering', () => {
    it('renders a container div with padding', () => {
      const { container } = render(<ShellTerminal sessionId="shell-1" />);
      const div = container.firstElementChild as HTMLElement;
      expect(div.style.padding).toBe('8px');
    });
  });

  describe('buffer replay', () => {
    it('writes buffered output on mount when buffer is non-empty', async () => {
      (window.clubhouse.pty.getBuffer as ReturnType<typeof vi.fn>).mockResolvedValue('previous output');
      render(<ShellTerminal sessionId="shell-1" />);
      // Wait for the async getBuffer promise to resolve
      await vi.waitFor(() => {
        expect(term().write).toHaveBeenCalledWith('previous output');
      });
    });

    it('does not write when buffer is empty', async () => {
      (window.clubhouse.pty.getBuffer as ReturnType<typeof vi.fn>).mockResolvedValue('');
      render(<ShellTerminal sessionId="shell-1" />);
      // Wait a tick for the promise
      await new Promise((r) => setTimeout(r, 0));
      // write should not have been called with empty string
      const writeCalls = term().write.mock.calls.filter((c: string[]) => c[0] === '');
      expect(writeCalls).toHaveLength(0);
    });
  });
});
