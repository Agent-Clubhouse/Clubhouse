/**
 * Images written in agent markdown (`![alt](src)`), with rich chat content
 * on (#2350). The sanitized HTML is rewritten before it reaches the page, in
 * an inert template, so nothing is fetched by inserting it:
 *
 * - `data:image/...` images stay (they're already bytes);
 * - web images become a "Load image" button; main fetches one only when it's
 *   clicked (window.clubhouse.chat.fetchRemoteImage) and it shows as a
 *   data: URL;
 * - anything else (file paths, file:, blob:) becomes its alt text or name,
 *   since the renderer doesn't load local files.
 */

import { dataUrlOf } from './media';

const ATTR = 'data-chat-remote-image';
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

/** `html` with its images made safe to insert; the same string when it has none. */
export function rewriteMarkdownImages(html: string): string {
  if (!html.includes('<img')) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const doc = template.content.ownerDocument;
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
    img.replaceWith(doc.createTextNode(alt || src.split(/[\\/]/).pop() || ''));
  }
  return template.innerHTML;
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
}
