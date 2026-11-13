import type { ChildProcess } from 'node:child_process';

export function assertOwnedMainProcess(
  launcherPid: number | undefined,
  main: { pid: number; ppid: number; platform: NodeJS.Platform },
): asserts launcherPid is number {
  if (!Number.isSafeInteger(launcherPid) || !launcherPid || launcherPid <= 0 || launcherPid === process.pid
    || !Number.isSafeInteger(main.pid) || main.pid <= 0 || main.pid === process.pid
    || (main.pid !== launcherPid && (main.platform !== 'win32' || main.ppid !== launcherPid))) {
    throw new Error('Owned Electron main is neither the launcher nor its Windows direct child');
  }
}

export function terminateOwnedProcess(child: ChildProcess, terminate: () => void): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned process exited before required termination');
  return new Promise<void>((resolve, reject) => {
    let exitObserved = false;
    const cleanup = () => {
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
    };
    const onExit = () => { exitObserved = true; };
    const onClose = () => {
      cleanup();
      if (!exitObserved || (child.exitCode === null && child.signalCode === null)) reject(new Error('Owned termination did not observe exit and close'));
      else resolve();
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    child.once('exit', onExit);
    child.once('close', onClose);
    child.once('error', onError);
    try { terminate(); }
    catch (error) { cleanup(); reject(error); }
  });
}

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
