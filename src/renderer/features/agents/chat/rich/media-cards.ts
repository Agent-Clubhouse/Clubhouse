/**
 * Inline audio and video cards (rich chat content, #2425): which confirmed
 * media chips an agent message *returns*, metadata and posters loaded lazily
 * through main's file preview (the same path validation and size cap as the
 * popover), and the rule that only one chat player plays at a time.
 *
 * Returned media is a chip that ends its paragraph or list item, alone or
 * after a short lead-in ending in a colon ("Here's the recording: out/a.webm").
 * A path in the middle of a sentence is a mention and stays a chip.
 */

import { dataUrlOf } from './media';

export type MediaKind = 'audio' | 'video';

export interface MediaCardHost {
  /** Stable for the life of the host element. */
  key: string;
  host: HTMLElement;
  path: string;
  kind: MediaKind;
  name: string;
  size?: number;
}

const PATH_ATTR = 'data-chat-path';
const FILE_ATTR = 'data-chat-file';
/** On a chip that has a card. */
const CARD_ATTR = 'data-chat-media-card';
/** A lead-in longer than this is prose, not a caption. */
const LEAD_IN_MAX = 160;

const cards = new WeakMap<Element, MediaCardHost>();
let nextKey = 0;

function textAround(block: Element, chip: Element): { before: string; after: string } {
  const range = block.ownerDocument.createRange();
  range.setStart(block, 0);
  range.setEndBefore(chip);
  const before = range.toString();
  range.setStartAfter(chip);
  range.setEnd(block, block.childNodes.length);
  return { before, after: range.toString() };
}

/**
 * Give each returned media chip under `root` a card host (once), and return
 * all of them in order. A chip alone in its paragraph is hidden: the card
 * shows its name. Safe to call again on the same root.
 */
export function placeMediaCards(root: Element): MediaCardHost[] {
  const out: MediaCardHost[] = [];
  const seen = new Set<string>();
  for (const chip of Array.from(root.querySelectorAll(`[${FILE_ATTR}="audio"], [${FILE_ATTR}="video"]`))) {
    const path = chip.getAttribute(PATH_ATTR);
    if (!path || chip.closest('a, pre')) continue;
    const existing = cards.get(chip);
    if (existing) {
      if (existing.host.isConnected && !seen.has(path)) { seen.add(path); out.push(existing); }
      continue;
    }
    // One card per file per message: later mentions stay chips.
    if (seen.has(path)) continue;
    const block = chip.closest('p, li');
    if (!block || !root.contains(block)) continue;
    const { before, after } = textAround(block, chip);
    if (after.replace(/[\s.,;!)\]"'`*]+/g, '') !== '') continue;
    const lead = before.trim();
    const solo = lead === '';
    if (!solo && (!lead.endsWith(':') || lead.length > LEAD_IN_MAX)) continue;
    const host = root.ownerDocument.createElement('div');
    host.className = 'chat-media-host';
    if (block.tagName === 'LI') block.appendChild(host); else block.after(host);
    if (solo) (block.tagName === 'LI' ? chip as HTMLElement : block as HTMLElement).hidden = true;
    chip.setAttribute(CARD_ATTR, '');
    const title = chip.getAttribute('title') ?? '';
    const card: MediaCardHost = {
      key: `m${nextKey++}`,
      host,
      path,
      kind: chip.getAttribute(FILE_ATTR) as MediaKind,
      name: title.split(' · ')[0] || path.split(/[\\/]/).pop() || path,
      ...parseSize(title),
    };
    cards.set(chip, card);
    seen.add(path);
    out.push(card);
  }
  return out;
}

const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 * 1024 };

/** The size the chip's title shows (`name · 1.2 MB`), to key cached metadata by file version. */
function parseSize(title: string): { size?: number } {
  const m = / · ([\d.]+) (B|KB|MB)$/.exec(title);
  return m ? { size: Math.round(Number(m[1]) * SIZE_UNITS[m[2]]) } : {};
}

// ── Formatting ────────────────────────────────────────────────────────────

/** `0:07`, `3:25`, `1:02:09`. Empty for unknown or endless durations. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ── Sources and metadata ──────────────────────────────────────────────────

export type MediaSource =
  | { status: 'ok'; src: string }
  | { status: 'too-large' }
  | { status: 'error' };

/** A playable data: URL for the file, read by main (path checks, size cap). Not cached: it can be 16 MB. */
export async function loadMediaSource(agentId: string, path: string): Promise<MediaSource> {
  try {
    const preview = await window.clubhouse.chat.readFilePreview(agentId, path);
    if (preview.tooLarge) return { status: 'too-large' };
    if (!preview.data || !preview.mimeType || (preview.kind !== 'audio' && preview.kind !== 'video')) return { status: 'error' };
    return { status: 'ok', src: await dataUrlOf({ mimeType: preview.mimeType, data: preview.data }) };
  } catch {
    // telemetry-exempt: the card shows that the file can't play.
    return { status: 'error' };
  }
}

export interface MediaMeta {
  duration?: number;
  /** Video only: the first frame, as a small image data: URL. */
  poster?: string;
  /** Video only: width / height. */
  aspect?: number;
  tooLarge?: boolean;
  failed?: boolean;
}

const POSTER_PX = 480;
const PROBE_TIMEOUT_MS = 8000;
/** A whole metadata load (read, encode, probe) gives up after this, so one stuck file can't hold the queue. */
const META_TIMEOUT_MS = 20_000;
const META_CACHE_MAX = 200;
const metas = new Map<string, Promise<MediaMeta>>();
/** Metadata loads one file at a time: each is a read of up to 16 MB. */
let queue: Promise<unknown> = Promise.resolve();

function once(el: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS);
    el.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(timer); reject(new Error('error')); }, { once: true });
  });
}

function posterOf(video: HTMLVideoElement): string | undefined {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return undefined;
  const scale = Math.min(1, POSTER_PX / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', 0.8);
}

/** Duration and (for video) a poster, from a detached, muted element that never plays. */
async function probe(src: string, kind: MediaKind): Promise<MediaMeta> {
  const el = document.createElement(kind);
  el.muted = true;
  el.preload = 'metadata';
  try {
    const loaded = once(el, 'loadedmetadata');
    el.src = src;
    await loaded;
    const meta: MediaMeta = Number.isFinite(el.duration) ? { duration: el.duration } : {};
    if (el instanceof HTMLVideoElement && el.videoWidth && el.videoHeight) {
      meta.aspect = el.videoWidth / el.videoHeight;
      try {
        const seeked = once(el, 'seeked');
        el.currentTime = Math.min(0.1, (meta.duration ?? 0) / 2);
        await seeked;
        meta.poster = posterOf(el);
      } catch {
        // telemetry-exempt: no poster; the card shows the video icon instead.
      }
    }
    return meta;
  } finally {
    el.removeAttribute('src');
    try { el.load(); } catch { /* telemetry-exempt: releasing the probe's buffer is best-effort. */ }
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void work.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

/**
 * A file's duration and poster, loaded once per file (and size) for the app
 * session. `wanted` is asked when the load's turn comes: a card that has gone
 * by then costs nothing.
 */
export function loadMediaMeta(agentId: string, path: string, kind: MediaKind, size?: number, wanted: () => boolean = () => true): Promise<MediaMeta> {
  const key = `${agentId}\0${path}\0${size ?? ''}`;
  const hit = metas.get(key);
  if (hit) return hit;
  const loading = queue.then((): Promise<MediaMeta> => {
    if (!wanted()) return Promise.resolve({ failed: true });
    return withTimeout((async (): Promise<MediaMeta> => {
      const source = await loadMediaSource(agentId, path);
      if (source.status === 'too-large') return { tooLarge: true };
      if (source.status === 'error') return { failed: true };
      // telemetry-exempt: an unreadable header leaves the card without a duration; playing shows the real error.
      return probe(source.src, kind).catch((): MediaMeta => ({ failed: true }));
    })(), META_TIMEOUT_MS, { failed: true });
  });
  // Never rejects: every path above resolves.
  queue = loading;
  metas.set(key, loading);
  // A failure may be the file still being written, or a skipped load: ask again next time.
  void loading.then((m) => { if (m.failed && metas.get(key) === loading) metas.delete(key); });
  while (metas.size > META_CACHE_MAX) metas.delete(metas.keys().next().value as string);
  return loading;
}

// ── Where playback stopped ────────────────────────────────────────────────

const POSITIONS_MAX = 200;
const positions = new Map<string, number>();

/** Where a file stopped playing, so a card scrolled away and back resumes there. */
export function savedPosition(agentId: string, path: string): number | undefined {
  return positions.get(`${agentId}\0${path}`);
}

export function savePosition(agentId: string, path: string, seconds: number | undefined): void {
  const key = `${agentId}\0${path}`;
  positions.delete(key);
  if (seconds === undefined || !(seconds > 0.5)) return;
  positions.set(key, seconds);
  while (positions.size > POSITIONS_MAX) positions.delete(positions.keys().next().value as string);
}

// ── One player at a time ──────────────────────────────────────────────────

/** Media in chat: inline cards and the file preview popover. */
const CHAT_MEDIA_SELECTOR = '[data-chat-media], [data-testid="chat-file-preview"]';
let listening = false;

/**
 * Once installed, a chat player starting to play pauses every other chat
 * player, cards and popover alike. Media elsewhere in the app is left alone.
 */
/** Fired on a card's player when another chat player starts, so the card can let its source go. */
export const MEDIA_SUPERSEDED = 'chat-media-superseded';

export function installSinglePlayback(doc: Document = document): void {
  if (listening) return;
  listening = true;
  // `play` doesn't bubble; the capture phase still sees it.
  doc.addEventListener('play', (e) => {
    const playing = e.target;
    if (!(playing instanceof HTMLMediaElement) || !playing.closest(CHAT_MEDIA_SELECTOR)) return;
    for (const other of Array.from(doc.querySelectorAll<HTMLMediaElement>('audio, video'))) {
      if (other === playing || !other.closest(CHAT_MEDIA_SELECTOR)) continue;
      if (!other.paused) other.pause();
      // A paused card still holds its source: it closes too.
      if (other.closest('[data-chat-media]') && other.hasAttribute('src')) other.dispatchEvent(new Event(MEDIA_SUPERSEDED));
    }
  }, true);
}

/** For tests. */
export function clearMediaCardCaches(): void {
  metas.clear();
  positions.clear();
  queue = Promise.resolve();
}
