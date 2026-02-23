import { render, act } from '@testing-library/react';
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

vi.mock('../terminal/clipboard', () => ({
  attachClipboardHandlers: (...args: any[]) => (globalThis as any).__testAttachClipboard(...args),
}));

import { AgentTerminal } from './AgentTerminal';

let mockOnDataCallback: ((id: string, data: string) => void) | null = null;
let mockOnExitCallback: ((id: string, exitCode: number) => void) | null = null;
const mockRemoveDataListener = vi.fn();
const mockRemoveExitListener = vi.fn();
const mockDisconnect = vi.fn();

describe('AgentTerminal', () => {
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
      render(<AgentTerminal agentId="agent-1" />);
      expect(term()).toBeTruthy();
      expect(term().options.theme).toEqual({ background: '#000', foreground: '#fff' });
    });

    it('creates and loads FitAddon', () => {
      render(<AgentTerminal agentId="agent-1" />);
      expect(fitAddon()).toBeTruthy();
      expect(term().loadAddon).toHaveBeenCalled();
    });

    it('opens terminal on the container element', () => {
      render(<AgentTerminal agentId="agent-1" />);
      expect(term().open).toHaveBeenCalled();
    });

    it('calls fit and resize on mount', () => {
      render(<AgentTerminal agentId="agent-1" />);
      expect(fitAddon().fit).toHaveBeenCalled();
      expect(window.clubhouse.pty.resize).toHaveBeenCalledWith('agent-1', 80, 24);
    });

    it('requests buffer content on mount', () => {
      render(<AgentTerminal agentId="agent-1" />);
      expect(window.clubhouse.pty.getBuffer).toHaveBeenCalledWith('agent-1');
    });

    it('loads clipboard settings on mount', () => {
      const loadSettings = vi.fn();
      useClipboardSettingsStore.setState({ loadSettings });
      render(<AgentTerminal agentId="agent-1" />);
      expect(loadSettings).toHaveBeenCalled();
    });
  });

  describe('PTY communication', () => {
    it('subscribes to PTY onData events', () => {
      render(<AgentTerminal agentId="agent-1" />);
      expect(window.clubhouse.pty.onData).toHaveBeenCalled();
    });

    it('subscribes to PTY onExit events', () => {
      render(<AgentTerminal agentId="agent-1" />);
      expect(window.clubhouse.pty.onExit).toHaveBeenCalled();
    });

    it('forwards terminal input to PTY write', () => {
      render(<AgentTerminal agentId="agent-1" />);
      const onDataCb = term().onData.mock.calls[0][0];
      onDataCb('test input');
      expect(window.clubhouse.pty.write).toHaveBeenCalledWith('agent-1', 'test input');
    });

    it('writes PTY data to terminal for matching agentId', () => {
      render(<AgentTerminal agentId="agent-1" />);
      expect(mockOnDataCallback).toBeTruthy();
      act(() => { mockOnDataCallback!('agent-1', 'hello world'); });
      expect(term().write).toHaveBeenCalledWith('hello world');
    });

    it('ignores PTY data for other agentIds', () => {
      render(<AgentTerminal agentId="agent-1" />);
      term().write.mockClear();
      act(() => { mockOnDataCallback!('agent-2', 'other agent data'); });
      expect(term().write).not.toHaveBeenCalledWith('other agent data');
    });

    it('writes reset sequences on exit for matching agent', () => {
      render(<AgentTerminal agentId="agent-1" />);
      act(() => { mockOnExitCallback!('agent-1', 0); });
      expect(term().write).toHaveBeenCalledWith(expect.stringContaining('\x1b[?1049l'));
    });
  });

  describe('cleanup on unmount', () => {
    it('removes PTY listeners on unmount', () => {
      const { unmount } = render(<AgentTerminal agentId="agent-1" />);
      unmount();
      expect(mockRemoveDataListener).toHaveBeenCalled();
      expect(mockRemoveExitListener).toHaveBeenCalled();
    });

    it('disconnects ResizeObserver on unmount', () => {
      const { unmount } = render(<AgentTerminal agentId="agent-1" />);
      unmount();
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('disposes terminal on unmount', () => {
      const { unmount } = render(<AgentTerminal agentId="agent-1" />);
      unmount();
      expect(term().dispose).toHaveBeenCalled();
    });
  });

  describe('theme updates', () => {
    it('updates terminal theme when theme store changes', () => {
      render(<AgentTerminal agentId="agent-1" />);
      const newTheme = { background: '#111', foreground: '#eee' };
      act(() => {
        useThemeStore.setState({ theme: { terminal: newTheme } as any });
      });
      expect(term().options.theme).toEqual(newTheme);
    });
  });

  describe('focus behavior', () => {
    it('focuses terminal when focused prop is true', () => {
      render(<AgentTerminal agentId="agent-1" focused={true} />);
      expect(term().focus).toHaveBeenCalled();
    });
  });

  describe('clipboard', () => {
    it('attaches clipboard handlers when clipboardCompat is true', () => {
      useClipboardSettingsStore.setState({ clipboardCompat: true });
      render(<AgentTerminal agentId="agent-1" />);
      expect(g.__testAttachClipboard).toHaveBeenCalled();
    });

    it('does not attach clipboard handlers when clipboardCompat is false', () => {
      useClipboardSettingsStore.setState({ clipboardCompat: false });
      render(<AgentTerminal agentId="agent-1" />);
      expect(g.__testAttachClipboard).not.toHaveBeenCalled();
    });
  });

  describe('container rendering', () => {
    it('renders a container div with padding', () => {
      const { container } = render(<AgentTerminal agentId="agent-1" />);
      const div = container.firstElementChild as HTMLElement;
      expect(div.style.padding).toBe('8px');
    });
  });
});
