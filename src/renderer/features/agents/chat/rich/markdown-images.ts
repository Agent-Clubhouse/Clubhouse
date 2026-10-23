/**
 * Images written in agent markdown (`![alt](src)`), with rich chat content
 * on (#2350). The sanitized HTML is rewritten before it reaches the page, in
 * an inert template, so nothing is fetched by inserting it:
 *
 * - `data:image/...` images stay (they're already bytes);
 * - web images become a "Load image" button; main fetches one only when it's
 *   clicked (window.clubhouse.chat.fetchRemoteImage) and it shows as a
 *   data: URL;
 * - local images (paths, relative to the agent's folder or absolute, and
 *   file: URLs, #2422) become a placeholder. Once the message settles, main
 *   checks the path against the agent's roots and stores the image as media
 *   (window.clubhouse.chat.importLocalImage); the placeholder becomes a
 *   thumbnail of the stored copy, or says why the image isn't shown. The
 *   renderer never loads the path itself;
 * - anything else (blob:, other schemes) becomes its alt text or name and a
 *   note that it isn't shown.
 *
 * The sanitizer drops `file:` and drive-letter sources, so local sources are
 * taken from the markdown tokens before sanitizing (renderChatMarkdown) and
 * the `<img>` points at a per-render marker instead.
 */

import { marked, type Token } from 'marked';
import type { ChatLocalImageDenial, ChatLocalImageResult } from '../../../../../shared/chat';
import { sanitizeMarkdownHtml } from '../../../../utils/safe-markdown';
import { dataUrlOf, loadThumbnail } from './media';

const ATTR = 'data-chat-remote-image';
/** A local image waiting for main: the source as written. */
const LOCAL_ATTR = 'data-chat-local-image';
const ALT_ATTR = 'data-chat-image-alt';
/** A stored local image's thumbnail button: its media reference and type. */
export const MEDIA_REF_ATTR = 'data-chat-media-ref';
const MEDIA_TYPE_ATTR = 'data-chat-media-type';
const MARKER = '#chat-local-image-';
/** Characters of loaded web images kept (about 32 MB), so a re-render shows them again without asking. */
const LOADED_MAX_CHARS = 32 * 1024 * 1024;
const loaded = new Map<string, string>();
let loadedChars = 0;

function remember(src: string, url: string): void {
  if (url.length > LOADED_MAX_CHARS) return;
  loaded.set(src, url);
  loadedChars += url.length;
  while (loadedChars > LOADED_MAX_CHARS) {
    const oldest = loaded.keys().next().value as string;
    loadedChars -= loaded.get(oldest)?.length ?? 0;
    loaded.delete(oldest);
  }
}

const IMG_CLASS = 'chat-markdown-image max-w-full max-h-[320px] rounded-md';
const BUTTON_CLASS = 'inline-flex items-center gap-1.5 h-7 max-w-[260px] px-2 rounded-md bg-surface-0 hover:bg-surface-1 text-[12px] text-ctp-subtext1 align-middle';

function isWebUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/** A file path (POSIX, `~/`, a drive letter) or a `file:` URL: no other scheme. */
export function isLocalImageSrc(src: string): boolean {
  const s = src.trim();
  if (!s || s.startsWith('#') || s.startsWith('//') || s.startsWith('\\\\')) return false;
  if (/^file:/i.test(s) || /^[A-Za-z]:[\\/]/.test(s)) return true;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s);
}

const NOT_SHOWN: Record<ChatLocalImageDenial | 'error' | 'scheme', string> = {
  outside: "Image not shown. It's outside the project.",
  'session-ended': "Image not shown. The agent's session has ended.",
  missing: 'Image not found.',
  unsupported: 'Not an image chat can show.',
  'too-large': 'Image too large to show.',
  unavailable: "Couldn't load the image.",
  error: "Couldn't load the image.",
  scheme: 'Image not shown.',
};

/**
 * Agent markdown as sanitized HTML with its images made safe to insert
 * (rewriteMarkdownImages), local sources kept for main to check. Rich chat
 * content only; off, chat uses renderMarkdownSafe.
 */
export function renderChatMarkdown(content: string): string {
  const nonce = Math.random().toString(36).slice(2, 10);
  const local: string[] = [];
  const raw = marked.parse(content, {
    async: false,
    walkTokens: (token: Token) => {
      if (token.type !== 'image' || !isLocalImageSrc(token.href)) return;
      local.push(token.href);
      token.href = `${MARKER}${nonce}-${local.length - 1}`;
    },
  }) as string;
  return rewriteMarkdownImages(sanitizeMarkdownHtml(raw), { nonce, local });
}

function hostOf(src: string): string {
  try {
    return new URL(src).host;
  } catch {
    // telemetry-exempt: label only; an unparsable link shows as itself.
    return src;
  }
}

function makeImage(doc: Document, src: string, alt: string): HTMLImageElement {
  const img = doc.createElement('img');
  img.src = src;
  img.alt = alt;
  img.className = IMG_CLASS;
  img.decoding = 'async';
  return img;
}

function makeLoadButton(doc: Document, src: string, alt: string): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = BUTTON_CLASS;
  button.setAttribute(ATTR, src);
  button.title = alt ? `${alt} (${src})` : src;
  const label = doc.createElement('span');
  label.textContent = 'Load image';
  const host = doc.createElement('span');
  host.className = 'truncate min-w-0 text-ctp-overlay1';
  host.textContent = hostOf(src);
  button.append(label, host);
  return button;
}

function nameOf(src: string): string {
  return src.split(/[\\/]/).pop() || src;
}

/** A local image before main answered: its caption and "Loading image…". */
function makeLocalPlaceholder(doc: Document, src: string, alt: string): HTMLSpanElement {
  const span = doc.createElement('span');
  span.className = 'chat-local-image inline-flex items-baseline gap-1.5 max-w-full text-[12.5px]';
  span.setAttribute(LOCAL_ATTR, src);
  span.setAttribute(ALT_ATTR, alt);
  span.title = src;
  const caption = doc.createElement('span');
  caption.className = 'truncate min-w-0 text-ctp-subtext1';
  caption.textContent = alt || nameOf(src);
  const status = doc.createElement('span');
  status.className = 'text-ctp-overlay1 flex-shrink-0';
  status.textContent = 'Loading image…';
  span.append(caption, status);
  return span;
}

/** An image that isn't shown: its caption and why. */
function makeNotShown(doc: Document, src: string, alt: string, why: string): HTMLSpanElement {
  const span = doc.createElement('span');
  span.className = 'chat-image-not-shown inline-flex items-baseline gap-1.5 max-w-full text-[12.5px]';
  if (src) span.title = src;
  const caption = doc.createElement('span');
  caption.className = 'truncate min-w-0 text-ctp-subtext1';
  caption.textContent = alt || nameOf(src);
  const reason = doc.createElement('span');
  reason.className = 'text-ctp-overlay1 flex-shrink-0';
  reason.textContent = why;
  span.append(caption, reason);
  return span;
}

/**
 * `html` with its images made safe to insert; the same string when it has
 * none. `local` maps renderChatMarkdown's markers back to their sources.
 */
export function rewriteMarkdownImages(html: string, local?: { nonce: string; local: readonly string[] }): string {
  if (!html.includes('<img')) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const doc = template.content.ownerDocument;
  const marker = local ? `${MARKER}${local.nonce}-` : null;
  for (const img of [...template.content.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? '';
    const alt = img.getAttribute('alt') ?? '';
    if (/^data:image\//i.test(src)) {
      img.className = IMG_CLASS;
      continue;
    }
    if (isWebUrl(src)) {
      const cached = loaded.get(src);
      img.replaceWith(cached ? makeImage(doc, cached, alt) : makeLoadButton(doc, src, alt));
      continue;
    }
    const original = marker && src.startsWith(marker) ? local!.local[Number(src.slice(marker.length))] : undefined;
    // Raw HTML images keep their own source; the sanitizer already dropped any scheme it doesn't allow.
    const localSrc = original ?? (src && !src.startsWith(MARKER) && isLocalImageSrc(src) ? src : undefined);
    if (localSrc) {
      img.replaceWith(makeLocalPlaceholder(doc, localSrc, alt));
      continue;
    }
    img.replaceWith(makeNotShown(doc, src, alt, NOT_SHOWN.scheme));
  }
  return template.innerHTML;
}

// ── Local images (#2422) ─────────────────────────────────────────────────────

const LOCAL_CACHE_MAX = 500;
/** An image that wasn't available is asked again after this long (the agent may be about to write it). */
const LOCAL_MISS_TTL_MS = 10_000;
/** A shown image is asked again after this long: agents rewrite the same screenshot path. */
const LOCAL_HIT_TTL_MS = 60_000;
const localCache = new Map<string, Promise<ChatLocalImageResult>>();

function importLocal(agentId: string, src: string): Promise<ChatLocalImageResult> {
  const key = `${agentId}\0${src}`;
  const hit = localCache.get(key);
  if (hit) return hit;
  const result = window.clubhouse.chat.importLocalImage(agentId, src)
    // telemetry-exempt: shown in place as "Couldn't load the image".
    .catch((): ChatLocalImageResult => ({ ok: false, reason: 'unavailable' }));
  localCache.set(key, result);
  void result.then((r) => {
    setTimeout(() => { if (localCache.get(key) === result) localCache.delete(key); }, r.ok ? LOCAL_HIT_TTL_MS : LOCAL_MISS_TTL_MS);
  });
  while (localCache.size > LOCAL_CACHE_MAX) localCache.delete(localCache.keys().next().value as string);
  return result;
}

/** Largest thumbnail edge in CSS pixels, as for tool images. */
const THUMB_MAX = 240;
const THUMB_CLASS = 'chat-local-image-thumb inline-flex align-middle items-center justify-center rounded-md border border-surface-0 bg-ctp-mantle overflow-hidden hover:border-surface-2 cursor-zoom-in';

function makeThumb(doc: Document, image: { mediaRef: string; mimeType: string; width?: number; height?: number }, thumb: string | null, alt: string): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.setAttribute(MEDIA_REF_ATTR, image.mediaRef);
  button.setAttribute(MEDIA_TYPE_ATTR, image.mimeType);
  button.setAttribute('aria-label', alt ? `Open image: ${alt}` : 'Open image');
  if (alt) button.title = alt;
  if (!thumb) {
    button.className = BUTTON_CLASS;
    button.textContent = 'View image';
    return button;
  }
  button.className = THUMB_CLASS;
  if (image.width && image.height) {
    const scale = Math.min(1, THUMB_MAX / Math.max(image.width, image.height));
    button.style.width = `${Math.max(16, Math.round(image.width * scale))}px`;
    button.style.height = `${Math.max(16, Math.round(image.height * scale))}px`;
  }
  const img = doc.createElement('img');
  img.src = thumb;
  img.alt = alt;
  img.draggable = false;
  img.decoding = 'async';
  img.className = 'block max-w-full max-h-full object-contain';
  img.style.maxWidth = `${THUMB_MAX}px`;
  img.style.maxHeight = `${THUMB_MAX}px`;
  button.append(img);
  return button;
}

async function showLocal(el: Element, agentId: string): Promise<void> {
  const src = el.getAttribute(LOCAL_ATTR) ?? '';
  const alt = el.getAttribute(ALT_ATTR) ?? '';
  const doc = el.ownerDocument;
  const result = await importLocal(agentId, src);
  if ('reason' in result) {
    if (el.isConnected) el.replaceWith(makeNotShown(doc, src, alt, NOT_SHOWN[result.reason]));
    return;
  }
  const thumb = await loadThumbnail(agentId, result.mediaRef);
  if (!el.isConnected) return;
  el.replaceWith(thumb ? makeThumb(doc, result, thumb.thumb, alt) : makeNotShown(doc, src, alt, NOT_SHOWN.unavailable));
}

/**
 * Show the local images under `root` (placeholders from rewriteMarkdownImages)
 * as each comes near the viewport. Without an agent they can't be checked
 * and say so. Returns a cleanup that stops watching.
 */
export function hydrateLocalImages(root: Element, agentId: string | null): () => void {
  const pending = Array.from(root.querySelectorAll(`[${LOCAL_ATTR}]`));
  if (!pending.length) return () => {};
  if (!agentId) {
    for (const el of pending) el.replaceWith(makeNotShown(el.ownerDocument, el.getAttribute(LOCAL_ATTR) ?? '', el.getAttribute(ALT_ATTR) ?? '', NOT_SHOWN.error));
    return () => {};
  }
  if (typeof IntersectionObserver !== 'function') {
    for (const el of pending) void showLocal(el, agentId);
    return () => {};
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      void showLocal(entry.target, agentId);
    }
  }, { rootMargin: '400px' });
  for (const el of pending) observer.observe(el);
  return () => observer.disconnect();
}

/** The stored image a click landed on (a local image's thumbnail), if any. */
export function mediaTargetOf(event: React.MouseEvent<HTMLElement>): { mediaRef: string; mimeType: string } | null {
  const button = (event.target as Element | null)?.closest?.(`button[${MEDIA_REF_ATTR}]`);
  if (!button || !event.currentTarget.contains(button)) return null;
  return { mediaRef: button.getAttribute(MEDIA_REF_ATTR) ?? '', mimeType: button.getAttribute(MEDIA_TYPE_ATTR) ?? '' };
}

/**
 * Click handler for rendered markdown: loads the clicked "Load image" button's
 * image through main and swaps it in. Returns true when it handled the click.
 */
export function handleRemoteImageClick(event: React.MouseEvent<HTMLElement>): boolean {
  const button = (event.target as Element | null)?.closest?.(`button[${ATTR}]`) as HTMLButtonElement | null;
  if (!button || !event.currentTarget.contains(button)) return false;
  event.preventDefault();
  const src = button.getAttribute(ATTR) ?? '';
  const label = button.firstElementChild;
  button.disabled = true;
  if (label) label.textContent = 'Loading image…';
  window.clubhouse.chat.fetchRemoteImage(src).then(dataUrlOf).then((url) => {
    remember(src, url);
    button.replaceWith(makeImage(button.ownerDocument, url, ''));
  }, (err: unknown) => {
    // telemetry-exempt: shown on the button; the link itself is still in the title.
    button.disabled = false;
    const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '';
    if (label) label.textContent = message || "Couldn't load the image";
  });
  return true;
}

/** For tests. */
export function clearLoadedImages(): void {
  loaded.clear();
  loadedChars = 0;
  localCache.clear();
}
