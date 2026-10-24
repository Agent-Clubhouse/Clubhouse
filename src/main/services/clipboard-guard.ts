import { clipboard, nativeImage } from 'electron';

/**
 * Avoid contacting the pasteboard immediately after macOS wake-from-sleep,
 * when its daemon can be slow or unavailable. Electron 44+ reads are async;
 * retain the wake cooldown and the existing PNG result contract.
 *
 * Primary defense: tracks wake-from-sleep via `notifyResume()` and skips
 * clipboard reads for a cooldown window after wake, returning `null`
 * immediately, without contacting the stale pasteboard daemon.
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
export async function readImageSafe(): Promise<ClipboardImageResult | null> {
  if (isInWakeCooldown()) {
    return null;
  }

  try {
    const items = await clipboard.read();
    // Prefer PNG across all items, then JPEG; always normalize to PNG as the
    // old readImage API did, so existing paste and Annex consumers are stable.
    const type = ['image/png', 'image/jpeg'].find((mime) => items.some((item) => item.types.includes(mime)));
    if (!type) return null;
    const item = items.find((candidate) => candidate.types.includes(type))!;
    const blob = await item.getType(type);
    if (!('arrayBuffer' in blob)) return null;
    const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
    if (image.isEmpty()) return null;
    const png = image.toPNG();
    return { base64: png.toString('base64'), mimeType: 'image/png' };
  } catch {
    return null;
  }
}
