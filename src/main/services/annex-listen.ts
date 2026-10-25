/** Binds `port` and resolves the port actually bound, or rejects with the listen error. */
export type ListenFn = (port: number) => Promise<number>;

/** Errors that mean "this port can't be had", where an OS-chosen port is the fallback. */
const PORT_UNAVAILABLE_CODES = new Set(['EADDRINUSE', 'EACCES']);

/**
 * Listen on the port bound last time, so a paired phone finds this machine
 * again after a relaunch. If that port is taken or not allowed, take any free
 * one (port 0). Other errors are passed on.
 */
export async function listenPreferringPort(listen: ListenFn, preferredPort: number): Promise<number> {
  if (!Number.isInteger(preferredPort) || preferredPort <= 0 || preferredPort > 65535) return listen(0);
  try {
    return await listen(preferredPort);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (!code || !PORT_UNAVAILABLE_CODES.has(code)) throw err;
    return listen(0);
  }
}
