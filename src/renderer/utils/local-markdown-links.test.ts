import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { marked } from 'marked';
import { localMarkdownLinks, localMarkdownTarget } from './local-markdown-links';
import { renderMarkdownSafe, sanitizeMarkdownHtml } from './safe-markdown';
import { renderChatMarkdown } from '../features/agents/chat/rich/markdown-images';

const NONCE = '11111111-2222-4333-8444-555555555555';
const MARKER = `#clubhouse-local-file-${NONCE}-0`;
const anchors = (html: string) => {
  const template = document.createElement('template');
  template.innerHTML = html;
  return [...template.content.querySelectorAll('a')];
};
beforeEach(() => vi.stubGlobal('crypto', { randomUUID: () => NONCE }));
afterEach(() => vi.unstubAllGlobals());

it.each(['C:/scratch/notes.md', 'file:///tmp/notes%20%23caf%C3%A9.md', 'file://localhost/C:/scratch/notes.md'])(
  'preserves a real Markdown target %s behind an inert href without reading it', (href) => {
    const [anchor] = anchors(renderMarkdownSafe(`[notes](${href})`));
    expect(anchor.getAttribute('href')).toBe(MARKER);
    expect(localMarkdownTarget(anchor)).toBe(href);
  },
);

it('keeps ordinary web, relative and POSIX links unchanged, and refuses remote file URL hosts', () => {
  const links = anchors(renderMarkdownSafe('[web](https://example.test/a) [relative](./notes.md) [posix](/tmp/notes.md) [remote](file://other-host/share/a.md)'));
  expect(links.slice(0, 3).map((a) => a.getAttribute('href'))).toEqual(['https://example.test/a', './notes.md', '/tmp/notes.md']);
  expect(links.map(localMarkdownTarget)).toEqual([null, null, null, null]);
  expect(links[3].hasAttribute('href')).toBe(false);
});

it('does not preserve raw HTML/SVG/resource attributes or forged input metadata', () => {
  const html = renderMarkdownSafe('[real](C:/scratch/a.md) <a href="file:///tmp/raw.md" data-clubhouse-local-file="C:/forged.md" onclick="alert(1)">raw</a> <img src="file:///tmp/image.png" onerror="alert(2)"><svg><a href="file:///tmp/svg.md">svg</a><use href="file:///tmp/icon.svg"></use></svg><script>alert(3)</script>');
  const template = document.createElement('template');
  template.innerHTML = html;
  expect(anchors(html).map(localMarkdownTarget)).toEqual(['C:/scratch/a.md', null, null]);
  expect(template.content.querySelector('img')?.hasAttribute('src')).toBe(false);
  expect(template.content.querySelector('use')?.hasAttribute('href')).toBe(false);
  expect(html).not.toMatch(/onclick|onerror|<script|C:\/forged/);
});

it('does not trust an SVG anchor even if app metadata is manually placed on it', () => {
  const anchor = document.createElementNS('http://www.w3.org/2000/svg', 'a');
  anchor.setAttribute('data-clubhouse-local-file', 'C:/forged.md');
  expect(localMarkdownTarget(anchor)).toBeNull();
});

it('fails closed on a source-spelled marker collision and ignores unknown markers', () => {
  const links = anchors(renderMarkdownSafe(`[real](C:/scratch/a.md) <a href="${MARKER}">raw</a> <a href="#clubhouse-local-file-unknown-0" data-clubhouse-local-file="C:/forged.md">unknown</a>`));
  expect(links.map(localMarkdownTarget)).toEqual([null, null, null]);
});

it.each(['&#35;', '&#x23;'])('restores neither duplicate after parsing HTML entity %s', (hash) => {
  const encoded = hash + MARKER.slice(1);
  const links = anchors(renderMarkdownSafe(`[real](C:/scratch/a.md) <a href="${encoded}">raw</a>`));
  expect(links.map((a) => a.getAttribute('href'))).toEqual([MARKER, MARKER]);
  expect(links.map(localMarkdownTarget)).toEqual([null, null]);
});

it('checks duplicate anchors across sanitized segments, including SVG namespaces', () => {
  const context = localMarkdownLinks('[real](C:/scratch/a.md)');
  const real = marked.parse('[real](C:/scratch/a.md)', { async: false, walkTokens: context.walkToken }) as string;
  const raw = `<svg><a href="&#35;${MARKER.slice(1)}">raw</a></svg>`;
  const restored = context.restoreAll([sanitizeMarkdownHtml(real), sanitizeMarkdownHtml(raw)]);
  expect(restored.flatMap(anchors).map(localMarkdownTarget)).toEqual([null, null]);
});

it('keeps chat local-image handling separate from preserved anchor targets', () => {
  const html = renderChatMarkdown('[notes](C:/scratch/a.md) ![picture](file:///tmp/picture.png)');
  expect(localMarkdownTarget(anchors(html)[0])).toBe('C:/scratch/a.md');
  expect(html).toContain('data-chat-local-image="file:///tmp/picture.png"');
  expect(html).not.toContain('src="file:');
});
