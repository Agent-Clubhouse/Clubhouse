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
});
