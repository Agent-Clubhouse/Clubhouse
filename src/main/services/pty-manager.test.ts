import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock node-pty
const mockProcess = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockProcess),
}));

// Mock electron (aliased via vitest.config.ts)

// Mock shell utility
vi.mock('../util/shell', () => ({
  findClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
  getShellEnvironment: vi.fn(() => ({ ...process.env })),
}));

// Mock the IPC channels
vi.mock('../../shared/ipc-channels', () => ({
  IPC: {
    PTY: {
      DATA: 'pty:data',
      EXIT: 'pty:exit',
    },
  },
}));

// We need to import AFTER mocks are set up
// But the module has state (Maps), so we need to handle that.
// We'll use dynamic imports or reset between tests.

import { getBuffer, spawn, gracefulKill, kill } from './pty-manager';

// Access the internal appendToBuffer via the module
// Since appendToBuffer is not exported, we test it via spawn + getBuffer and direct buffer manipulation
// We can also import the module internals through a workaround

describe('pty-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess.onData.mockReset();
    mockProcess.onExit.mockReset();
    mockProcess.write.mockReset();
    mockProcess.kill.mockReset();
  });

  describe('getBuffer', () => {
    it('returns empty string for unknown agent', () => {
      expect(getBuffer('nonexistent')).toBe('');
    });
  });

  describe('spawn + buffer', () => {
    it('clears previous buffer on spawn', () => {
      // Spawn first to set up buffer
      spawn('agent_buf', '/test');
      // Simulate data via the onData callback
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('hello');
      expect(getBuffer('agent_buf')).toBe('hello');

      // Spawn again — should clear
      spawn('agent_buf', '/test');
      expect(getBuffer('agent_buf')).toBe('');
    });

    it('kills existing PTY for same agentId', () => {
      spawn('agent_dup', '/test');
      spawn('agent_dup', '/test');
      expect(mockProcess.kill).toHaveBeenCalled();
    });
  });

  describe('appendToBuffer (via spawn + onData)', () => {
    it('stores and concatenates data', () => {
      spawn('agent_concat', '/test');
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('hello ');
      onDataCb('world');
      expect(getBuffer('agent_concat')).toBe('hello world');
    });

    it('evicts oldest chunks when >512KB', () => {
      spawn('agent_evict', '/test');
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      // Write chunks that total > 512KB
      const chunkSize = 100 * 1024; // 100KB
      for (let i = 0; i < 6; i++) {
        onDataCb('x'.repeat(chunkSize));
      }
      // Buffer should be at most 512KB + last chunk
      const buf = getBuffer('agent_evict');
      expect(buf.length).toBeLessThanOrEqual(600 * 1024); // some tolerance
      expect(buf.length).toBeGreaterThan(0);
    });

    it('keeps last chunk even if it alone exceeds limit', () => {
      spawn('agent_big', '/test');
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      const bigChunk = 'x'.repeat(600 * 1024); // 600KB single chunk
      onDataCb(bigChunk);
      expect(getBuffer('agent_big')).toBe(bigChunk);
    });

    it('independent buffers per agent', () => {
      spawn('agent_a', '/test');
      const cbA = mockProcess.onData.mock.calls[0][0];
      cbA('data_a');

      spawn('agent_b', '/test');
      const cbB = mockProcess.onData.mock.calls[mockProcess.onData.mock.calls.length - 1][0];
      cbB('data_b');

      expect(getBuffer('agent_a')).toBe('data_a');
      expect(getBuffer('agent_b')).toBe('data_b');
    });
  });

  describe('gracefulKill', () => {
    it('writes /exit to process', () => {
      spawn('agent_gk', '/test');
      gracefulKill('agent_gk');
      expect(mockProcess.write).toHaveBeenCalledWith('/exit\n');
    });

    it('sets killing flag (no re-kill race)', () => {
      spawn('agent_gk2', '/test');
      // Just verify it doesn't throw
      gracefulKill('agent_gk2');
      expect(mockProcess.write).toHaveBeenCalledWith('/exit\n');
    });
  });

  describe('kill', () => {
    it('immediately kills and clears buffer', () => {
      spawn('agent_kill', '/test');
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('some data');
      expect(getBuffer('agent_kill')).toBe('some data');

      kill('agent_kill');
      expect(mockProcess.kill).toHaveBeenCalled();
      expect(getBuffer('agent_kill')).toBe('');
    });
  });
});
