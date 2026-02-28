import { describe, it, expect, beforeEach, vi } from 'vitest';

// Define webpack globals before import
(globalThis as any).MAIN_WINDOW_WEBPACK_ENTRY = 'http://localhost:3000';
(globalThis as any).MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY = '/path/to/preload.js';

// Mock electron modules before importing handler
vi.mock('electron', () => {
  const mockWindows: any[] = [];
  let nextId = 1;
  const onceListeners = new Map<string, ((...args: any[]) => void)[]>();

  class MockBrowserWindow {
    id: number;
    destroyed = false;
    loadURLCalled = '';
    shown = false;
    closed = false;
    focused = false;
    minimized = false;
    options: any;
    _readyCallback: (() => void) | null = null;
    webContents = { send: vi.fn() };

    constructor(options: any) {
      this.id = nextId++;
      this.options = options;
      mockWindows.push(this);
    }

    loadURL(url: string) { this.loadURLCalled = url; }
    show() { this.shown = true; }
    isDestroyed() { return this.destroyed; }
    close() { this.closed = true; }
    focus() { this.focused = true; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    once(event: string, cb: () => void) {
      if (event === 'ready-to-show') this._readyCallback = cb;
    }
    on(_event: string, _cb: () => void) {}

    static getAllWindows() { return mockWindows.filter(w => !w.destroyed); }
    static _reset() { mockWindows.length = 0; nextId = 1; }
  }

  return {
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      once: vi.fn((channel: string, cb: (...args: any[]) => void) => {
        const list = onceListeners.get(channel) || [];
        list.push(cb);
        onceListeners.set(channel, list);
      }),
      emit: vi.fn((channel: string, ...args: any[]) => {
        const list = onceListeners.get(channel) || [];
        for (const cb of list) cb(...args);
        onceListeners.delete(channel);
      }),
      removeAllListeners: vi.fn((channel: string) => {
        onceListeners.delete(channel);
      }),
      removeListener: vi.fn((channel: string, handler: (...args: any[]) => void) => {
        const list = onceListeners.get(channel);
        if (list) {
          const idx = list.indexOf(handler);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) onceListeners.delete(channel);
        }
      }),
      _resetOnceListeners: () => onceListeners.clear(),
    },
  };
});

vi.mock('../services/theme-service', () => ({
  getSettings: () => ({ themeId: 'catppuccin-mocha' }),
}));

vi.mock('../title-bar-colors', () => ({
  getThemeColorsForTitleBar: () => ({ bg: '#000', mantle: '#111', text: '#fff' }),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

import { BrowserWindow, ipcMain } from 'electron';
import { registerWindowHandlers } from './window-handlers';
import { IPC } from '../../shared/ipc-channels';

/** Helper: find an ipcMain.on() handler by channel name. */
function findOnHandler(channel: string): ((...args: any[]) => void) | undefined {
  const onCalls = (ipcMain.on as any).mock.calls;
  return onCalls.find((call: any[]) => call[0] === channel)?.[1];
}

describe('window-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    (BrowserWindow as any)._reset();
    (ipcMain as any)._resetOnceListeners();
    vi.clearAllMocks();
    handlers = new Map();
    (ipcMain.handle as any).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerWindowHandlers();
  });

  it('registers all window IPC handlers', () => {
    expect(handlers.has(IPC.WINDOW.CREATE_POPOUT)).toBe(true);
    expect(handlers.has(IPC.WINDOW.CLOSE_POPOUT)).toBe(true);
    expect(handlers.has(IPC.WINDOW.LIST_POPOUTS)).toBe(true);
    expect(handlers.has(IPC.WINDOW.FOCUS_MAIN)).toBe(true);
    expect(handlers.has(IPC.WINDOW.GET_AGENT_STATE)).toBe(true);
  });

  it('CREATE_POPOUT creates a new window and returns its ID', async () => {
    const handler = handlers.get(IPC.WINDOW.CREATE_POPOUT)!;
    const windowId = await handler({}, { type: 'agent', agentId: 'a1', projectId: 'p1' });
    expect(typeof windowId).toBe('number');
  });

  it('LIST_POPOUTS returns created windows', async () => {
    const createHandler = handlers.get(IPC.WINDOW.CREATE_POPOUT)!;
    await createHandler({}, { type: 'agent', agentId: 'a1' });

    const listHandler = handlers.get(IPC.WINDOW.LIST_POPOUTS)!;
    const list = await listHandler({});
    expect(list.length).toBe(1);
    expect(list[0].params.type).toBe('agent');
  });

  it('CLOSE_POPOUT closes a window', async () => {
    const createHandler = handlers.get(IPC.WINDOW.CREATE_POPOUT)!;
    const windowId = await createHandler({}, { type: 'hub' });

    const closeHandler = handlers.get(IPC.WINDOW.CLOSE_POPOUT)!;
    await closeHandler({}, windowId);

    const windows = BrowserWindow.getAllWindows();
    const win = windows.find((w: any) => w.id === windowId);
    expect(win?.closed).toBe(true);
  });

  it('FOCUS_MAIN focuses the main window (non-popout)', async () => {
    const mainWin = new (BrowserWindow as any)({});
    const createHandler = handlers.get(IPC.WINDOW.CREATE_POPOUT)!;
    await createHandler({}, { type: 'agent', agentId: 'a1' });

    const focusHandler = handlers.get(IPC.WINDOW.FOCUS_MAIN)!;
    await focusHandler({});

    expect(mainWin.focused).toBe(true);
  });

  it('FOCUS_MAIN sends navigate-to-agent when agentId is provided', async () => {
    const mainWin = new (BrowserWindow as any)({});

    const focusHandler = handlers.get(IPC.WINDOW.FOCUS_MAIN)!;
    await focusHandler({}, 'agent-123');

    expect(mainWin.focused).toBe(true);
    expect(mainWin.webContents.send).toHaveBeenCalledWith(
      IPC.WINDOW.NAVIGATE_TO_AGENT,
      'agent-123',
    );
  });

  // ── Agent state: relay (cold cache) ─────────────────────────────────

  it('GET_AGENT_STATE relays via REQUEST_AGENT_STATE when cache is cold', async () => {
    const mainWin = new (BrowserWindow as any)({});
    const handler = handlers.get(IPC.WINDOW.GET_AGENT_STATE)!;

    const statePromise = handler({});

    expect(mainWin.webContents.send).toHaveBeenCalledWith(
      IPC.WINDOW.REQUEST_AGENT_STATE,
      expect.any(String),
    );

    // Simulate the main renderer responding
    const requestId = mainWin.webContents.send.mock.calls[0][1];
    const mockState = {
      agents: { 'a1': { id: 'a1', name: 'test' } },
      agentDetailedStatus: {},
      agentIcons: {},
    };

    const responseHandler = findOnHandler(IPC.WINDOW.AGENT_STATE_RESPONSE);
    expect(responseHandler).toBeDefined();
    responseHandler!({}, requestId, mockState);

    const result = await statePromise;
    expect(result).toEqual(mockState);
  });

  it('GET_AGENT_STATE returns empty state when no main window exists', async () => {
    const handler = handlers.get(IPC.WINDOW.GET_AGENT_STATE)!;
    const result = await handler({});
    expect(result).toEqual({ agents: {}, agentDetailedStatus: {}, agentIcons: {} });
  });

  it('GET_AGENT_STATE times out after 1.5s (reduced from 5s)', async () => {
    vi.useFakeTimers();
    new (BrowserWindow as any)({});
    const handler = handlers.get(IPC.WINDOW.GET_AGENT_STATE)!;

    const statePromise = handler({});

    // 1.5s timeout (reduced from 5s)
    vi.advanceTimersByTime(1500);

    const result = await statePromise;
    expect(result).toEqual({ agents: {}, agentDetailedStatus: {}, agentIcons: {} });

    vi.useRealTimers();
  });

  // ── Agent state: caching ────────────────────────────────────────────

  it('GET_AGENT_STATE serves from cache after AGENT_STATE_CHANGED broadcast', async () => {
    const mainWin = new (BrowserWindow as any)({});
    const cachedState = {
      agents: { a1: { id: 'a1', name: 'cached' } },
      agentDetailedStatus: { a1: { status: 'idle' } },
      agentIcons: { a1: 'icon.png' },
    };

    // Simulate main renderer broadcasting agent state
    const broadcastHandler = findOnHandler(IPC.WINDOW.AGENT_STATE_CHANGED);
    expect(broadcastHandler).toBeDefined();
    broadcastHandler!({}, cachedState);

    // Now GET_AGENT_STATE should return cached state instantly (no relay)
    const handler = handlers.get(IPC.WINDOW.GET_AGENT_STATE)!;
    const result = await handler({});
    expect(result).toEqual(cachedState);

    // Should NOT have sent REQUEST_AGENT_STATE (served from cache)
    expect(mainWin.webContents.send).not.toHaveBeenCalledWith(
      IPC.WINDOW.REQUEST_AGENT_STATE,
      expect.any(String),
    );
  });

  // ── Agent state: batching ──────────────────────────────────────────

  it('GET_AGENT_STATE batches concurrent requests into a single relay', async () => {
    const mainWin = new (BrowserWindow as any)({});
    const handler = handlers.get(IPC.WINDOW.GET_AGENT_STATE)!;

    // Fire two concurrent requests
    const promise1 = handler({});
    const promise2 = handler({});

    // Only ONE relay should have been sent
    const relayCalls = mainWin.webContents.send.mock.calls.filter(
      (call: any[]) => call[0] === IPC.WINDOW.REQUEST_AGENT_STATE,
    );
    expect(relayCalls.length).toBe(1);

    // Respond to the single relay
    const requestId = relayCalls[0][1];
    const mockState = { agents: { a1: { id: 'a1' } }, agentDetailedStatus: {}, agentIcons: {} };
    const responseHandler = findOnHandler(IPC.WINDOW.AGENT_STATE_RESPONSE);
    responseHandler!({}, requestId, mockState);

    // Both promises should resolve with the same state
    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1).toEqual(mockState);
    expect(result2).toEqual(mockState);
  });

  // ── Agent state: broadcast forwarding ───────────────────────────────

  it('AGENT_STATE_CHANGED is forwarded to all popout windows', async () => {
    // Create two popouts
    const createHandler = handlers.get(IPC.WINDOW.CREATE_POPOUT)!;
    await createHandler({}, { type: 'agent', agentId: 'a1' });
    await createHandler({}, { type: 'agent', agentId: 'a2' });

    const popoutWindows = BrowserWindow.getAllWindows();
    expect(popoutWindows.length).toBe(2);

    const broadcastState = {
      agents: { a1: { id: 'a1', status: 'running' } },
      agentDetailedStatus: {},
      agentIcons: {},
    };

    // Simulate main renderer broadcasting
    const broadcastHandler = findOnHandler(IPC.WINDOW.AGENT_STATE_CHANGED);
    broadcastHandler!({}, broadcastState);

    // Both popouts should receive the broadcast
    for (const win of popoutWindows) {
      expect((win as any).webContents.send).toHaveBeenCalledWith(
        IPC.WINDOW.AGENT_STATE_CHANGED,
        broadcastState,
      );
    }
  });

  // ── Hub state: caching ──────────────────────────────────────────────

  it('GET_HUB_STATE serves from cache after HUB_STATE_CHANGED broadcast', async () => {
    const mainWin = new (BrowserWindow as any)({});
    const cachedHub = {
      hubId: 'hub-1',
      paneTree: { id: 'root', type: 'leaf' },
      focusedPaneId: 'root',
      zoomedPaneId: null,
    };

    // Simulate main renderer broadcasting hub state
    const broadcastHandler = findOnHandler(IPC.WINDOW.HUB_STATE_CHANGED);
    broadcastHandler!({}, cachedHub);

    // Now GET_HUB_STATE should return cached state instantly
    const handler = handlers.get(IPC.WINDOW.GET_HUB_STATE)!;
    const result = await handler({}, 'hub-1', 'global');
    expect(result).toEqual(cachedHub);

    // Should NOT have sent REQUEST_HUB_STATE (served from cache)
    expect(mainWin.webContents.send).not.toHaveBeenCalledWith(
      IPC.WINDOW.REQUEST_HUB_STATE,
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('GET_HUB_STATE falls back to relay when cache misses', async () => {
    const mainWin = new (BrowserWindow as any)({});
    const handler = handlers.get(IPC.WINDOW.GET_HUB_STATE)!;

    const statePromise = handler({}, 'hub-1', 'global');

    // Should have sent a relay request
    expect(mainWin.webContents.send).toHaveBeenCalledWith(
      IPC.WINDOW.REQUEST_HUB_STATE,
      expect.any(String),
      'hub-1',
      'global',
      undefined,
    );

    // Respond to the relay
    const requestId = mainWin.webContents.send.mock.calls[0][1];
    const mockHub = {
      hubId: 'hub-1',
      paneTree: { id: 'root' },
      focusedPaneId: 'root',
      zoomedPaneId: null,
    };
    const responseHandler = findOnHandler(IPC.WINDOW.HUB_STATE_RESPONSE);
    responseHandler!({}, requestId, mockHub);

    const result = await statePromise;
    expect(result).toEqual(mockHub);
  });

  it('GET_HUB_STATE times out after 1.5s (reduced from 5s)', async () => {
    vi.useFakeTimers();
    new (BrowserWindow as any)({});
    const handler = handlers.get(IPC.WINDOW.GET_HUB_STATE)!;

    const statePromise = handler({}, 'hub-1', 'global');

    vi.advanceTimersByTime(1500);

    const result = await statePromise;
    expect(result).toBeNull();

    vi.useRealTimers();
  });

  it('LIST_POPOUTS cleans up destroyed windows', async () => {
    const createHandler = handlers.get(IPC.WINDOW.CREATE_POPOUT)!;
    await createHandler({}, { type: 'agent', agentId: 'a1' });
    await createHandler({}, { type: 'agent', agentId: 'a2' });

    // Mark the first window as destroyed
    const allWindows = BrowserWindow.getAllWindows();
    // The first popout is the one we want to destroy
    // getAllWindows returns non-destroyed windows, but we need the actual instance
    // Let's destroy the underlying window object
    const firstWin = allWindows[0] as any;
    firstWin.destroyed = true;

    const listHandler = handlers.get(IPC.WINDOW.LIST_POPOUTS)!;
    const list = await listHandler({});

    // Only one window should be listed (the non-destroyed one)
    expect(list.length).toBe(1);

    // Call list again — the stale entry should have been cleaned up in the first call
    const list2 = await listHandler({});
    expect(list2.length).toBe(1);
  });

  it('GET_AGENT_STATE does not call removeListener when response arrives before timeout', async () => {
    const mainWin = new (BrowserWindow as any)({});
    const handler = handlers.get(IPC.WINDOW.GET_AGENT_STATE)!;

    const statePromise = handler({});

    const requestId = mainWin.webContents.send.mock.calls[0][1];
    const mockState = { agents: { a1: { id: 'a1' } }, agentDetailedStatus: {}, agentIcons: {} };

    const responseHandler = findOnHandler(IPC.WINDOW.AGENT_STATE_RESPONSE);
    responseHandler!({}, requestId, mockState);

    const result = await statePromise;
    expect(result).toEqual(mockState);

    // removeListener should NOT have been called (timeout was cleared)
    const channel = `${IPC.WINDOW.AGENT_STATE_RESPONSE}:${requestId}`;
    const removeListenerCalls = (ipcMain.removeListener as any).mock.calls.filter(
      (call: any[]) => call[0] === channel,
    );
    expect(removeListenerCalls.length).toBe(0);
  });

  // ── Hub state: broadcast forwarding ─────────────────────────────────

  it('HUB_STATE_CHANGED is forwarded to all popout windows', async () => {
    const createHandler = handlers.get(IPC.WINDOW.CREATE_POPOUT)!;
    await createHandler({}, { type: 'hub', hubId: 'hub-1' });
    await createHandler({}, { type: 'hub', hubId: 'hub-1' });

    const popoutWindows = BrowserWindow.getAllWindows();

    const hubState = {
      hubId: 'hub-1',
      paneTree: { id: 'root' },
      focusedPaneId: 'root',
      zoomedPaneId: null,
    };

    const broadcastHandler = findOnHandler(IPC.WINDOW.HUB_STATE_CHANGED);
    broadcastHandler!({}, hubState);

    for (const win of popoutWindows) {
      expect((win as any).webContents.send).toHaveBeenCalledWith(
        IPC.WINDOW.HUB_STATE_CHANGED,
        hubState,
      );
    }
  });

  // ── Hub mutation forwarding ──────────────────────────────────────────

  it('HUB_MUTATION is forwarded to the main window', async () => {
    const mainWin = new (BrowserWindow as any)({});
    // Create a popout so mainWin is distinguishable
    const createHandler = handlers.get(IPC.WINDOW.CREATE_POPOUT)!;
    await createHandler({}, { type: 'hub', hubId: 'hub-1' });

    const mutationHandler = findOnHandler(IPC.WINDOW.HUB_MUTATION);
    expect(mutationHandler).toBeDefined();

    const mutation = { type: 'split', paneId: 'p1', direction: 'horizontal', position: 'after' };
    mutationHandler!({}, 'hub-1', 'global', mutation);

    expect(mainWin.webContents.send).toHaveBeenCalledWith(
      IPC.WINDOW.REQUEST_HUB_MUTATION,
      'hub-1',
      'global',
      mutation,
    );
  });
});
