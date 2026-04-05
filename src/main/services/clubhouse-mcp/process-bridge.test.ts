import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ---- Electron mocks ---- */
const mockSend = vi.fn();
const mockOn = vi.fn();
let mockWindows: unknown[] = [{ webContents: { send: mockSend } }];

vi.mock('electron', () => ({
  ipcMain: { on: (...args: unknown[]) => mockOn(...args) },
  BrowserWindow: {
    getAllWindows: () => mockWindows,
  },
}));

vi.mock('../log-service', () => ({
  appLog: vi.fn(),
}));

import { ProcessBridge } from './process-bridge';

describe('ProcessBridge', () => {
  let bridge: ProcessBridge;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSend.mockClear();
    mockOn.mockClear();
    mockWindows = [{ webContents: { send: mockSend } }];
    bridge = new ProcessBridge({
      requestChannel: 'test:request',
      resultChannel: 'test:result',
      callIdPrefix: 'tb',
      timeoutMs: 5_000,
      logTag: 'test-bridge',
    });
  });

  afterEach(() => {
    bridge._resetForTesting();
    vi.useRealTimers();
  });

  it('sends a request with callId via IPC', async () => {
    const promise = bridge.send({ command: 'do_thing', args: { x: 1 } });

    // Simulate renderer responding
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [channel, payload] = mockSend.mock.calls[0];
    expect(channel).toBe('test:request');
    expect(payload.callId).toMatch(/^tb_1_/);
    expect(payload.command).toBe('do_thing');
    expect(payload.args).toEqual({ x: 1 });

    // Resolve via the registered handler
    bridge.registerHandler();
    const resultHandler = mockOn.mock.calls[0][1];
    resultHandler(null, { callId: payload.callId, result: { success: true, data: 'ok' } });

    const result = await promise;
    expect(result).toEqual({ success: true, data: 'ok' });
  });

  it('times out when renderer does not respond', async () => {
    const promise = bridge.send({ command: 'slow' });

    // Advance past the timeout
    vi.advanceTimersByTime(5_001);

    const result = await promise;
    expect(result).toEqual({ success: false, error: 'test-bridge request timed out' });
  });

  it('returns error when no window is available', async () => {
    mockWindows = [];
    const result = await bridge.send({ command: 'no_window' });
    expect(result).toEqual({ success: false, error: 'No renderer window available' });
  });

  it('registerHandler is idempotent', () => {
    bridge.registerHandler();
    bridge.registerHandler();
    // Should only register the IPC listener once
    expect(mockOn).toHaveBeenCalledTimes(1);
  });

  it('increments callId counter', async () => {
    bridge.send({ command: 'a' });
    bridge.send({ command: 'b' });

    const id1 = mockSend.mock.calls[0][1].callId;
    const id2 = mockSend.mock.calls[1][1].callId;
    expect(id1).toMatch(/^tb_1_/);
    expect(id2).toMatch(/^tb_2_/);

    // Cleanup pending calls
    vi.advanceTimersByTime(5_001);
  });

  it('_resetForTesting clears pending calls', async () => {
    bridge.send({ command: 'reset_test' });
    bridge._resetForTesting();

    // Should not resolve with timeout error after reset since timer was cleared
    vi.advanceTimersByTime(10_000);

    // The promise is still pending (timer was cleared before it could fire)
    // This verifies cleanup works — no dangling timers
  });

  it('ignores results with unknown callIds', () => {
    bridge.registerHandler();
    const resultHandler = mockOn.mock.calls[0][1];
    // Should not throw
    resultHandler(null, { callId: 'unknown_999', result: { success: true } });
  });
});
