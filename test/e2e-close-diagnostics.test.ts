import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeWithDiagnostics } from '../e2e/close-diagnostics';

afterEach(() => { vi.useRealTimers(); });

describe('closeWithDiagnostics', () => {
  it('collects nothing when the close finishes in time', async () => {
    const collect = vi.fn(async () => 'x'); const report = vi.fn();
    await closeWithDiagnostics({ close: async () => {} }, { userDataDir: '/p', slowMs: 50, collect, report });
    expect(collect).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('reports once when the close is slow, then still waits for it', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const closing = new Promise<void>((resolve) => { release = resolve; });
    const collect = vi.fn(async () => 'tree and logs'); const report = vi.fn();
    let done = false;
    const pending = closeWithDiagnostics({ close: () => closing }, { userDataDir: '/p', slowMs: 1000, collect, report }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toContain('still pending after 1000ms');
    expect(report.mock.calls[0][0]).toContain('tree and logs');
    expect(done).toBe(false); // observation only: it does not stop waiting or kill anything
    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(false);
    release();
    await pending;
    expect(done).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('keeps the close error, and a failing report does not replace it', async () => {
    vi.useFakeTimers();
    const failure = new Error('close failed');
    let reject: (error: Error) => void = () => {};
    const closing = new Promise<void>((_, fail) => { reject = fail; });
    const pending = closeWithDiagnostics({ close: () => closing }, {
      userDataDir: '/p', slowMs: 10, collect: async () => { throw new Error('collect failed'); }, report: vi.fn(),
    });
    const settled = pending.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10);
    reject(failure);
    expect(await settled).toBe(failure);
  });
});
