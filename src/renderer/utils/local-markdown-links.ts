import type { Token } from 'marked';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const TARGET_ATTR = 'data-clubhouse-local-file';

/** Only explicit drive paths and local file URLs need to survive URI sanitization. */
function needsLocalTarget(href: string): boolean {
  if (!href || href.length > 1024 || /[\0\r\n]/.test(href)) return false;
  if (/^[A-Za-z]:[\\/]/.test(href)) return true;
  if (!/^file:\/\//i.test(href)) return false;
  try {
    const url = new URL(href);
    return !url.hostname || url.hostname.toLowerCase() === 'localhost';
  } catch {
    return false;
  }
}

/** Read app-owned metadata from HTML anchors only; sanitized raw data attrs never reach here. */
export function localMarkdownTarget(anchor: Element): string | null {
  return anchor.namespaceURI === HTML_NAMESPACE && anchor.localName === 'a'
    ? anchor.getAttribute(TARGET_ATTR) : null;
}

/**
 * Preserve real Markdown link tokens behind inert fragments. DOMPurify still
 * sees exactly its existing policy; original paths never become href/src URLs.
 * This closure and its nonce belong to one render, including all Mermaid segments.
 */
export function localMarkdownLinks(source: string) {
  const prefix = `#clubhouse-local-file-${globalThis.crypto.randomUUID()}-`;
  const targets = new Map<string, string>();
  // Fail closed on a source-spelled collision. Parsed/HTML-entity collisions
  // are checked across all sanitized segments below as well.
  const collision = source.includes(prefix);
  const walkToken = (token: Token) => {
    if (collision || token.type !== 'link' || !needsLocalTarget(token.href)) return;
    const marker = `${prefix}${targets.size}`;
    targets.set(marker, token.href);
    token.href = marker;
  };
  const restoreAll = (sanitized: string[]): string[] => {
    if (!targets.size) return sanitized;
    const templates = sanitized.map((html) => {
      const template = document.createElement('template');
      template.innerHTML = html;
      return template;
    });
    const matches = new Map<string, Element[]>();
    for (const template of templates) {
      for (const anchor of template.content.querySelectorAll('a[href]')) {
        const marker = anchor.getAttribute('href')!;
        if (!targets.has(marker)) continue;
        const group = matches.get(marker) ?? [];
        group.push(anchor);
        matches.set(marker, group);
      }
    }
    for (const [marker, href] of targets) {
      const group = matches.get(marker);
      if (group?.length !== 1) continue;
      const anchor = group[0];
      if (anchor.namespaceURI !== HTML_NAMESPACE || anchor.localName !== 'a') continue;
      anchor.setAttribute(TARGET_ATTR, href);
    }
    return templates.map((template) => template.innerHTML);
  };
  return { walkToken, restore: (sanitized: string) => restoreAll([sanitized])[0], restoreAll };
}
