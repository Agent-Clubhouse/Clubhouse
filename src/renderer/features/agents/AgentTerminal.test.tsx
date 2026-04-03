import React from 'react';
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
    open = vi.fn().mockImplementation((container: HTMLElement) => {
      // Create a mock .xterm-viewport element like real xterm does
      const viewport = document.createElement('div');
      viewport.classList.add('xterm-viewport');
      // Default: large scrollback, at the bottom
      Object.defineProperty(viewport, 'scrollHeight', { value: 200, configurable: true, writable: true });
      Object.defineProperty(viewport, 'clientHeight', { value: 200, configurable: true, writable: true });
      viewport.scrollTop = 0;
      container.appendChild(viewport);
    });
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    onData = vi.fn().mockReturnValue({ dispose: vi.fn() });
    registerMarker = vi.fn().mockReturnValue({ dispose: vi.fn() });
    registerDecoration = vi.fn().mockReturnValue({ dispose: vi.fn() });
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

vi.mock('../../plugins/renderer-logger', () => ({
  rendererLog: vi.fn(),
}));

g.__annexMockState = {
  sendPtyInput: vi.fn(),
  sendClipboardImage: vi.fn(),
  requestPtyBuffer: vi.fn().mockResolvedValue(''),
  sendPtyResize: vi.fn(),
};

vi.mock('../../stores/annexClientStore', () => {
  const g = globalThis as any;
  const useAnnexClientStore: any = (selector: any) => selector(g.__annexMockState);
  useAnnexClientStore.getState = () => g.__annexMockState;
  useAnnexClientStore.setState = vi.fn();
  useAnnexClientStore.subscribe = vi.fn(() => vi.fn());
  return {
    useAnnexClientStore,
    satellitePtyDataBus: { on: vi.fn(() => vi.fn()) },
  };
});

vi.mock('../../themes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../themes')>();
  return {
    ...actual,
    getTheme: (id: string) => {
      if (id === 'catppuccin-latte') {
        return { terminal: { background: '#eff1f5', foreground: '#4c4f69' } };
      }
      return actual.getTheme(id);
    },
  };
});

vi.mock('../../stores/remoteProjectStore', () => ({
  isRemoteAgentId: (id: string) => id.startsWith('remote||'),
  parseNamespacedId: (id: string) => {
    if (!id.startsWith('remote||')) return null;
    const parts = id.split('||');
    return { satelliteId: parts[1], agentId: parts[2] };
  },
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
    g.__annexMockState = {
      sendPtyInput: vi.fn(),
      sendClipboardImage: vi.fn(),
      requestPtyBuffer: vi.fn().mockResolvedValue(''),
      sendPtyResize: vi.fn(),
    };
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
      theme: {
        terminal: { background: '#000', foreground: '#fff' },
        colors: { surface0: '#313244' },
      } as any,
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
      expect(term()).toBeDefined();
      expect(term().options.theme).toEqual({ background: '#000', foreground: '#fff' });
    });

    it('creates and loads FitAddon', () => {
      render(<AgentTerminal agentId="agent-1" />);
      expect(fitAddon()).toBeDefined();
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

    it('writes PTY data to terminal for matching agentId after buffer replay', async () => {
      render(<AgentTerminal agentId="agent-1" />);
      // Flush the getBuffer() microtask so bufferReplayed is set
      await act(async () => {});
      expect(mockOnDataCallback).toBeDefined();
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

      // Send data via onData BEFORE buffer resolves — should be queued, not written yet
      act(() => { mockOnDataCallback!('agent-1', 'live data'); });
      expect(term().write).not.toHaveBeenCalledWith('live data');

      // Now resolve the buffer — queued data should be replayed after snapshot
      await act(async () => { resolveBuffer!('buffered output'); });
      expect(term().write).toHaveBeenCalledWith('buffered output');
      expect(term().write).toHaveBeenCalledWith('live data');

      // Data arriving AFTER buffer replay should pass through
      act(() => { mockOnDataCallback!('agent-1', 'new data'); });
      expect(term().write).toHaveBeenCalledWith('new data');
    });

    it('queues multiple live data chunks during buffer fetch and replays in order', async () => {
      let resolveBuffer: (val: string) => void;
      (window.clubhouse.pty.getBuffer as any).mockReturnValue(
        new Promise<string>((r) => { resolveBuffer = r; })
      );

      render(<AgentTerminal agentId="agent-1" />);
      term().write.mockClear();

      // Send multiple chunks before buffer resolves
      act(() => { mockOnDataCallback!('agent-1', 'chunk1'); });
      act(() => { mockOnDataCallback!('agent-1', 'chunk2'); });
      act(() => { mockOnDataCallback!('agent-1', 'chunk3'); });
      expect(term().write).not.toHaveBeenCalled();

      // Resolve buffer — snapshot + all queued chunks should be written in order
      await act(async () => { resolveBuffer!('snapshot'); });
      const writeCalls = term().write.mock.calls.map((c: unknown[]) => c[0]);
      expect(writeCalls).toEqual(['snapshot', 'chunk1', 'chunk2', 'chunk3']);
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

  describe('gradient transparency', () => {
    it('uses transparent background when gradient is active', () => {
      useThemeStore.setState({
        theme: {
          terminal: { background: '#000', foreground: '#fff' },
          gradients: { background: 'linear-gradient(#1e1e2e, #000)' },
        } as any,
        experimentalGradients: true,
      });
      render(<AgentTerminal agentId="agent-1" />);
      expect(term().options.theme).toEqual({ background: 'transparent', foreground: '#fff' });
    });

    it('uses normal background when gradient is not active', () => {
      useThemeStore.setState({
        theme: {
          terminal: { background: '#000', foreground: '#fff' },
          gradients: { background: 'linear-gradient(#1e1e2e, #000)' },
        } as any,
        experimentalGradients: false,
      });
      render(<AgentTerminal agentId="agent-1" />);
      expect(term().options.theme).toEqual({ background: '#000', foreground: '#fff' });
    });

    it('uses normal background when no gradient background is defined', () => {
      useThemeStore.setState({
        theme: {
          terminal: { background: '#000', foreground: '#fff' },
        } as any,
        experimentalGradients: true,
      });
      render(<AgentTerminal agentId="agent-1" />);
      expect(term().options.theme).toEqual({ background: '#000', foreground: '#fff' });
    });

    it('live-updates to transparent when gradient is toggled on', () => {
      render(<AgentTerminal agentId="agent-1" />);
      act(() => {
        useThemeStore.setState({
          theme: {
            terminal: { background: '#000', foreground: '#fff' },
            gradients: { background: 'linear-gradient(#1e1e2e, #000)' },
          } as any,
          experimentalGradients: true,
        });
      });
      expect(term().options.theme).toEqual({ background: 'transparent', foreground: '#fff' });
    });
  });

  describe('experimental mono font', () => {
    it('updates terminal fontFamily when experimental mono font is set', () => {
      render(<AgentTerminal agentId="agent-1" />);
      act(() => {
        useThemeStore.setState({
          theme: {
            terminal: { background: '#000', foreground: '#fff' },
            fonts: { mono: "'Fira Code', monospace" },
          } as any,
          experimentalGradients: true,
        });
      });
      expect(term().options.fontFamily).toBe("'Fira Code', monospace");
    });

    it('does not update fontFamily when experimentalGradients is off', () => {
      render(<AgentTerminal agentId="agent-1" />);
      act(() => {
        useThemeStore.setState({
          theme: {
            terminal: { background: '#000', foreground: '#fff' },
            fonts: { mono: "'Fira Code', monospace" },
          } as any,
          experimentalGradients: false,
        });
      });
      expect(term().options.fontFamily).toBeUndefined();
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

  describe('remote file drop banner', () => {
    it('shows banner when files are dropped on a remote agent terminal', async () => {
      // Render first with real timers so requestAnimationFrame runs synchronously
      // (via the stubGlobal in beforeEach)
      await act(async () => {
        render(<AgentTerminal agentId="remote||sat-1||agent-1" />);
      });

      vi.useFakeTimers();

      const wrapper = screen.getByTestId('agent-terminal').parentElement!;
      const file = new File(['dummy'], 'test.txt', { type: 'text/plain' });
      const files = Object.assign([file], { item: (i: number) => [file][i] });
      const dataTransfer = { types: ['Files'], files, dropEffect: '' };

      fireEvent.dragOver(wrapper, { dataTransfer });
      fireEvent.drop(wrapper, { dataTransfer });

      expect(screen.getByTestId('remote-banner')).toBeInTheDocument();
      expect(screen.getByText('File drop is not supported on remote agents')).toBeInTheDocument();

      // Banner should auto-dismiss after 3 seconds
      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.queryByTestId('remote-banner')).toBeNull();

      vi.useRealTimers();
    });

    it('does not show banner for local agent file drop', async () => {
      render(<AgentTerminal agentId="agent-1" />);
      // Flush the getBuffer() microtask so the terminal is ready
      await act(async () => {});
      expect(screen.queryByTestId('remote-banner')).toBeNull();
    });
  });

  describe('scroll guardian and scroll-to-bottom button', () => {
    function configureViewport(scrollTop: number, scrollHeight: number, clientHeight: number) {
      const container = screen.getByTestId('agent-terminal');
      const viewport = container.querySelector('.xterm-viewport') as HTMLDivElement;
      expect(viewport).toBeTruthy();
      Object.defineProperty(viewport, 'scrollHeight', { value: scrollHeight, configurable: true, writable: true });
      Object.defineProperty(viewport, 'clientHeight', { value: clientHeight, configurable: true, writable: true });
      viewport.scrollTop = scrollTop;
      return viewport;
    }

    it('does not show scroll-to-bottom button when at bottom', () => {
      render(<AgentTerminal agentId="agent-1" />);
      // No viewport or at bottom — button should not show
      expect(screen.queryByTestId('scroll-to-bottom')).toBeNull();
    });

    it('shows scroll-to-bottom button when scrolled up', () => {
      render(<AgentTerminal agentId="agent-1" />);
      const viewport = configureViewport(100, 2000, 200);

      // Fire scroll event to trigger state update
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });

      expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument();
    });

    it('hides scroll-to-bottom button when user scrolls to bottom', () => {
      render(<AgentTerminal agentId="agent-1" />);
      const viewport = configureViewport(100, 2000, 200);

      // First, trigger scrolled-up state
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument();

      // Now scroll to bottom (scrollTop >= scrollHeight - clientHeight - 5)
      viewport.scrollTop = 1800;
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(screen.queryByTestId('scroll-to-bottom')).toBeNull();
    });

    it('clicking scroll-to-bottom scrolls viewport to bottom', () => {
      render(<AgentTerminal agentId="agent-1" />);
      const viewport = configureViewport(100, 2000, 200);

      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });

      const button = screen.getByTestId('scroll-to-bottom');
      fireEvent.click(button);

      // Should have set scrollTop to scrollHeight - clientHeight
      expect(viewport.scrollTop).toBe(1800);
    });

    it('scroll guardian detects unexpected reset to 0 and restores position', () => {
      render(<AgentTerminal agentId="agent-1" />);
      const viewport = configureViewport(500, 2000, 200);

      // Establish a known scroll position
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });

      // Simulate unexpected reset to 0 (from xterm reflow)
      viewport.scrollTop = 0;
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });

      // The scroll guardian should have restored to the previous position
      // (runs in rAF which is synchronous in tests)
      expect(viewport.scrollTop).toBe(500);
    });

    it('scroll guardian detects near-zero reset (not just exact 0)', () => {
      render(<AgentTerminal agentId="agent-1" />);
      const viewport = configureViewport(500, 2000, 200);

      // Establish a known scroll position
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });

      // Simulate near-zero reset (e.g. from rounding during xterm reflow)
      viewport.scrollTop = 5;
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });

      // Guard should still restore — NEAR_TOP_PX threshold is 10
      expect(viewport.scrollTop).toBe(500);
    });

    it('scroll guardian does not fire when lastKnown is below jump threshold', () => {
      render(<AgentTerminal agentId="agent-1" />);
      const viewport = configureViewport(20, 2000, 200);

      // Establish a low scroll position (below JUMP_MIN_PX of 30)
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });

      // Reset to 0 — should NOT trigger restore because 20 < JUMP_MIN_PX
      viewport.scrollTop = 0;
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });

      expect(viewport.scrollTop).toBe(0);
    });

    it('does not show scroll-to-bottom button during resume', () => {
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

      render(<AgentTerminal agentId="agent-1" />);
      const viewport = configureViewport(100, 2000, 200);

      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });

      // Button hidden during resume even when scrolled up
      expect(screen.queryByTestId('scroll-to-bottom')).toBeNull();
      // But the resume overlay should be visible
      expect(screen.getByTestId('resume-overlay')).toBeInTheDocument();
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

  describe('zone theme override', () => {
    it('uses zone theme terminal colors when zoneThemeId is provided', () => {
      render(<AgentTerminal agentId="agent-1" zoneThemeId="catppuccin-latte" />);
      expect(term().options.theme).toEqual({ background: '#eff1f5', foreground: '#4c4f69' });
    });

    it('falls back to global theme when zoneThemeId is unknown', () => {
      render(<AgentTerminal agentId="agent-1" zoneThemeId="nonexistent-theme" />);
      expect(term().options.theme).toEqual({ background: '#000', foreground: '#fff' });
    });

    it('live-updates terminal colors when zoneThemeId changes', () => {
      const { rerender } = render(<AgentTerminal agentId="agent-1" />);
      expect(term().options.theme).toEqual({ background: '#000', foreground: '#fff' });

      rerender(<AgentTerminal agentId="agent-1" zoneThemeId="catppuccin-latte" />);
      expect(term().options.theme).toEqual({ background: '#eff1f5', foreground: '#4c4f69' });
    });

    it('does not use transparent background for zone-themed terminal even with gradient', () => {
      useThemeStore.setState({
        theme: {
          terminal: { background: '#000', foreground: '#fff' },
          gradients: { background: 'linear-gradient(#1e1e2e, #000)' },
        } as any,
        experimentalGradients: true,
      });
      render(<AgentTerminal agentId="agent-1" zoneThemeId="catppuccin-latte" />);
      // Zone theme should use its own background, not transparent
      expect(term().options.theme).toEqual({ background: '#eff1f5', foreground: '#4c4f69' });
    });
  });

  describe('markUserInputLine handle', () => {
    it('registers a decoration on the current cursor row with surface0 color', () => {
      const ref = { current: null } as React.RefObject<import('./AgentTerminal').AgentTerminalHandle>;
      render(<AgentTerminal ref={ref} agentId="agent-1" />);

      ref.current!.markUserInputLine();

      expect(term().registerMarker).toHaveBeenCalledWith(0);
      expect(term().registerDecoration).toHaveBeenCalledWith(
        expect.objectContaining({
          x: 0,
          width: 80,
          height: 1,
          layer: 'top',
          backgroundColor: '#313244', // surface0 from test theme
        }),
      );
    });

    it('uses the latest surface0 color when the theme changes before calling', () => {
      const ref = { current: null } as React.RefObject<import('./AgentTerminal').AgentTerminalHandle>;
      render(<AgentTerminal ref={ref} agentId="agent-1" />);

      act(() => {
        useThemeStore.setState({
          theme: {
            terminal: { background: '#eff1f5', foreground: '#4c4f69' },
            colors: { surface0: '#ccd0da' }, // Latte surface0
          } as any,
        });
      });

      ref.current!.markUserInputLine();

      expect(term().registerDecoration).toHaveBeenCalledWith(
        expect.objectContaining({ backgroundColor: '#ccd0da' }),
      );
    });

    it('is a no-op before the terminal mounts (no crash)', () => {
      // Create a ref but don't render yet — ref.current is null
      const ref = { current: null } as React.RefObject<import('./AgentTerminal').AgentTerminalHandle>;
      // Should not throw
      expect(() => ref.current?.markUserInputLine()).not.toThrow();
    });

    it('is a no-op when registerMarker returns null', () => {
      const ref = { current: null } as React.RefObject<import('./AgentTerminal').AgentTerminalHandle>;
      render(<AgentTerminal ref={ref} agentId="agent-1" />);
      term().registerMarker.mockReturnValueOnce(null);

      expect(() => ref.current!.markUserInputLine()).not.toThrow();
      expect(term().registerDecoration).not.toHaveBeenCalled();
    });
  });

  describe('Enter-key internal decoration trigger', () => {
    it('places a decoration on \\r (Enter) in canvas/PTY mode', () => {
      render(<AgentTerminal agentId="agent-1" />);
      const onDataCb = term().onData.mock.calls[0][0];

      onDataCb('\r');

      expect(term().registerMarker).toHaveBeenCalledWith(0);
      expect(term().registerDecoration).toHaveBeenCalledWith(
        expect.objectContaining({
          x: 0,
          width: 80,
          height: 1,
          layer: 'top',
          backgroundColor: '#313244',
        }),
      );
    });

    it('does not place a decoration for non-Enter keystrokes', () => {
      render(<AgentTerminal agentId="agent-1" />);
      const onDataCb = term().onData.mock.calls[0][0];

      onDataCb('a');
      onDataCb('b');
      onDataCb('\t');

      expect(term().registerDecoration).not.toHaveBeenCalled();
    });

    it('still forwards \\r to PTY after placing decoration', () => {
      render(<AgentTerminal agentId="agent-1" />);
      const onDataCb = term().onData.mock.calls[0][0];

      onDataCb('\r');

      expect(window.clubhouse.pty.write).toHaveBeenCalledWith('agent-1', '\r');
    });
  });
});
