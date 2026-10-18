import DOMPurify from 'dompurify';
import { marked } from 'marked';

// Keep DOMPurify above the monaco-editor-bundled version via package.json
// overrides; this avoids the monaco-editor 0.56.0 bump while still resolving
// the advisory-backed XSS issues in the direct runtime dependency.

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'a', 'ul', 'ol', 'li',
  'code', 'pre', 'blockquote',
  'em', 'strong', 'del',
  'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'br', 'hr',
  'div', 'span',
  'input', // for GFM task list checkboxes
  // SVG elements for inline rich content
  'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
  'g', 'text', 'tspan', 'defs', 'use', 'clipPath',
];

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class',
  'type', 'checked', 'disabled', // for GFM task list checkboxes
  // SVG attributes for inline rich content
  'viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'd', 'cx', 'cy', 'r', 'rx', 'ry',
  'x', 'x1', 'x2', 'y', 'y1', 'y2', 'points', 'transform', 'opacity',
  'xmlns', 'clip-path', 'id',
];

/**
 * Sanitize an HTML string using the same allowlist used for rendered markdown.
 * Useful when callers have already produced HTML through marked and only need the sanitization step.
 */
export function sanitizeMarkdownHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * Renders markdown to sanitized HTML, stripping all script injection vectors.
 * Uses DOMPurify to prevent XSS from untrusted markdown content.
 */
export function renderMarkdownSafe(content: string): string {
  const raw = marked.parse(content, { async: false }) as string;
  return sanitizeMarkdownHtml(raw);
}

const plainTextCache = new Map<string, string>();
const PLAIN_TEXT_CACHE_MAX = 200;

/**
 * Markdown as one line of plain text, for rows too small to render it.
 * Cached: list rows call this on every render.
 */
export function markdownToPlainText(content: string): string {
  const hit = plainTextCache.get(content);
  if (hit !== undefined) return hit;
  const doc = new DOMParser().parseFromString(renderMarkdownSafe(content), 'text/html');
  const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (plainTextCache.size >= PLAIN_TEXT_CACHE_MAX) plainTextCache.delete(plainTextCache.keys().next().value!);
  plainTextCache.set(content, text);
  return text;
}
