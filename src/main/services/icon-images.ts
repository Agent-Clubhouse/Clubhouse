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
import * as fsp from 'fs/promises';
import * as path from 'path';
import { CHAT_MEDIA_MAX_PIXELS, mediaDimensions, sniffMediaType } from '../../shared/chat';
import { ICON_SOURCE_MAX_BYTES, ICON_THUMBNAIL_PASSTHROUGH_BYTES, ICON_THUMBNAIL_PASSTHROUGH_SIZE, ICON_THUMBNAIL_SIZE } from '../../shared/icon-limits';
import { appLog } from './log-service';

/** The system thumbnailer gets this long: a stuck one must not hold up a snapshot. */
const SYSTEM_THUMBNAIL_TIMEOUT_MS = 5000;

/** About 15 MB at a typical thumbnail's size. Past it the oldest is made again if asked for. */
const THUMBNAIL_CACHE_MAX_ENTRIES = 512;

const ICON_MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/** PNG bytes of the image within a `box`-pixel square, keeping its shape. Never scales up. */
function fitToPng(image: NativeImage, box: number): Buffer | null {
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const scale = Math.min(1, box / Math.max(width, height));
  const fitted = scale === 1 ? image : image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'good',
  });
  const png = fitted.toPNG();
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
    if (type === 'image/png' || type === 'image/jpeg') return fitToPng(nativeImage.createFromBuffer(Buffer.from(bytes)), box);
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

/** Small enough to send as it is. SVG and ICO have no size to read here, and phones don't rasterize them to a size of their own choosing. */
function canPassThrough(bytes: Uint8Array): boolean {
  if (bytes.length > ICON_THUMBNAIL_PASSTHROUGH_BYTES) return false;
  const type = sniffMediaType(bytes);
  if (!type || type === 'image/svg+xml') return true;
  const size = mediaDimensions(bytes, type);
  return !!size && Math.max(size.width, size.height) <= ICON_THUMBNAIL_PASSTHROUGH_SIZE;
}

async function makeThumbnail(filePath: string, fileBytes: number): Promise<string | null> {
  const leaveOut = (): null => {
    appLog('core:annex', 'warn', 'An icon has no thumbnail, so snapshots leave it out', {
      meta: { file: path.basename(filePath), bytes: fileBytes },
    });
    return null;
  };
  if (fileBytes > ICON_SOURCE_MAX_BYTES) return leaveOut();
  const bytes = await fsp.readFile(filePath);
  if (canPassThrough(bytes)) {
    return `data:${ICON_MIME[path.extname(filePath).toLowerCase()] ?? 'image/png'};base64,${bytes.toString('base64')}`;
  }
  const png = await resizeIcon(bytes, filePath, ICON_THUMBNAIL_SIZE);
  return png ? `data:image/png;base64,${png.toString('base64')}` : leaveOut();
}

interface CachedThumbnail { mtimeMs: number; size: number; dataUrl: Promise<string | null> }

const thumbnails = new Map<string, CachedThumbnail>();

/**
 * A small data URL of an icon file, or null if there's no file or it can't be
 * made small. Never rejects. A file small enough already is sent as it is, so it
 * keeps its format. Rebuilt snapshots only stat the file: the crop dialog reuses
 * a filename, so the name alone can't say the image is the same.
 */
export async function readIconThumbnail(filePath: string): Promise<string | null> {
  try {
    const { mtimeMs, size } = await fsp.stat(filePath);
    const cached = thumbnails.get(filePath);
    thumbnails.delete(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      thumbnails.set(filePath, cached);
      return await cached.dataUrl;
    }
    const dataUrl = makeThumbnail(filePath, size).catch((): null => null);
    thumbnails.set(filePath, { mtimeMs, size, dataUrl });
    if (thumbnails.size > THUMBNAIL_CACHE_MAX_ENTRIES) thumbnails.delete(thumbnails.keys().next().value!);
    return await dataUrl;
  } catch {
    // The file is gone: the same as no icon. // telemetry-exempt: expected, and the phone draws initials
    thumbnails.delete(filePath);
    return null;
  }
}
