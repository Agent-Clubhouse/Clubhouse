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

async function systemThumbnail(filePath: string, box: number): Promise<NativeImage | null> {
  if (typeof nativeImage.createThumbnailFromPath !== 'function') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SYSTEM_THUMBNAIL_TIMEOUT_MS); });
  try {
    return await Promise.race([nativeImage.createThumbnailFromPath(filePath, { width: box, height: box }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The image as a PNG within a `box`-pixel square, or null if it can't be resized.
 * `filePath` is where the same bytes are on disk, for the system thumbnailer.
 */
export async function resizeIcon(bytes: Uint8Array, filePath: string, box: number): Promise<Buffer | null> {
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
    // telemetry-exempt: logged; the caller treats it as an image that can't be resized
    appLog('core:annex', 'warn', 'Could not resize an icon', {
      meta: { file: path.basename(filePath), bytes: bytes.length, error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
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
  const served = canPassThrough(bytes) ? bytes : await resizeIcon(bytes, filePath, ICON_THUMBNAIL_SIZE);
  return (served && describeImage(served)) ?? leaveOut();
}

interface CachedThumbnail { mtimeMs: number; size: number; image: Promise<IconImage | null> }

const thumbnails = new Map<string, CachedThumbnail>();

/**
 * The bounded image for an icon file, or null if there's no file or it can't be
 * made small. Never rejects. A file small enough already is sent as it is, so it
 * keeps its format. Rebuilt snapshots only stat the file: the crop dialog reuses
 * a filename, so the name alone can't say the image is the same.
 */
export async function readIconImage(filePath: string): Promise<IconImage | null> {
  try {
    const { mtimeMs, size } = await fsp.stat(filePath);
    const cached = thumbnails.get(filePath);
    thumbnails.delete(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      thumbnails.set(filePath, cached);
      return await cached.image;
    }
    const image = makeThumbnail(filePath, size).catch((): null => null);
    thumbnails.set(filePath, { mtimeMs, size, image });
    if (thumbnails.size > THUMBNAIL_CACHE_MAX_ENTRIES) thumbnails.delete(thumbnails.keys().next().value!);
    return await image;
  } catch {
    // The file is gone: the same as no icon. // telemetry-exempt: expected, and the phone draws initials
    thumbnails.delete(filePath);
    return null;
  }
}
