import type { ChildProcess } from 'node:child_process';

/** Observation only: never kills, waits for, or treats exit as close. */
export function observeOwnedProcess(
  getProcess: () => ChildProcess,
  write: (receipt: Record<string, unknown>) => void = receipt => console.log('[e2e owned-process]', JSON.stringify(receipt)),
) {
  let child: ChildProcess | undefined;
  let stderrTail = '';
  let exitObserved = false;
  let closeObserved = false;
  let accountingKnown = true;
  const emit = (phase: string, extra: Record<string, unknown> = {}) => {
    try {
      write({ phase, pid: child?.pid ?? null, exitCode: child?.exitCode ?? null,
        signalCode: child?.signalCode ?? null, exitObserved, closeObserved,
        accountingKnown, stderrTail, ...extra });
    } catch { accountingKnown = false; /* Observation must not replace a test failure. */ }
  };
  const onStderr = (chunk: Buffer | string) => {
    try { stderrTail = (stderrTail + chunk.toString()).slice(-4096); }
    catch { accountingKnown = false; }
  };
  try {
    child = getProcess();
    child.once('exit', (code, signal) => {
      exitObserved = true;
      emit('exit', { eventExitCode: code, eventSignal: signal });
    });
    child.once('close', (code, signal) => {
      closeObserved = true;
      try { child?.stderr?.removeListener('data', onStderr); }
      catch { accountingKnown = false; }
      emit('close', { eventExitCode: code, eventSignal: signal });
    });
    child.stderr?.on('data', onStderr);
  } catch { accountingKnown = false; }
  // An already-exited process's status is useful, but does not invent an observed close.
  emit('launch-returned');
  return { emit };
}
