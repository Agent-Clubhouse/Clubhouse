import { render, act } from '@testing-library/react';
import { UtilityTerminal } from './UtilityTerminal';
import { useThemeStore } from '../../stores/themeStore';

// Mock xterm Terminal and FitAddon — use inline implementations instead of vi.fn()
// because mockReset:true clears return values between tests.

const g = globalThis as any;
g.__testTerminal = null;

vi.mock('@xterm/xterm', () => {
  const TerminalClass = function (this: any) {
    this.open = () => {};
    this.write = () => {};
    this.dispose = () => {};
    this.loadAddon = () => {};
    this.onData = () => ({ dispose: () => {} });
    this.cols = 80;
    this.rows = 24;
    this.options = {};
    (globalThis as any).__testTerminal = this;
  };
  return { Terminal: TerminalClass };
});

vi.mock('@xterm/addon-fit', () => {
  const FitAddonClass = function (this: any) {
    this.fit = () => {};
  };
  return { FitAddon: FitAddonClass };
});

function term() { return g.__testTerminal; }

function resetStores() {
  useThemeStore.setState({
    theme: {
      terminal: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
      },
    } as any,
    experimentalGradients: false,
  });
}

describe('UtilityTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();

    window.clubhouse.pty.spawnShell = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.pty.write = vi.fn();
    window.clubhouse.pty.resize = vi.fn();
    window.clubhouse.pty.kill = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.pty.onData = vi.fn().mockReturnValue(vi.fn());
  });

  it('renders without crash', () => {
    const { container } = render(
      <UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />,
    );
    expect(container.querySelector('div')).toBeInTheDocument();
  });

  it('kills previous PTY before spawning new shell', () => {
    render(<UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />);
    expect(window.clubhouse.pty.kill).toHaveBeenCalledWith('utility_agent-1');
  });

  it('sets up data listener', () => {
    render(<UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />);
    expect(window.clubhouse.pty.onData).toHaveBeenCalled();
  });

  it('renders container with padding', () => {
    const { container } = render(
      <UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />,
    );
    const terminalDiv = container.querySelector('[style*="padding"]');
    expect(terminalDiv).toBeInTheDocument();
  });

  it('uses transparent background when gradient is active', () => {
    useThemeStore.setState({
      theme: {
        terminal: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
        gradients: { background: 'linear-gradient(#1e1e2e, #000)' },
      } as any,
      experimentalGradients: true,
    });
    render(<UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />);
    expect(term().options.theme).toEqual({
      background: 'transparent', foreground: '#cdd6f4', cursor: '#f5e0dc',
    });
  });

  it('uses normal background when gradient is not active', () => {
    render(<UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />);
    expect(term().options.theme).toEqual({
      background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
    });
  });

  it('live-updates to transparent when gradient is toggled on', () => {
    render(<UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />);
    act(() => {
      useThemeStore.setState({
        theme: {
          terminal: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
          gradients: { background: 'linear-gradient(#1e1e2e, #000)' },
        } as any,
        experimentalGradients: true,
      });
    });
    expect(term().options.theme).toEqual({
      background: 'transparent', foreground: '#cdd6f4', cursor: '#f5e0dc',
    });
  });

  it('updates terminal fontFamily when experimental mono font is set', () => {
    render(<UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />);
    act(() => {
      useThemeStore.setState({
        theme: {
          terminal: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
          fonts: { mono: "'Fira Code', monospace" },
        } as any,
        experimentalGradients: true,
      });
    });
    expect(term().options.fontFamily).toBe("'Fira Code', monospace");
  });

  it('does not update fontFamily when experimentalGradients is off', () => {
    render(<UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />);
    act(() => {
      useThemeStore.setState({
        theme: {
          terminal: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
          fonts: { mono: "'Fira Code', monospace" },
        } as any,
        experimentalGradients: false,
      });
    });
    expect(term().options.fontFamily).toBeUndefined();
  });

  describe('write batching', () => {
    let rafQueue: Array<{ id: number; cb: () => void }> = [];
    let nextRafId: number;
    let mockOnDataCallback: ((id: string, data: string) => void) | null = null;

    function flushRAF() {
      const current = [...rafQueue];
      rafQueue = [];
      current.forEach(({ cb }) => cb());
    }

    beforeEach(() => {
      rafQueue = [];
      nextRafId = 1;
      mockOnDataCallback = null;
      vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
        const id = nextRafId++;
        rafQueue.push({ id, cb });
        return id;
      });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        rafQueue = rafQueue.filter((entry) => entry.id !== id);
      });
      window.clubhouse.pty.onData = vi.fn().mockImplementation((cb: any) => {
        mockOnDataCallback = cb;
        return vi.fn();
      });
      // Make write observable
      g.__testTerminal = null;
    });

    it('batches multiple data chunks into a single term.write call', () => {
      render(<UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />);
      // Flush mount rAFs (fit/resize)
      flushRAF();
      term().write = vi.fn();

      // Simulate rapid data chunks
      act(() => {
        mockOnDataCallback!('utility_agent-1', 'chunk1');
        mockOnDataCallback!('utility_agent-1', 'chunk2');
        mockOnDataCallback!('utility_agent-1', 'chunk3');
      });

      // No writes yet — waiting for rAF
      expect(term().write).not.toHaveBeenCalled();

      // Flush
      act(() => { flushRAF(); });

      expect(term().write).toHaveBeenCalledTimes(1);
      expect(term().write).toHaveBeenCalledWith('chunk1chunk2chunk3');
    });

    it('allows subsequent batches after a flush', () => {
      render(<UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />);
      flushRAF();
      term().write = vi.fn();

      act(() => {
        mockOnDataCallback!('utility_agent-1', 'a');
        mockOnDataCallback!('utility_agent-1', 'b');
      });
      act(() => { flushRAF(); });
      expect(term().write).toHaveBeenCalledWith('ab');

      term().write = vi.fn();

      act(() => {
        mockOnDataCallback!('utility_agent-1', 'c');
        mockOnDataCallback!('utility_agent-1', 'd');
      });
      act(() => { flushRAF(); });
      expect(term().write).toHaveBeenCalledWith('cd');
    });

    it('cancels pending flush on unmount', () => {
      const { unmount } = render(
        <UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />,
      );
      flushRAF();
      term().write = vi.fn();

      act(() => { mockOnDataCallback!('utility_agent-1', 'pending'); });
      expect(rafQueue.length).toBeGreaterThan(0);

      unmount();

      flushRAF();
      expect(term().write).not.toHaveBeenCalled();
    });

    it('does not schedule rAF for non-matching PTY IDs', () => {
      render(<UtilityTerminal agentId="agent-1" worktreePath="/worktrees/agent-1" />);
      flushRAF();
      const queueLengthAfterMount = rafQueue.length;

      act(() => { mockOnDataCallback!('utility_agent-2', 'other data'); });

      expect(rafQueue.length).toBe(queueLengthAfterMount);
    });
  });
});
