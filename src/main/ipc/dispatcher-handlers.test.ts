import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatcherState } from '../../shared/dispatcher-types';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listener: null as ((s: DispatcherState) => void) | null,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => { h.handlers.set(ch, fn); }) },
}));

const ON: DispatcherState = { enabled: true, flagOn: true, agentId: 'disp', path: 'dispatcher-folder', config: null };
vi.mock('../services/dispatcher/dispatcher-service', () => ({
  getDispatcherState: vi.fn(() => ON),
  setDispatcherEnabled: vi.fn(async (on: boolean) => ({ ...ON, enabled: on })),
  onDispatcherChanged: vi.fn((l: (s: DispatcherState) => void) => { h.listener = l; return () => {}; }),
  initDispatcher: vi.fn(async () => undefined),
}));
vi.mock('../services/dispatcher/dispatcher-clear-chat', () => ({ clearDispatcherChat: vi.fn(async () => ({ cleared: 'now' })) }));
vi.mock('../services/dispatcher/dispatcher-news', () => ({ installGroupChat: vi.fn() }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('./mcp-binding-handlers', () => ({ restorePersistedBindings: vi.fn(async () => {}) }));

import { IPC } from '../../shared/ipc-channels';
import * as dispatcher from '../services/dispatcher/dispatcher-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { restorePersistedBindings } from './mcp-binding-handlers';
import { clearDispatcherChat } from '../services/dispatcher/dispatcher-clear-chat';
import { installGroupChat } from '../services/dispatcher/dispatcher-news';
import { registerDispatcherHandlers, _resetDispatcherHandlersForTesting } from './dispatcher-handlers';

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  _resetDispatcherHandlersForTesting();
  registerDispatcherHandlers();
});

describe('dispatcher handlers', () => {
  it('starts the service once and answers get', async () => {
    expect(dispatcher.initDispatcher).toHaveBeenCalledTimes(1);
    expect(await h.handlers.get(IPC.DISPATCHER.GET)!({})).toEqual(ON);
  });

  it('makes its chat a group chat, and clears the chat on request (#3043)', async () => {
    expect(installGroupChat).toHaveBeenCalledTimes(1);
    expect(await h.handlers.get(IPC.DISPATCHER.CLEAR_CHAT)!({})).toEqual({ cleared: 'now' });
    expect(clearDispatcherChat).toHaveBeenCalledTimes(1);
  });

  it('setEnabled takes a boolean only', async () => {
    expect(await h.handlers.get(IPC.DISPATCHER.SET_ENABLED)!({}, false)).toEqual({ ...ON, enabled: false });
    expect(dispatcher.setDispatcherEnabled).toHaveBeenCalledWith(false);
    await expect(Promise.resolve().then(() => h.handlers.get(IPC.DISPATCHER.SET_ENABLED)!({}, 'yes'))).rejects.toThrow();
  });

  it('broadcasts changes and rebuilds its wires only while enabled', () => {
    h.listener!(ON);
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.DISPATCHER.CHANGED, ON);
    expect(restorePersistedBindings).toHaveBeenCalledTimes(1);
    h.listener!({ ...ON, enabled: false });
    expect(restorePersistedBindings).toHaveBeenCalledTimes(1);
  });
});
