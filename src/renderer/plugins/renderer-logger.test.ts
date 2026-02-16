import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWrite = vi.fn();

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      log: {
        write: mockWrite,
      },
    },
  },
  writable: true,
});

import { rendererLog } from './renderer-logger';

describe('renderer-logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a log entry over IPC with correct fields', () => {
    rendererLog('app:plugins', 'info', 'Plugin loaded');

    expect(mockWrite).toHaveBeenCalledTimes(1);
    const entry = mockWrite.mock.calls[0][0];
    expect(entry.ns).toBe('app:plugins');
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('Plugin loaded');
    expect(entry.ts).toBeDefined();
    expect(entry.projectId).toBeUndefined();
    expect(entry.meta).toBeUndefined();
  });

  it('includes projectId and meta when provided', () => {
    rendererLog('plugin:terminal', 'warn', 'Shell exited', {
      projectId: 'proj-1',
      meta: { exitCode: 137 },
    });

    const entry = mockWrite.mock.calls[0][0];
    expect(entry.projectId).toBe('proj-1');
    expect(entry.meta).toEqual({ exitCode: 137 });
  });

  it('generates an ISO timestamp', () => {
    rendererLog('app:test', 'debug', 'test');

    const entry = mockWrite.mock.calls[0][0];
    // Should be a valid ISO string
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
  });

  it('supports all log levels', () => {
    const levels = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
    for (const level of levels) {
      vi.clearAllMocks();
      rendererLog('app:test', level, `msg-${level}`);
      expect(mockWrite.mock.calls[0][0].level).toBe(level);
    }
  });

  it('is fire-and-forget (uses send, not invoke)', () => {
    // The mock is a simple function call — no Promise returned
    const result = rendererLog('app:test', 'info', 'test');
    expect(result).toBeUndefined();
  });
});
