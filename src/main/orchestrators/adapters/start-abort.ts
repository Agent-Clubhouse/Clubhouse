/**
 * Helpers for `ChatDriverStartOptions.signal`: a cancelled chat start spawns
 * nothing, and one cancelled mid-initialization closes its CLI and settles
 * at once instead of waiting for a reply or timeout.
 */

export function startCancelledError(): Error {
  return new Error('Chat start cancelled');
}

/** Throw if the start was already cancelled. Call before spawning anything. */
export function throwIfStartAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw startCancelledError();
}

/**
 * Settle with `work`, unless `signal` aborts first: then call `onAbort` (to
 * close what the start opened) and reject right away. The abort listener is
 * removed once this settles, so it never outlives the start.
 */
export async function untilStartAborted<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return work;
  let settled = false;
  // A late rejection from abandoned work has no one waiting on it.
  work.then(() => { settled = true; }, () => { settled = true; });
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    listener = () => {
      // Work that already finished owns its result; don't close it under the caller.
      if (settled) return;
      reject(startCancelledError());
      onAbort();
    };
  });
  if (signal.aborted) listener();
  else signal.addEventListener('abort', listener, { once: true });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}
