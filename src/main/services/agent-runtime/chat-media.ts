/**
 * Rich chat content media (experimental `richChatContent`, #2350).
 *
 * Drivers attach images to tool events as base64 `data` or a `sourcePath`
 * (ChatImage). Before the runtime writes or publishes an event,
 * ChatMediaPolicy stores each image's bytes as
 * `<agent transcript dir>/media/<sha256>.<ext>` and keeps only the reference,
 * so transcripts stay small (#2149). It also cuts base64 image payloads out of
 * `rawOutput`. With the flag off it drops `media` and media-only calls, so
 * events are what they were before the feature existed.
 *
 * Files are read here only: a `sourcePath` must resolve (symlinks included)
 * inside the agent's roots, and bytes must sniff as a supported image under
 * the size cap. The renderer asks for media by reference, never by path.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { promises as dns } from 'dns';
import type { ChatEventDraft, ChatImage, ChatMediaAssetResult, ContentBlock } from '../../../shared/chat';
import { CHAT_MEDIA_MAX_BYTES, CHAT_MEDIA_MAX_PIXELS, CHAT_MEDIA_TYPES, isMediaAssetId, isMediaRef, mediaDimensions, sniffMediaType } from '../../../shared/chat';
import { agentMediaDir } from './chat-transcript';
import { appLog } from '../log-service';

/** More images than this on one event are dropped. */
const MAX_IMAGES_PER_EVENT = 16;
const MAX_URI_LENGTH = 2048;
/** Base64 strings at least this long in rawOutput are image payloads worth cutting. */
const RAW_BASE64_MIN = 256;
const RAW_SCRUB_MAX_DEPTH = 10;
export const RAW_IMAGE_PLACEHOLDER = '[image]';

/** Bytes from base64 or a base64 data: URL; undefined when it isn't base64. */
export function decodeBase64Image(value: string): Uint8Array | undefined {
  let raw = value;
  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',');
    if (comma < 0 || !/;base64$/i.test(raw.slice(0, comma))) return undefined;
    raw = raw.slice(comma + 1);
  }
  // Base64 is 4/3 of the bytes: refuse oversized input before decoding it.
  if (raw.length > Math.ceil(CHAT_MEDIA_MAX_BYTES / 3) * 4 + 1024) return undefined;
  const clean = raw.replace(/\s+/g, '');
  if (!clean || clean.length % 4 === 1 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) return undefined;
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

/** True when `target` is `root` or inside it. Both must be resolved already. */
function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The real path of `filePath` when it (after symlinks) is inside one of
 * `roots`, else undefined. Relative paths resolve against the first root.
 */
export async function resolveAllowedPath(filePath: string, roots: readonly string[]): Promise<string | undefined> {
  const checked = await checkAllowedPath(filePath, roots);
  return 'real' in checked ? checked.real : undefined;
}

/**
 * resolveAllowedPath, saying why a path isn't allowed: `outside` the roots
 * (decided by name before the filesystem is asked, so it says nothing about
 * files elsewhere) or `missing` inside them.
 */
export async function checkAllowedPath(filePath: string, roots: readonly string[]): Promise<{ real: string } | { denied: 'outside' | 'missing' }> {
  const outside = { denied: 'outside' as const };
  if (!filePath || filePath.includes('\0') || roots.length === 0) return outside;
  // UNC and device paths (\\host\share, //host/share, \\?\, \\.\) would reach the network
  // or a device before any check: never touch them.
  if (isNetworkOrDevicePath(filePath)) return outside;
  const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(roots[0], filePath);
  if (isNetworkOrDevicePath(absolute)) return outside;
  const usable = roots.filter((r) => r && path.isAbsolute(r));
  const realRoots = await Promise.all(usable.map((r) => fsp.realpath(r).catch((): null => null)));
  // Lexically inside a root first, so the filesystem is only asked about paths
  // there (an automount like /net/<host> is never touched)...
  if (!usable.some((r, i) => isInside(absolute, path.resolve(r)) || (realRoots[i] && isInside(absolute, realRoots[i]!)))) return outside;
  const real = await fsp.realpath(absolute).catch((): null => null);
  if (!real) return { denied: 'missing' };
  // ...then really inside one, with symlinks resolved.
  return realRoots.some((r) => r && isInside(real, r)) ? { real } : outside;
}

/** `\\host\share`, `//host/share`, `\\?\…`, `\\.\…`: paths that name a network share or a device. */
export function isNetworkOrDevicePath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/** Store image bytes for an agent; undefined unless they sniff as a supported image under the cap. */
export async function storeMedia(agentId: string, bytes: Uint8Array): Promise<ChatImage | undefined> {
  if (!bytes.byteLength || bytes.byteLength > CHAT_MEDIA_MAX_BYTES) return undefined;
  const mimeType = sniffMediaType(bytes);
  if (!mimeType) return undefined;
  // A small file can declare a huge canvas; the renderer would try to decode it.
  const size = mediaDimensions(bytes, mimeType);
  if (size && size.width * size.height > CHAT_MEDIA_MAX_PIXELS) return undefined;
  const dir = agentMediaDir(agentId);
  // The transcript creates the agent folder; without it there's no transcript to refer from.
  if (!fs.existsSync(path.dirname(dir))) return undefined;
  const mediaRef = `${createHash('sha256').update(bytes).digest('hex')}.${CHAT_MEDIA_TYPES[mimeType]}`;
  const file = path.join(dir, mediaRef);
  if (!fs.existsSync(file)) {
    await fsp.mkdir(dir, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temp, bytes);
      await fsp.rename(temp, file);
    } finally {
      await fsp.rm(temp, { force: true });
    }
  }
  return { type: 'image', mimeType, mediaRef, ...(size && { width: size.width, height: size.height }) };
}

/** A stored image's file, after checking the reference. Throws when there is none. */
export function mediaFilePath(agentId: string, mediaRef: string): string {
  if (!isMediaRef(mediaRef)) throw new Error('Not a media reference');
  return path.join(agentMediaDir(agentId), mediaRef);
}

/** A stored image's bytes and sniffed type. */
export async function readMedia(agentId: string, mediaRef: string): Promise<{ mimeType: string; data: Uint8Array }> {
  const file = mediaFilePath(agentId, mediaRef);
  const st = await fsp.lstat(file);
  if (!st.isFile() || st.size > CHAT_MEDIA_MAX_BYTES) throw new Error('Image not available');
  const data = new Uint8Array(await fsp.readFile(file));
  const mimeType = sniffMediaType(data);
  if (!mimeType) throw new Error('Image not available');
  return { mimeType, data };
}

/** Read a local image the agent named, if it's allowed and an image. */
async function readSourceImage(sourcePath: string, roots: readonly string[]): Promise<Uint8Array | undefined> {
  const real = await resolveAllowedPath(sourcePath, roots);
  return real ? readImageFile(real) : undefined;
}

/** A regular file's bytes, up to the media cap; undefined when it isn't one or is too large. */
async function readImageFile(real: string): Promise<Uint8Array | undefined> {
  // One handle for the check and the read: no swapping the file in between, and
  // non-blocking so a FIFO can't stall the agent's event chain.
  const handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)).catch((): null => null);
  if (!handle) return undefined;
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size === 0 || st.size > CHAT_MEDIA_MAX_BYTES) return undefined;
    // Read at most the cap: a file still growing stops there.
    const buf = Buffer.alloc(Math.min(st.size, CHAT_MEDIA_MAX_BYTES));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return new Uint8Array(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function isRemoteUri(uri: string): boolean {
  return uri.length <= MAX_URI_LENGTH && /^https?:\/\//i.test(uri);
}

function looksBase64(value: string): boolean {
  return value.length >= RAW_BASE64_MIN && /^[A-Za-z0-9+/_\-\s]+={0,2}$/.test(value.slice(0, 4096));
}

function looksDataImage(value: string): boolean {
  return value.length >= RAW_BASE64_MIN && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

/**
 * `rawOutput` with base64 image payloads replaced by a placeholder: data:
 * image URLs anywhere, `base64` fields, and `data` / `blob` fields of
 * objects that describe an image (Claude source blocks, MCP and ACP image
 * content, MCP embedded resources).
 */
export function scrubRawOutput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return looksDataImage(value) ? RAW_IMAGE_PLACEHOLDER : value;
  if (depth >= RAW_SCRUB_MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => { const s = scrubRawOutput(v, depth + 1); if (s !== v) changed = true; return s; });
    return changed ? out : value;
  }
  const obj = value as Record<string, unknown>;
  const imageLike = obj.type === 'image' || obj.type === 'base64' || 'media_type' in obj || 'mimeType' in obj || 'mime_type' in obj;
  let out: Record<string, unknown> | undefined;
  for (const [key, v] of Object.entries(obj)) {
    let next: unknown;
    if (typeof v === 'string' && (key === 'base64' || ((key === 'data' || key === 'blob') && imageLike)) && looksBase64(v)) next = RAW_IMAGE_PLACEHOLDER;
    else next = scrubRawOutput(v, depth + 1);
    if (next !== v) (out ??= { ...obj })[key] = next;
  }
  return out ?? value;
}

export interface ChatMediaPolicyOptions {
  agentId: string;
  /** Whether rich chat content is on; read for each event. */
  enabled: () => boolean;
  /** Folders a `sourcePath` may be read from (agent cwd, project). */
  roots: () => readonly string[];
  /** Bytes for an image's `assetId`, from the current driver session's own store (#2421). */
  resolveAsset?: (assetId: string) => Promise<ChatMediaAssetResult | undefined>;
}

/**
 * Applied by the runtime to each draft before it gets a sequence number.
 * Returns the draft to write (possibly changed), or null to drop it.
 */
export class ChatMediaPolicy {
  /** Media-only calls dropped while the flag was off: their updates go too. */
  private readonly dropped = new Set<string>();
  /** Media-only calls shown (flag on): an image that can't be stored says so on the card. */
  private readonly mediaOnly = new Set<string>();

  constructor(private readonly opts: ChatMediaPolicyOptions) {}

  /** The draft with its images removed and raw image payloads cut: the fallback when storing fails. */
  withoutMedia(draft: ChatEventDraft): ChatEventDraft {
    if ((draft.type !== 'tool_call' && draft.type !== 'tool_call_update') || !('media' in draft.data)) return draft;
    const { media: _media, ...data } = draft.data as Record<string, unknown>;
    if (draft.type === 'tool_call_update' && data.rawOutput !== undefined) data.rawOutput = scrubRawOutput(data.rawOutput);
    return { ...draft, data } as ChatEventDraft;
  }

  async apply(draft: ChatEventDraft): Promise<ChatEventDraft | null> {
    if (draft.type === 'user_message') return this.withUserImages(draft);
    if (draft.type !== 'tool_call' && draft.type !== 'tool_call_update') return draft;
    const { toolCallId } = draft.data;
    if (this.dropped.has(toolCallId)) return null;
    const mediaOnly = draft.type === 'tool_call' && draft.data.mediaOnly === true;
    const enabled = this.opts.enabled();
    if (!enabled) {
      if (mediaOnly) { this.dropped.add(toolCallId); return null; }
      if (!('media' in draft.data)) return draft;
      const { media: _media, ...rest } = draft.data;
      return { ...draft, data: rest } as ChatEventDraft;
    }
    const media = draft.data.media ? await this.store(draft.data.media) : undefined;
    const lost = !!draft.data.media?.length && !media?.length;
    // A media-only call that arrives with its image (ACP) and can't store it has nothing to show.
    if (mediaOnly && lost) { this.dropped.add(toolCallId); return null; }
    if (mediaOnly) this.mediaOnly.add(toolCallId);
    const data: Record<string, unknown> = { ...draft.data };
    if (media?.length) data.media = media; else delete data.media;
    // One that started empty (Codex image generation) settles with a reason instead.
    if (lost && draft.type === 'tool_call_update' && this.mediaOnly.has(toolCallId) && !draft.data.error) data.error = 'The image could not be shown';
    if (draft.type === 'tool_call_update' && draft.data.rawOutput !== undefined) data.rawOutput = scrubRawOutput(draft.data.rawOutput);
    return { ...draft, data } as ChatEventDraft;
  }

  /**
   * A user's attached images (composer or phone) get a stored copy and its
   * `mediaRef`, so a phone can show them by reference instead of by desktop
   * path (#2453). Done whatever the rich content flag says: the image is the
   * user's own, and Annex serves media only through its flag-gated content
   * route. Only user and Annex messages: their image paths come from
   * attachment staging, which already checked them.
   */
  private async withUserImages(draft: Extract<ChatEventDraft, { type: 'user_message' }>): Promise<ChatEventDraft> {
    const { content, source } = draft.data;
    if ((source !== 'user' && source !== 'annex') || !content.some((b) => b.type === 'image' && b.path && !b.mediaRef)) return draft;
    const out: ContentBlock[] = [];
    for (const block of content) {
      if (block.type !== 'image' || !block.path || block.mediaRef) { out.push(block); continue; }
      let stored: ChatImage | undefined;
      try {
        const bytes = await readImageFile(block.path);
        stored = bytes && await storeMedia(this.opts.agentId, bytes);
      } catch (err) {
        // telemetry-exempt: the echo only loses its thumbnail; logged locally.
        appLog('core:chat', 'warn', 'Could not store a sent image', { meta: { agentId: this.opts.agentId, error: err instanceof Error ? err.message : String(err) } });
      }
      out.push(stored?.mediaRef ? { ...block, mediaRef: stored.mediaRef, ...(stored.width && stored.height && { width: stored.width, height: stored.height }) } : block);
    }
    return { ...draft, data: { ...draft.data, content: out } };
  }

  private async store(images: ChatImage[]): Promise<ChatImage[]> {
    const out: ChatImage[] = [];
    for (const image of images.slice(0, MAX_IMAGES_PER_EVENT)) {
      try {
        const stored = await this.storeOne(image);
        if (stored) out.push(stored);
      } catch (err) {
        // telemetry-exempt: a missing image only loses its thumbnail; logged locally.
        appLog('core:chat', 'warn', 'Could not store a chat image', { meta: { agentId: this.opts.agentId, error: err instanceof Error ? err.message : String(err) } });
      }
    }
    return out;
  }

  private async storeOne(image: ChatImage): Promise<ChatImage | undefined> {
    if (image.assetId !== undefined || image.unavailable === true) return this.storeAsset(image);
    const sourcePath = typeof image.sourcePath === 'string' ? image.sourcePath : undefined;
    let bytes: Uint8Array | undefined;
    if (typeof image.data === 'string') bytes = decodeBase64Image(image.data);
    else if (typeof image.uri === 'string' && image.uri.startsWith('data:')) bytes = decodeBase64Image(image.uri);
    else if (sourcePath) bytes = await readSourceImage(sourcePath, this.opts.roots());
    if (bytes) {
      const stored = await storeMedia(this.opts.agentId, bytes);
      return stored && { ...stored, ...(sourcePath && { sourcePath }) };
    }
    // A remote image stays a link until the user loads it.
    if (typeof image.uri === 'string' && isRemoteUri(image.uri)) {
      return { type: 'image', mimeType: typeof image.mimeType === 'string' ? image.mimeType.slice(0, 100) : 'image/*', uri: image.uri };
    }
    return undefined;
  }

  /**
   * An image the driver referenced by asset id (Copilot, #2421), stored like
   * any other. One that can't be resolved stays on the call, marked
   * unavailable, so chat shows that an image was there.
   */
  private async storeAsset(image: ChatImage): Promise<ChatImage> {
    const mimeType = typeof image.mimeType === 'string' ? image.mimeType.slice(0, 100) : 'image/*';
    const assetId = isMediaAssetId(image.assetId) ? image.assetId : undefined;
    let reason: string;
    if (!assetId) reason = image.unavailable === true ? 'omitted' : 'bad_asset_id';
    else {
      try {
        const resolved = this.opts.resolveAsset ? await this.opts.resolveAsset(assetId) : undefined;
        if (!resolved) reason = 'unsupported';
        else if (!resolved.ok) reason = resolved.reason;
        else {
          const stored = await storeMedia(this.opts.agentId, resolved.bytes);
          if (stored) return { ...stored, assetId };
          reason = 'not_an_image';
        }
      } catch (err) {
        // telemetry-exempt: becomes the image's unavailable reason, logged locally below.
        reason = `read_failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // telemetry-exempt: a missing image shows as unavailable in chat; logged locally for diagnosis.
    appLog('core:chat', 'warn', 'Chat image asset not available', { meta: { agentId: this.opts.agentId, ...(assetId && { assetId }), reason } });
    return { type: 'image', mimeType, ...(assetId && { assetId }), unavailable: true };
  }
}

const REMOTE_TIMEOUT_MS = 15_000;

/** True for IPv4 addresses on this machine, private networks, link-local, CGNAT and multicast. */
function isPrivateV4(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/** Hosts a click-to-load image may not come from: this machine and private networks. */
export function isPrivateHost(host: string): boolean {
  // `localhost.` and `router.local.` are the same names as without the dot.
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || (!h.includes('.') && !h.includes(':'))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return isPrivateV4(Number(v4[1]), Number(v4[2]));
  if (h.includes(':')) {
    // Loopback, unspecified, unique-local, link-local, multicast, and the
    // IPv4-mapped, IPv4-compatible (::/96) and NAT64 (64:ff9b::/96) forms.
    return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('ff')
      || h.startsWith('::ffff:') || /^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(h) || /^::\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('64:ff9b:');
  }
  return false;
}

function checkRemoteUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Not an image link'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only web images can be loaded');
  if (url.username || url.password || isPrivateHost(url.hostname)) throw new Error('Images from this address are not loaded');
  return url;
}

/**
 * Fetch a remote image the user asked to load (never automatic). Web hosts
 * only, no credentials sent, size-capped, and the bytes must sniff as a
 * supported image whatever the server says.
 */
export async function fetchRemoteImage(
  raw: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  /** Addresses a host name resolves to; any private one refuses the host. */
  resolve: (host: string) => Promise<string[]> = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address),
): Promise<{ mimeType: string; data: Uint8Array }> {
  const check = async (target: string): Promise<URL> => {
    const url = checkRemoteUrl(target);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!/^[\d.]+$/.test(host) && !host.includes(':')) {
      const addresses = await resolve(host).catch((): string[] => []);
      if (!addresses.length) throw new Error('The image could not be loaded');
      if (addresses.some(isPrivateHost)) throw new Error('Images from this address are not loaded');
    }
    return url;
  };
  let url = await check(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    let res: Response | undefined;
    // Follow redirects by hand so each hop is checked.
    for (let hop = 0; hop < 5; hop++) {
      res = await fetcher(url.href, { redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: { Accept: 'image/*' } });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      url = await check(new URL(location, url).href);
      res = undefined;
    }
    if (!res || !res.ok || !res.body) throw new Error('The image could not be loaded');
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > CHAT_MEDIA_MAX_BYTES) throw new Error('The image is too large');
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CHAT_MEDIA_MAX_BYTES) { await reader.cancel(); throw new Error('The image is too large'); }
      chunks.push(value);
    }
    const data = new Uint8Array(Buffer.concat(chunks));
    const mimeType = sniffMediaType(data);
    if (!mimeType) throw new Error('That link is not a supported image');
    return { mimeType, data };
  } finally {
    clearTimeout(timer);
  }
}
