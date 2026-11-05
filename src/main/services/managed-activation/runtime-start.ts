import type { ManagedLaunchLease } from './service';
import { ProcessStartedReceiptError } from './types';
export interface ManagedCleanup {
  requestIfCurrent(identity: string): boolean;
  waitForExit(): Promise<void>;
  exitConfirmed(): boolean;
}
/** A signal, manager timeout, missing registration or replacement PID is never observed exit proof. */
export async function cleanupManagedReceiptFailure(lease: ManagedLaunchLease, error: ProcessStartedReceiptError, cleanup: ManagedCleanup): Promise<never> {
  try { error.cleanupRequested = cleanup.requestIfCurrent(error.runtimeIdentity); }
  catch {
    // telemetry-exempt: signal dispatch failed; preserve the identity-bearing original error.
    error.cleanupFailure = 'request_failed';
  }
  if (!error.cleanupRequested && !error.cleanupFailure) error.cleanupFailure = 'identity_changed';
  if (error.cleanupRequested) {
    try { await cleanup.waitForExit(); }
    catch {
      // telemetry-exempt: failed cleanup must preserve the observed process and original receipt error.
    }
  }
  error.cleanupConfirmed = cleanup.exitConfirmed();
  if (error.cleanupRequested && !error.cleanupConfirmed) error.cleanupFailure = 'exit_unconfirmed';
  try { await lease.cleanup(error, error.cleanupConfirmed); }
  catch {
    // telemetry-exempt: secondary persistence failure cannot replace the identity-bearing process error.
  }
  throw error;
}
/** This receipt observes PTY shell creation only, not provider exec or instruction/skill loading. */
export async function recordManagedProcessStart(lease: ManagedLaunchLease, identity: string, cleanup: ManagedCleanup): Promise<void> {
  try { await lease.started(identity); }
  catch (err) {
    if (!(err instanceof ProcessStartedReceiptError)) throw err;
    await cleanupManagedReceiptFailure(lease, err, cleanup);
  }
}
