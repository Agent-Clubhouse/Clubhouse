import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron modules before importing handler
vi.mock('electron', () => {
  const mockWindows: any[] = [];
  let nextId = 1;

  class MockBrowserWindow {
    id: number;
    destroyed = false;
    loadURLCalled = '';
    shown = false;
    closed = false;
    options: any;
    _readyCallback: (() => void) | null = null;

    constructor(options: any) {
      this.id = nextId++;
      this.options = options;
      mockWindows.push(this);
    }

    loadURL(url: string) { this.loadURLCalled = url; }
    show() { this.shown = true; }
    isDestroyed() { return this.destroyed; }
    close() { this.closed = true; }
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

describe('window-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    (BrowserWindow as any)._reset();
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

    const listHandler = handlers.get(IPC.WINDOW.LIST_POPOUTS)!;
    const windows = BrowserWindow.getAllWindows();
    const win = windows.find((w: any) => w.id === windowId);
    expect(win?.closed).toBe(true);
  });
});
