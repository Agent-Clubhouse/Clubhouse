/**
 * Reads a file a repository may have planted anything at. A FIFO blocks an open
 * forever and pins a libuv thread, so a few of them stall every fs call in the
 * process; a hard link reads as a plain file while holding someone else's content.
 * So: lstat first, open without following or blocking where the platform can, and
 * check again on the open handle in case the path was swapped in between.
 */
import { constants, type Stats } from 'fs';
import * as fsp from 'fs/promises';

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export type UnsafeFileReason = 'symlink' | 'special-file' | 'hard-link' | 'too-large' | 'changed';

export class UnsafeFileError extends Error {
  constructor(readonly reason: UnsafeFileReason) {
    super(`unsafe file: ${reason}`);
  }
}

/** Why a file can't be read, from its stats, or null. `nlink` counts on every platform this runs on. */
export function unsafeReason(stats: Stats): UnsafeFileReason | null {
  if (stats.isSymbolicLink()) return 'symlink';
  if (!stats.isFile()) return 'special-file';
  return stats.nlink > 1 ? 'hard-link' : null;
}

/** For the test that swaps a file between the check and the open. */
export interface ReadHooks {
  beforeOpen?: () => void | Promise<void>;
}

export async function readRegularFile(file: string, maxBytes: number, hooks: ReadHooks = {}): Promise<Buffer> {
  const before = await fsp.lstat(file);
  const reason = unsafeReason(before);
  if (reason) throw new UnsafeFileError(reason);
  if (before.size > maxBytes) throw new UnsafeFileError('too-large');
  await hooks.beforeOpen?.();

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, OPEN_FLAGS);
  } catch (err) {
    // telemetry-exempt: rethrown, or reported by the caller as a closed reason. ELOOP is O_NOFOLLOW meeting a link.
    if ((err as NodeJS.ErrnoException)?.code === 'ELOOP') throw new UnsafeFileError('symlink');
    throw err;
  }
  try {
    const opened = await handle.stat();
    const openedReason = unsafeReason(opened);
    if (openedReason) throw new UnsafeFileError(openedReason);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new UnsafeFileError('changed');
    if (opened.size > maxBytes) throw new UnsafeFileError('too-large');
    // One byte past the limit, to tell a file that grew from one that fits exactly.
    const buffer = Buffer.alloc(Math.min(opened.size, maxBytes) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) throw new UnsafeFileError('too-large');
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}
