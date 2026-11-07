/**
 * Small copies of icon images. A snapshot sends every icon in one frame, so it
 * sends thumbnails, made here and kept in memory: the user's files stay as they
 * are. Saving through the appearance service resizes too, as the crop dialog does.
 *
 * nativeImage decodes only PNG and JPEG from bytes. GIF, WebP and SVG go through
 * the system's thumbnailer, on macOS and Windows. Linux has none, so there a large
 * one can't be resized.
 */

import { nativeImage, type NativeImage } from 'electron';
import { createHash } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { CHAT_MEDIA_MAX_PIXELS, mediaDimensions, sniffMediaType } from '../../shared/chat';
import { ICON_SERVED_MAX_BYTES, ICON_SOURCE_MAX_BYTES, ICON_THUMBNAIL_PASSTHROUGH_BYTES, ICON_THUMBNAIL_PASSTHROUGH_SIZE, ICON_THUMBNAIL_SIZE } from '../../shared/icon-limits';
import { appLog } from './log-service';

/** The system thumbnailer gets this long: a stuck one must not hold up a snapshot. */
const SYSTEM_THUMBNAIL_TIMEOUT_MS = 5000;

/** After a try that failed for a reason that can pass, how long to wait before another: a stuck thumbnailer would hold up every build. */
export const TEMPORARY_FAILURE_RETRY_MS = 30_000;

/**
 * Tries in a row that fail for a reason that can pass, on a file that hasn't changed,
 * before the answer counts as no image: an unknown icon keeps every phone's icon refs
 * unknown, so one stuck file mustn't do that for good. A change to the file starts over.
 */
export const TEMPORARY_FAILURES_BEFORE_REFUSAL = 3;

/** About 15 MB at a typical thumbnail's size. Past it the oldest is made again if asked for. */
const THUMBNAIL_CACHE_MAX_ENTRIES = 512;

/** The EXIF orientation of a JPEG, 1 to 8, or 1 when it has none. */
export function jpegOrientation(b: Uint8Array): number {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    const length = view.getUint16(i + 2);
    // The image data starts: there's no EXIF after this.
    if (marker === 0xda) return 1;
    if (marker === 0xe1 && i + 10 + 8 <= b.length && Buffer.from(b.subarray(i + 4, i + 10)).toString('latin1') === 'Exif\0\0') {
      const tiff = i + 10;
      const little = b[tiff] === 0x49;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      if (ifd + 2 > b.length) return 1;
      const entries = view.getUint16(ifd, little);
      for (let e = 0; e < entries && ifd + 2 + (e + 1) * 12 <= b.length; e++) {
        const entry = ifd + 2 + e * 12;
        if (view.getUint16(entry, little) === 0x0112) {
          const orientation = view.getUint16(entry + 8, little);
          return orientation >= 1 && orientation <= 8 ? orientation : 1;
        }
      }
      return 1;
    }
    i += 2 + length;
  }
  return 1;
}

/** The image turned upright: nativeImage ignores EXIF, and a PNG can't carry it. Runs on the small copy. */
function applyOrientation(image: NativeImage, orientation: number): NativeImage {
  if (orientation === 1) return image;
  const { width: w, height: h } = image.getSize();
  const from = image.toBitmap();
  const swapped = orientation >= 5;
  const width = swapped ? h : w;
  const height = swapped ? w : h;
  const to = Buffer.alloc(width * height * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [dx, dy] = {
        2: [w - 1 - x, y], 3: [w - 1 - x, h - 1 - y], 4: [x, h - 1 - y],
        5: [y, x], 6: [h - 1 - y, x], 7: [h - 1 - y, w - 1 - x], 8: [y, w - 1 - x],
      }[orientation as 2 | 3 | 4 | 5 | 6 | 7 | 8];
      from.copy(to, (dy * width + dx) * 4, (y * w + x) * 4, (y * w + x) * 4 + 4);
    }
  }
  return nativeImage.createFromBitmap(to, { width, height });
}

/** PNG bytes of the image within a `box`-pixel square, keeping its shape. Never scales up. */
function fitToPng(image: NativeImage, box: number, orientation = 1): Buffer | null {
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const scale = Math.min(1, box / Math.max(width, height));
  const fitted = scale === 1 ? image : image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'good',
  });
  const png = applyOrientation(fitted, orientation).toPNG();
  return png.length > 0 ? png : null;
}

class ThumbnailTimeout extends Error {}

async function systemThumbnail(filePath: string, box: number): Promise<NativeImage | null> {
  if (typeof nativeImage.createThumbnailFromPath !== 'function') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ThumbnailTimeout('The system thumbnailer timed out')), SYSTEM_THUMBNAIL_TIMEOUT_MS); });
  try {
    return await Promise.race([nativeImage.createThumbnailFromPath(filePath, { width: box, height: box }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** resizeIcon, but a timeout rejects: it says nothing about the image, so a caller keeping the answer has to know. */
async function resizeOrTimeOut(bytes: Uint8Array, filePath: string, box: number): Promise<Buffer | null> {
  try {
    const type = sniffMediaType(bytes);
    // A small file can claim a huge image: don't decode one.
    const size = type && mediaDimensions(bytes, type);
    if (size && size.width * size.height > CHAT_MEDIA_MAX_PIXELS) return null;
    if (type === 'image/png' || type === 'image/jpeg') {
      return fitToPng(nativeImage.createFromBuffer(Buffer.from(bytes)), box, type === 'image/jpeg' ? jpegOrientation(bytes) : 1);
    }
    const thumbnail = await systemThumbnail(filePath, box);
    return thumbnail && fitToPng(thumbnail, box);
  } catch (err) {
    if (err instanceof ThumbnailTimeout) throw err;
    // telemetry-exempt: logged; the caller treats it as an image that can't be resized
    appLog('core:annex', 'warn', 'Could not resize an icon', {
      meta: { file: path.basename(filePath), bytes: bytes.length, error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

/**
 * The image as a PNG within a `box`-pixel square, or null if it can't be resized.
 * `filePath` is where the same bytes are on disk, for the system thumbnailer.
 */
export async function resizeIcon(bytes: Uint8Array, filePath: string, box: number): Promise<Buffer | null> {
  return resizeOrTimeOut(bytes, filePath, box).catch((): null => null);
}

/**
 * Small enough to send as it is. Only a raster image whose size can be read:
 * phones can't draw SVG (`UIImage` returns nil), so it needs a raster copy.
 */
function canPassThrough(bytes: Uint8Array): boolean {
  if (bytes.length > ICON_THUMBNAIL_PASSTHROUGH_BYTES) return false;
  const type = sniffMediaType(bytes);
  const size = type && type !== 'image/svg+xml' ? mediaDimensions(bytes, type) : undefined;
  return !!size && Math.max(size.width, size.height) <= ICON_THUMBNAIL_PASSTHROUGH_SIZE;
}

/** What a phone can be sent for an icon. Every field describes the served bytes. */
export interface IconImage {
  dataUrl: string;
  /** A hash of the bytes, so it changes exactly when they do. */
  version: string;
  type: string;
  bytes: number;
  width: number;
  height: number;
}

/** Describes the bytes to send, or null if they break a guarantee: a phone is promised these limits. */
function describeImage(bytes: Buffer): IconImage | null {
  const type = sniffMediaType(bytes);
  const size = type && mediaDimensions(bytes, type);
  if (!type || !size || bytes.length > ICON_SERVED_MAX_BYTES) return null;
  if (Math.max(size.width, size.height) > ICON_THUMBNAIL_PASSTHROUGH_SIZE) return null;
  return {
    dataUrl: `data:${type};base64,${bytes.toString('base64')}`,
    version: createHash('sha256').update(bytes).digest('hex'),
    type,
    bytes: bytes.length,
    width: size.width,
    height: size.height,
  };
}

async function makeThumbnail(filePath: string, fileBytes: number): Promise<IconImage | null> {
  const leaveOut = (): null => {
    appLog('core:annex', 'warn', 'An icon has no thumbnail, so snapshots leave it out', {
      meta: { file: path.basename(filePath), bytes: fileBytes },
    });
    return null;
  };
  if (fileBytes > ICON_SOURCE_MAX_BYTES) return leaveOut();
  const bytes = await fsp.readFile(filePath);
  const served = canPassThrough(bytes) ? bytes : await resizeOrTimeOut(bytes, filePath, ICON_THUMBNAIL_SIZE);
  return (served && describeImage(served)) ?? leaveOut();
}

/** The answer can't be had right now, which says nothing about the image. Not the same as null: null is no image. */
export const ICON_TEMPORARILY_UNAVAILABLE = 'temporarily_unavailable';
export type IconRead = IconImage | null | typeof ICON_TEMPORARILY_UNAVAILABLE;

const isGone = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

function temporaryFailure(filePath: string, err: unknown): IconRead {
  if (isGone(err)) return null;
  // telemetry-exempt: logged; the caller keeps what's known, and the next read tries again
  appLog('core:annex', 'warn', 'Could not read an icon right now', {
    meta: { file: path.basename(filePath), error: err instanceof Error ? err.message : String(err) },
  });
  return ICON_TEMPORARILY_UNAVAILABLE;
}

interface CachedThumbnail { mtimeMs: number; size: number; image: Promise<IconRead>; retryAtMs?: number; failures?: number }

const thumbnails = new Map<string, CachedThumbnail>();

/**
 * The bounded image for an icon file, null if there's no file or it can't be made
 * small, or ICON_TEMPORARILY_UNAVAILABLE if that can't be known yet: a read error or
 * a stuck thumbnailer. Never rejects. A file small enough already is sent as it is,
 * so it keeps its format. Rebuilt snapshots only stat the file: the crop dialog
 * reuses a filename, so the name alone can't say the image is the same.
 */
export async function readIconImage(filePath: string): Promise<IconRead> {
  try {
    const { mtimeMs, size } = await fsp.stat(filePath);
    const cached = thumbnails.get(filePath);
    thumbnails.delete(filePath);
    const unchanged = !!cached && cached.mtimeMs === mtimeMs && cached.size === size;
    if (unchanged && (cached.retryAtMs === undefined || Date.now() < cached.retryAtMs)) {
      thumbnails.set(filePath, cached);
      return await cached.image;
    }
    const entry: CachedThumbnail = { mtimeMs, size, image: makeThumbnail(filePath, size).catch((err) => temporaryFailure(filePath, err)) };
    thumbnails.set(filePath, entry);
    if (thumbnails.size > THUMBNAIL_CACHE_MAX_ENTRIES) thumbnails.delete(thumbnails.keys().next().value!);
    const image = await entry.image;
    if (image !== ICON_TEMPORARILY_UNAVAILABLE) return image;
    entry.failures = (unchanged ? cached.failures ?? 0 : 0) + 1;
    if (entry.failures < TEMPORARY_FAILURES_BEFORE_REFUSAL) {
      entry.retryAtMs = Date.now() + TEMPORARY_FAILURE_RETRY_MS;
      return image;
    }
    // Kept until the file changes, like any other answer.
    appLog('core:annex', 'warn', 'Gave up on an icon that kept failing; it counts as no image until the file changes', {
      meta: { file: path.basename(filePath), failures: entry.failures },
    });
    entry.image = Promise.resolve(null);
    return null;
  } catch (err) {
    // The file is gone: the same as no icon. // telemetry-exempt: expected, and the phone draws initials
    thumbnails.delete(filePath);
    return temporaryFailure(filePath, err);
  }
}
