/**
 * Tests for the remote PTY buffer cache in annex-client.ts.
 *
 * The controller caches pty:data events locally using headless terminals
 * so that switching away from a remote agent tab and back restores the
 * terminal instantly without a network round-trip.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock heavy dependencies before importing annex-client
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-annex'),
    getName: vi.fn().mockReturnValue('Clubhouse'),
    getVersion: vi.fn().mockReturnValue('0.0.0-test'),
    on: vi.fn(),
    isPackaged: false,
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}));

vi.mock('bonjour-service', () => ({
  default: class {
    find = vi.fn().mockReturnValue({ stop: vi.fn() });
    destroy = vi.fn();
  },
}));

vi.mock('ws', () => ({
  WebSocket: class {
    static OPEN = 1;
    on = vi.fn();
    send = vi.fn();
    close = vi.fn();
    ping = vi.fn();
    terminate = vi.fn();
    readyState = 1;
  },
}));

vi.mock('./annex-identity', () => ({
  getOrCreateIdentity: vi.fn().mockReturnValue({
    fingerprint: 'test-fp',
    publicKey: 'test-pk',
  }),
  getIdentity: vi.fn().mockReturnValue(null),
}));

vi.mock('./annex-tls', () => ({
  createTlsClientOptions: vi.fn().mockReturnValue({
    cert: 'test-cert',
    key: 'test-key',
    rejectUnauthorized: false,
  }),
  getOrCreateCert: vi.fn().mockReturnValue({
    certPem: 'test-cert',
    keyPem: 'test-key',
  }),
}));

vi.mock('./annex-peers', () => ({
  getPeer: vi.fn().mockReturnValue(null),
  addPeer: vi.fn(),
  removePeer: vi.fn(),
  removeAllPeers: vi.fn(),
  updateLastSeen: vi.fn(),
}));

vi.mock('./annex-settings', () => ({
  getSettings: vi.fn().mockReturnValue({ autoReconnect: false }),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}));

// Use real headless terminal for integration testing
const mockSerialize = vi.fn().mockReturnValue('');
const mockWrite = vi.fn();
const mockResize = vi.fn();
const mockLoadAddon = vi.fn();
const mockTerminalDispose = vi.fn();
const mockSerializerDispose = vi.fn();

vi.mock('@xterm/headless', () => ({
  Terminal: class MockTerminal {
    write = mockWrite;
    resize = mockResize;
    loadAddon = mockLoadAddon;
    dispose = mockTerminalDispose;
  },
}));

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class MockSerializeAddon {
    serialize = mockSerialize;
    dispose = mockSerializerDispose;
  },
}));

import {
  cacheRemotePtyData,
  resizeRemoteBuffer,
  getLocalRemoteBuffer,
  requestPtyBuffer,
  stopClient,
} from './annex-client';

import * as headlessTerminal from './pty-headless-terminal';

describe('annex-client remote PTY buffer cache', () => {
  beforeEach(() => {
    mockWrite.mockClear();
    mockResize.mockClear();
    mockSerialize.mockClear().mockReturnValue('');
    mockLoadAddon.mockClear();
    mockTerminalDispose.mockClear();
    mockSerializerDispose.mockClear();
    headlessTerminal.disposeAll();
    // Reset client state
    stopClient();
  });

  describe('cacheRemotePtyData', () => {
    it('feeds data into a headless terminal with namespaced key', () => {
      cacheRemotePtyData('sat-1', 'agent-1', 'hello world');
      expect(mockWrite).toHaveBeenCalledWith('hello world');
      // Key should be namespaced: remote:sat-1:agent-1
      expect(mockLoadAddon).toHaveBeenCalled();
    });

    it('accumulates multiple data chunks', () => {
      cacheRemotePtyData('sat-1', 'agent-1', 'chunk1');
      cacheRemotePtyData('sat-1', 'agent-1', 'chunk2');
      cacheRemotePtyData('sat-1', 'agent-1', 'chunk3');
      expect(mockWrite).toHaveBeenCalledTimes(3);
      // Only one terminal created (loadAddon called once)
      expect(mockLoadAddon).toHaveBeenCalledTimes(1);
    });

    it('isolates data between different agents on same satellite', () => {
      cacheRemotePtyData('sat-1', 'agent-A', 'data-A');
      cacheRemotePtyData('sat-1', 'agent-B', 'data-B');
      // Two separate terminals created
      expect(mockLoadAddon).toHaveBeenCalledTimes(2);
    });

    it('isolates data between different satellites', () => {
      cacheRemotePtyData('sat-1', 'agent-1', 'data-sat1');
      cacheRemotePtyData('sat-2', 'agent-1', 'data-sat2');
      // Two separate terminals created
      expect(mockLoadAddon).toHaveBeenCalledTimes(2);
    });
  });

  describe('resizeRemoteBuffer', () => {
    it('resizes the headless terminal for a cached remote agent', () => {
      cacheRemotePtyData('sat-1', 'agent-1', 'data');
      resizeRemoteBuffer('sat-1', 'agent-1', 100, 40);
      expect(mockResize).toHaveBeenCalledWith(100, 40);
    });

    it('does nothing for an agent with no cached data', () => {
      resizeRemoteBuffer('sat-1', 'unknown-agent', 100, 40);
      expect(mockResize).not.toHaveBeenCalled();
    });
  });

  describe('getLocalRemoteBuffer', () => {
    it('returns serialized content from the headless terminal', () => {
      cacheRemotePtyData('sat-1', 'agent-1', 'some data');
      mockSerialize.mockReturnValue('serialized terminal state');
      const result = getLocalRemoteBuffer('sat-1', 'agent-1');
      expect(result).toBe('serialized terminal state');
    });

    it('returns empty string when no data has been cached', () => {
      const result = getLocalRemoteBuffer('sat-1', 'no-data-agent');
      expect(result).toBe('');
    });
  });

  describe('requestPtyBuffer', () => {
    it('returns local cache when data has been cached via pty:data events', async () => {
      // Simulate pty:data arriving via WebSocket
      cacheRemotePtyData('sat-1', 'agent-1', 'line 1\r\n');
      cacheRemotePtyData('sat-1', 'agent-1', 'line 2\r\n');
      mockSerialize.mockReturnValue('line 1\r\nline 2\r\n');

      const buffer = await requestPtyBuffer('sat-1', 'agent-1');
      expect(buffer).toBe('line 1\r\nline 2\r\n');
    });

    it('returns empty string when no data cached and satellite not connected', async () => {
      const buffer = await requestPtyBuffer('unknown-sat', 'agent-1');
      expect(buffer).toBe('');
    });

    it('returns cached data consistently across multiple requests', async () => {
      cacheRemotePtyData('sat-1', 'agent-1', 'persistent data');
      mockSerialize.mockReturnValue('persistent data');

      const buffer1 = await requestPtyBuffer('sat-1', 'agent-1');
      const buffer2 = await requestPtyBuffer('sat-1', 'agent-1');
      expect(buffer1).toBe('persistent data');
      expect(buffer2).toBe('persistent data');
    });
  });
});
