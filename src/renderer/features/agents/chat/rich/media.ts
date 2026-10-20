/**
 * Loading stored chat images (rich chat content). Main hands back bytes for a
 * media reference; the renderer only ever shows them as `data:` URLs in
 * `<img>` (the CSP allows data: images, not blob:), so SVG never runs as a
 * document. Thumbnails are decoded with createImageBitmap, which decodes off
 * the main thread, and scaled down once; the full image loads only in the
 * viewer. Data URLs are built by FileReader, off the main thread too.
 */

/** Thumbnail edge in device pixels (240 CSS px at 2x). */
const THUMB_PX = 480;
/** Images this small are their own thumbnail. */
const INLINE_BYTES = 192 * 1024;
/** Characters of thumbnail data URLs kept for the app session (about 16 MB). */
const THUMB_CACHE_CHARS = 16 * 1024 * 1024;

export interface MediaBytes { mimeType: string; data: Uint8Array }

/** The bytes as a data: URL, encoded by FileReader rather than on the main thread. */
export function dataUrlOf({ mimeType, data }: MediaBytes): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'));
    reader.readAsDataURL(new Blob([data as BlobPart], { type: mimeType }));
  });
}

async function scaled(bytes: MediaBytes): Promise<string | null> {
  if (typeof createImageBitmap !== 'function') return bytes.data.byteLength <= INLINE_BYTES ? dataUrlOf(bytes) : null;
  const bitmap = await createImageBitmap(new Blob([bytes.data as BlobPart], { type: bytes.mimeType }));
  try {
    const scale = Math.min(1, THUMB_PX / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && bytes.data.byteLength <= INLINE_BYTES) return dataUrlOf(bytes);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // WebP keeps transparency (screenshots, generated art with alpha) and encodes small.
    return canvas.toDataURL('image/webp', 0.85);
  } finally {
    bitmap.close();
  }
}

/**
 * A small data: URL for an image's bytes, or null when there's no small form
 * (a large SVG, which bitmaps can't scale everywhere; an undecodable image).
 */
export async function thumbnailOf(bytes: MediaBytes): Promise<string | null> {
  if (bytes.mimeType === 'image/svg+xml') return bytes.data.byteLength <= INLINE_BYTES ? dataUrlOf(bytes) : null;
  return scaled(bytes).catch((): null => null);
}

/** A loaded image's thumbnail, null when it has none (it can still open in the viewer). */
export interface Thumbnail { thumb: string | null }

const thumbs = new Map<string, Promise<Thumbnail | null>>();
const sizes = new Map<string, number>();
let cachedChars = 0;

function forget(key: string): void {
  thumbs.delete(key);
  cachedChars -= sizes.get(key) ?? 0;
  sizes.delete(key);
}

/**
 * A stored image's thumbnail, cached for the app session (LRU, bounded by
 * size). Null when the image can't be read.
 */
export function loadThumbnail(agentId: string, mediaRef: string): Promise<Thumbnail | null> {
  const key = `${agentId}\0${mediaRef}`;
  const hit = thumbs.get(key);
  if (hit) {
    thumbs.delete(key);
    thumbs.set(key, hit);
    return hit;
  }
  const loading: Promise<Thumbnail | null> = window.clubhouse.chat.readMedia(agentId, mediaRef)
    .then(async (bytes) => ({ thumb: await thumbnailOf(bytes) }))
    // telemetry-exempt: an image that won't load shows as unavailable in place.
    .catch((): null => null);
  thumbs.set(key, loading);
  void loading.then((v) => {
    if (thumbs.get(key) !== loading) return;
    // Don't keep a failure: the next mount may succeed (e.g. the flag was just turned on).
    if (v === null) { forget(key); return; }
    const chars = v.thumb?.length ?? 0;
    sizes.set(key, chars);
    cachedChars += chars;
    while (cachedChars > THUMB_CACHE_CHARS && thumbs.size > 1) {
      const oldest = thumbs.keys().next().value as string;
      if (oldest === key) break;
      forget(oldest);
    }
  });
  return loading;
}

/** The full image, for the viewer. Not cached: it can be large. */
export async function loadFullImage(agentId: string, mediaRef: string): Promise<string> {
  return dataUrlOf(await window.clubhouse.chat.readMedia(agentId, mediaRef));
}

/** For tests. */
export function clearMediaCache(): void {
  thumbs.clear();
  sizes.clear();
  cachedChars = 0;
}
