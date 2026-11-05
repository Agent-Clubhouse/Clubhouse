import { describe, expect, it, vi } from 'vitest';
import type { ManagedLaunchLease } from './service';
import { ProcessStartedReceiptError } from './types';
import { recordManagedProcessStart } from './runtime-start';

describe('process-created receipt failures', () => {
  it.each(['throw', 'replacement', 'timeout', 'exit'] as const)('keeps identity and truthful cleanup state on %s', async (mode) => {
    const failure = new ProcessStartedReceiptError('attempt-1', 'pty:1:123');
    const lease = { started: vi.fn(async () => { throw failure; }), cleanup: vi.fn(async () => undefined) } as unknown as ManagedLaunchLease;
    const request = vi.fn(() => { if (mode === 'throw') throw new Error('signal failed'); return mode !== 'replacement'; });
    const wait = vi.fn(async () => { if (mode === 'timeout') throw new Error('timeout'); });
    await expect(recordManagedProcessStart(lease, 'pty:1:123', { requestIfCurrent: request, waitForExit: wait, exitConfirmed: () => mode === 'exit' })).rejects.toBe(failure);
    expect(failure).toMatchObject({ code: 'process_started_receipt_failed', runtimeIdentity: 'pty:1:123', cleanupRequested: mode === 'timeout' || mode === 'exit', cleanupConfirmed: mode === 'exit' });
    expect(lease.cleanup).toHaveBeenCalledWith(failure, mode === 'exit');
    if (mode === 'throw' || mode === 'replacement') expect(wait).not.toHaveBeenCalled();
  });
});
