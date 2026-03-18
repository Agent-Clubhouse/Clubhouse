/**
 * Tests for annex-client IPC handlers — verifies all channels are registered
 * and delegate to the correct annex-client service methods.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../services/annex-client', () => ({
  getSatellites: vi.fn(() => []),
  getDiscoveredServices: vi.fn(() => []),
  pairWithService: vi.fn(async () => ({ success: true })),
  connect: vi.fn(),
  disconnect: vi.fn(),
  retry: vi.fn(),
  scan: vi.fn(),
  sendToSatellite: vi.fn(() => true),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerAnnexClientHandlers } from './annex-client-handlers';
import * as annexClient from '../services/annex-client';

describe('annex-client-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerAnnexClientHandlers();
  });

  it('registers all expected IPC handlers', () => {
    expect(handlers.has(IPC.ANNEX_CLIENT.GET_SATELLITES)).toBe(true);
    expect(handlers.has(IPC.ANNEX_CLIENT.CONNECT)).toBe(true);
    expect(handlers.has(IPC.ANNEX_CLIENT.DISCONNECT)).toBe(true);
    expect(handlers.has(IPC.ANNEX_CLIENT.RETRY)).toBe(true);
    expect(handlers.has(IPC.ANNEX_CLIENT.SCAN)).toBe(true);
    expect(handlers.has(IPC.ANNEX_CLIENT.GET_DISCOVERED)).toBe(true);
    expect(handlers.has(IPC.ANNEX_CLIENT.PAIR_WITH)).toBe(true);
    expect(handlers.has(IPC.ANNEX_CLIENT.PTY_INPUT)).toBe(true);
    expect(handlers.has(IPC.ANNEX_CLIENT.PTY_RESIZE)).toBe(true);
    expect(handlers.has(IPC.ANNEX_CLIENT.AGENT_SPAWN)).toBe(true);
    expect(handlers.has(IPC.ANNEX_CLIENT.AGENT_KILL)).toBe(true);
  });

  it('GET_SATELLITES delegates to annexClient.getSatellites', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.GET_SATELLITES)!;
    handler({});
    expect(annexClient.getSatellites).toHaveBeenCalled();
  });

  it('GET_DISCOVERED delegates to annexClient.getDiscoveredServices', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.GET_DISCOVERED)!;
    handler({});
    expect(annexClient.getDiscoveredServices).toHaveBeenCalled();
  });

  it('PAIR_WITH delegates to annexClient.pairWithService', async () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.PAIR_WITH)!;
    await handler({}, 'fp:aa:bb', '123456');
    expect(annexClient.pairWithService).toHaveBeenCalledWith('fp:aa:bb', '123456');
  });

  it('SCAN delegates to annexClient.scan', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.SCAN)!;
    handler({});
    expect(annexClient.scan).toHaveBeenCalled();
  });

  it('CONNECT delegates to annexClient.connect', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.CONNECT)!;
    handler({}, 'fp:aa:bb', 'token-123');
    expect(annexClient.connect).toHaveBeenCalledWith('fp:aa:bb', 'token-123');
  });

  it('DISCONNECT delegates to annexClient.disconnect', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.DISCONNECT)!;
    handler({}, 'fp:aa:bb');
    expect(annexClient.disconnect).toHaveBeenCalledWith('fp:aa:bb');
  });

  it('RETRY delegates to annexClient.retry', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.RETRY)!;
    handler({}, 'fp:aa:bb');
    expect(annexClient.retry).toHaveBeenCalledWith('fp:aa:bb');
  });

  // --- Input validation ---

  it('rejects non-string fingerprint for PAIR_WITH', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.PAIR_WITH)!;
    expect(() => handler({}, 123, '456')).toThrow();
  });

  it('rejects non-string pin for PAIR_WITH', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.PAIR_WITH)!;
    expect(() => handler({}, 'fp', 123)).toThrow();
  });
});
