import { clipboard } from 'electron';

/**
 * Guard against synchronous clipboard reads that hang the main thread after
 * macOS wake-from-sleep.  The native pasteboard daemon can take 25+ seconds
 * to respond, causing a Mach message deadlock.
 *
 * Primary defense: tracks wake-from-sleep via `notifyResume()` and skips
 * clipboard reads for a cooldown window after wake, returning `null`
 * immediately.  This prevents the synchronous `clipboard.readImage()` call
 * from ever reaching the stale pasteboard daemon.
 *
 * Secondary defense: wraps the read in try/catch so unexpected native errors
 * don't crash the handler.
 */

let lastResumeTimestamp = 0;

/** How long after wake to skip clipboard reads (ms). */
export const WAKE_COOLDOWN_MS = 5_000;

/**
 * Call from `powerMonitor.on('resume')` to notify the guard that the machine
 * just woke from sleep.
 */
export function notifyResume(): void {
  lastResumeTimestamp = Date.now();
}

/** Exposed for testing. */
export function _resetForTest(): void {
  lastResumeTimestamp = 0;
}

function isInWakeCooldown(): boolean {
  if (lastResumeTimestamp === 0) return false;
  return Date.now() - lastResumeTimestamp < WAKE_COOLDOWN_MS;
}

export interface ClipboardImageResult {
  base64: string;
  mimeType: string;
}

/**
 * Safely read an image from the system clipboard.
 *
 * Returns `null` when:
 *  - The machine just woke from sleep (cooldown active)
 *  - The native read throws
 *  - The clipboard contains no image
 */
export function readImageSafe(): ClipboardImageResult | null {
  if (isInWakeCooldown()) {
    return null;
  }

  try {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const png = image.toPNG();
    return { base64: png.toString('base64'), mimeType: 'image/png' };
  } catch {
    return null;
  }
}
