/**
 * Write-batching tests for AgentTerminal.
 *
 * Isolated in a separate file to avoid rAF mock lifecycle conflicts with
 * other AgentTerminal tests (specifically the resume overlay tests that use
 * vi.useFakeTimers, which corrupts vi.stubGlobal rAF state via restoreMocks).
 */
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useThemeStore } from '../../stores/themeStore';
import { useAgentStore } from '../../stores/agentStore';
import { useClipboardSettingsStore } from '../../stores/clipboardSettingsStore';

// Shared state holders for mock instances
const g = globalThis as any;
g.__testTerminal = null;
g.__testFitAddon = null;
g.__testAttachClipboard = vi.fn().mockReturnValue(vi.fn());

vi.mock('@xterm/xterm', () => {
  class Terminal {
    loadAddon = vi.fn();
    open = vi.fn().mockImplementation((container: HTMLElement) => {
      const viewport = document.createElement('div');
      viewport.classList.add('xterm-viewport');
      Object.defineProperty(viewport, 'scrollHeight', { value: 200, configurable: true, writable: true });
      Object.defineProperty(viewport, 'clientHeight', { value: 200, configurable: true, writable: true });
      viewport.scrollTop = 0;
      container.appendChild(viewport);
    });
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
  return { ...actual };
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
const mockRemoveDataListener = vi.fn();
const mockRemoveExitListener = vi.fn();
const mockDisconnect = vi.fn();

describe('AgentTerminal write batching', () => {
  let rafQueue: Array<() => void>;

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
    mockRemoveDataListener.mockClear();
    mockRemoveExitListener.mockClear();
    mockDisconnect.mockClear();

    // Deferred rAF — queue callbacks instead of firing immediately
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      if (id > 0 && id <= rafQueue.length) rafQueue[id - 1] = () => {};
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = mockDisconnect;
      unobserve = vi.fn();
    });

    window.clubhouse.pty.write = vi.fn();
    window.clubhouse.pty.resize = vi.fn();
    window.clubhouse.pty.getBuffer = vi.fn().mockResolvedValue('');
    window.clubhouse.pty.onData = vi.fn().mockImplementation((cb: any) => {
      mockOnDataCallback = cb;
      return mockRemoveDataListener;
    });
    window.clubhouse.pty.onExit = vi.fn().mockImplementation((cb: any) => {
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

    useAgentStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          projectId: 'proj-1',
          name: 'test',
          kind: 'durable',
          status: 'running',
          color: 'indigo',
        },
      },
    });
  });

  function term() { return g.__testTerminal; }

  function flushRAF() {
    while (rafQueue.length) rafQueue.shift()!();
  }

  async function mountAndInit() {
    render(<AgentTerminal agentId="agent-1" />);
    // Flush mount rAF → getBuffer().then() → bufferReplayed = true
    await act(async () => { flushRAF(); });
    term().write.mockClear();
    rafQueue.length = 0;
  }

  it('batches multiple data chunks into a single term.write call', async () => {
    await mountAndInit();

    // Simulate 5 rapid data chunks — rAF won't fire until we flush
    act(() => {
      mockOnDataCallback!('agent-1', 'chunk1');
      mockOnDataCallback!('agent-1', 'chunk2');
      mockOnDataCallback!('agent-1', 'chunk3');
      mockOnDataCallback!('agent-1', 'chunk4');
      mockOnDataCallback!('agent-1', 'chunk5');
    });

    // No writes yet — batched, waiting for rAF
    expect(term().write).not.toHaveBeenCalled();

    // Flush the batched write
    act(() => { flushRAF(); });

    expect(term().write).toHaveBeenCalledTimes(1);
    expect(term().write).toHaveBeenCalledWith('chunk1chunk2chunk3chunk4chunk5');
  });

  it('allows subsequent batches after a flush', async () => {
    await mountAndInit();

    // First batch
    act(() => {
      mockOnDataCallback!('agent-1', 'a');
      mockOnDataCallback!('agent-1', 'b');
    });
    act(() => { flushRAF(); });
    expect(term().write).toHaveBeenCalledWith('ab');

    term().write.mockClear();
    rafQueue.length = 0;

    // Second batch
    act(() => {
      mockOnDataCallback!('agent-1', 'c');
      mockOnDataCallback!('agent-1', 'd');
    });
    act(() => { flushRAF(); });
    expect(term().write).toHaveBeenCalledWith('cd');
  });

  it('cancels pending flush on unmount', async () => {
    const { unmount } = render(<AgentTerminal agentId="agent-1" />);
    await act(async () => { flushRAF(); });
    term().write.mockClear();
    rafQueue.length = 0;

    act(() => { mockOnDataCallback!('agent-1', 'pending'); });
    expect(rafQueue.length).toBeGreaterThan(0);

    unmount();

    // Flush after unmount — cancelled callbacks should be no-ops
    flushRAF();
    expect(term().write).not.toHaveBeenCalled();
  });

  it('does not batch data for non-matching agent IDs', async () => {
    await mountAndInit();
    const countAfterMount = rafQueue.length;

    act(() => { mockOnDataCallback!('agent-2', 'other data'); });

    // No new rAF scheduled for non-matching agent
    expect(rafQueue.length).toBe(countAfterMount);
  });
});
