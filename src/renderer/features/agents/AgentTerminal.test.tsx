import { render, act, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useThemeStore } from '../../stores/themeStore';
import { useAgentStore } from '../../stores/agentStore';
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

    it('writes PTY data to terminal for matching agentId after buffer replay', () => {
      render(<AgentTerminal agentId="agent-1" />);
      expect(mockOnDataCallback).toBeTruthy();
      act(() => { mockOnDataCallback!('agent-1', 'hello world'); });
      expect(term().write).toHaveBeenCalledWith('hello world');
    });

    it('gates onData until buffer replay completes to prevent double-display', async () => {
      // Simulate getBuffer returning data with a delay
      let resolveBuffer: (val: string) => void;
      (window.clubhouse.pty.getBuffer as any).mockReturnValue(
        new Promise<string>((r) => { resolveBuffer = r; })
      );

      render(<AgentTerminal agentId="agent-1" />);
      term().write.mockClear();

      // Send data via onData BEFORE buffer resolves — should be gated
      act(() => { mockOnDataCallback!('agent-1', 'live data'); });
      expect(term().write).not.toHaveBeenCalledWith('live data');

      // Now resolve the buffer
      await act(async () => { resolveBuffer!('buffered output'); });
      expect(term().write).toHaveBeenCalledWith('buffered output');

      // Data arriving AFTER buffer replay should pass through
      act(() => { mockOnDataCallback!('agent-1', 'new data'); });
      expect(term().write).toHaveBeenCalledWith('new data');
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

    it('re-focuses terminal on mousedown for focus recovery', () => {
      render(<AgentTerminal agentId="agent-1" focused={true} />);
      term().focus.mockClear();
      fireEvent.mouseDown(screen.getByTestId('agent-terminal'));
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
      const terminalDiv = container.querySelector('[data-testid="agent-terminal"]') as HTMLElement;
      expect(terminalDiv.style.padding).toBe('8px');
    });
  });

  describe('resume overlay', () => {
    function setResuming(resuming: boolean) {
      useAgentStore.setState({
        agents: {
          'agent-1': {
            id: 'agent-1',
            projectId: 'proj-1',
            name: 'test',
            kind: 'durable',
            status: 'running',
            color: 'indigo',
            resuming: resuming || undefined,
          },
        },
        clearResuming: vi.fn(),
      });
    }

    it('shows resume overlay when agent.resuming is true', () => {
      setResuming(true);
      render(<AgentTerminal agentId="agent-1" />);
      expect(screen.getByTestId('resume-overlay')).toBeInTheDocument();
      expect(screen.getByText('Resuming session...')).toBeInTheDocument();
    });

    it('does not show resume overlay when agent.resuming is falsy', () => {
      setResuming(false);
      render(<AgentTerminal agentId="agent-1" />);
      expect(screen.queryByTestId('resume-overlay')).toBeNull();
    });

    it('clears resuming after PTY data settles', () => {
      vi.useFakeTimers();
      const clearResuming = vi.fn();
      useAgentStore.setState({
        agents: {
          'agent-1': {
            id: 'agent-1', projectId: 'proj-1', name: 'test',
            kind: 'durable', status: 'running', color: 'indigo',
            resuming: true,
          },
        },
        clearResuming,
      });

      // onData is called multiple times (main effect + resume effect)
      // Capture all callbacks
      const dataCallbacks: Array<(id: string, data: string) => void> = [];
      (window.clubhouse.pty.onData as any).mockImplementation((cb: any) => {
        dataCallbacks.push(cb);
        return vi.fn();
      });

      render(<AgentTerminal agentId="agent-1" />);

      // Simulate PTY data burst then silence
      act(() => {
        for (const cb of dataCallbacks) {
          cb('agent-1', 'replay data');
        }
      });

      // Not cleared yet — settle timer hasn't fired
      expect(clearResuming).not.toHaveBeenCalled();

      // Advance past the settle timeout (1500ms)
      act(() => { vi.advanceTimersByTime(1500); });
      expect(clearResuming).toHaveBeenCalledWith('agent-1');

      vi.useRealTimers();
    });

    it('clears resuming via fallback timer if no data arrives', () => {
      vi.useFakeTimers();
      const clearResuming = vi.fn();
      useAgentStore.setState({
        agents: {
          'agent-1': {
            id: 'agent-1', projectId: 'proj-1', name: 'test',
            kind: 'durable', status: 'running', color: 'indigo',
            resuming: true,
          },
        },
        clearResuming,
      });

      render(<AgentTerminal agentId="agent-1" />);

      // No PTY data at all — fallback timer at 10s
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(clearResuming).toHaveBeenCalledWith('agent-1');

      vi.useRealTimers();
    });

    it('triggers a re-fit after resume finishes', () => {
      vi.useFakeTimers();
      useAgentStore.setState({
        agents: {
          'agent-1': {
            id: 'agent-1', projectId: 'proj-1', name: 'test',
            kind: 'durable', status: 'running', color: 'indigo',
            resuming: true,
          },
        },
        clearResuming: vi.fn(),
      });

      const dataCallbacks: Array<(id: string, data: string) => void> = [];
      (window.clubhouse.pty.onData as any).mockImplementation((cb: any) => {
        dataCallbacks.push(cb);
        return vi.fn();
      });

      render(<AgentTerminal agentId="agent-1" />);

      // Clear fit calls from initialization
      fitAddon().fit.mockClear();
      (window.clubhouse.pty.resize as any).mockClear();

      // Trigger data then let it settle
      act(() => {
        for (const cb of dataCallbacks) cb('agent-1', 'data');
      });
      act(() => { vi.advanceTimersByTime(1500); });

      // Re-fit should have been called after resume finished
      expect(fitAddon().fit).toHaveBeenCalled();
      expect(window.clubhouse.pty.resize).toHaveBeenCalledWith('agent-1', 80, 24);

      vi.useRealTimers();
    });
  });
});
