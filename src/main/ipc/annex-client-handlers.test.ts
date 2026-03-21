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
  forgetSatellite: vi.fn(),
  forgetAllSatellites: vi.fn(),
  requestFileTree: vi.fn(async () => []),
  requestFileRead: vi.fn(async () => ''),
  requestPtyBuffer: vi.fn(async () => ''),
  resizeRemoteBuffer: vi.fn(),
  requestGitOperation: vi.fn(async () => ({})),
  requestSessionList: vi.fn(async () => []),
  requestSessionTranscript: vi.fn(async () => ({})),
  requestSessionSummary: vi.fn(async () => ({})),
  requestCreateDurable: vi.fn(async () => ({})),
  requestDeleteDurable: vi.fn(async () => ({})),
  requestWorktreeStatus: vi.fn(async () => ({})),
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
    expect(handlers.has(IPC.ANNEX_CLIENT.FORGET_SATELLITE)).toBe(true);
    expect(handlers.has(IPC.ANNEX_CLIENT.FORGET_ALL_SATELLITES)).toBe(true);
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

  it('FORGET_SATELLITE delegates to annexClient.forgetSatellite', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.FORGET_SATELLITE)!;
    handler({}, 'fp:aa:bb');
    expect(annexClient.forgetSatellite).toHaveBeenCalledWith('fp:aa:bb');
  });

  it('FORGET_ALL_SATELLITES delegates to annexClient.forgetAllSatellites', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.FORGET_ALL_SATELLITES)!;
    handler({});
    expect(annexClient.forgetAllSatellites).toHaveBeenCalled();
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

  it('rejects non-string fingerprint for FORGET_SATELLITE', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.FORGET_SATELLITE)!;
    expect(() => handler({}, 123)).toThrow();
  });

  // --- File operation handlers ---

  it('registers FILE_TREE handler', () => {
    expect(handlers.has(IPC.ANNEX_CLIENT.FILE_TREE)).toBe(true);
  });

  it('registers FILE_READ handler', () => {
    expect(handlers.has(IPC.ANNEX_CLIENT.FILE_READ)).toBe(true);
  });

  it('FILE_TREE delegates to annexClient.requestFileTree', async () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.FILE_TREE)!;
    const options = { path: 'src', depth: 3, includeHidden: true };
    await handler({}, 'sat-123', 'proj-abc', options);
    expect(annexClient.requestFileTree).toHaveBeenCalledWith('sat-123', 'proj-abc', options);
  });

  it('FILE_TREE passes undefined options when not provided', async () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.FILE_TREE)!;
    await handler({}, 'sat-123', 'proj-abc');
    expect(annexClient.requestFileTree).toHaveBeenCalledWith('sat-123', 'proj-abc', undefined);
  });

  it('FILE_READ delegates to annexClient.requestFileRead', async () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.FILE_READ)!;
    await handler({}, 'sat-123', 'proj-abc', 'src/index.ts');
    expect(annexClient.requestFileRead).toHaveBeenCalledWith('sat-123', 'proj-abc', 'src/index.ts');
  });

  it('FILE_TREE rejects non-string satelliteId', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.FILE_TREE)!;
    expect(() => handler({}, 123, 'proj-abc')).toThrow();
  });

  it('FILE_TREE rejects non-string projectId', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.FILE_TREE)!;
    expect(() => handler({}, 'sat-123', 123)).toThrow();
  });

  it('FILE_READ rejects non-string path', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.FILE_READ)!;
    expect(() => handler({}, 'sat-123', 'proj-abc', 123)).toThrow();
  });

  // --- PTY operation handlers ---

  it('registers PTY_SPAWN_SHELL handler', () => {
    expect(handlers.has(IPC.ANNEX_CLIENT.PTY_SPAWN_SHELL)).toBe(true);
  });

  it('PTY_SPAWN_SHELL delegates to annexClient.sendToSatellite', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.PTY_SPAWN_SHELL)!;
    handler({}, 'sat-123', 'session-1', 'proj-abc');
    expect(annexClient.sendToSatellite).toHaveBeenCalledWith('sat-123', {
      type: 'pty:spawn-shell',
      payload: { sessionId: 'session-1', projectId: 'proj-abc' },
    });
  });

  it('PTY_INPUT delegates to annexClient.sendToSatellite', () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.PTY_INPUT)!;
    handler({}, 'sat-123', 'agent-1', 'hello\n');
    expect(annexClient.sendToSatellite).toHaveBeenCalledWith('sat-123', {
      type: 'pty:input',
      payload: { agentId: 'agent-1', data: 'hello\n' },
    });
  });

  it('PTY_GET_BUFFER delegates to annexClient.requestPtyBuffer', async () => {
    const handler = handlers.get(IPC.ANNEX_CLIENT.PTY_GET_BUFFER)!;
    await handler({}, 'sat-123', 'agent-1');
    expect(annexClient.requestPtyBuffer).toHaveBeenCalledWith('sat-123', 'agent-1');
  });
});
