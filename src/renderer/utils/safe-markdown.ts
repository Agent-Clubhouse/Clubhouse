import DOMPurify from 'dompurify';
import { marked } from 'marked';

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
];

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class',
  'type', 'checked', 'disabled', // for GFM task list checkboxes
];

/**
 * Renders markdown to sanitized HTML, stripping all script injection vectors.
 * Uses DOMPurify to prevent XSS from untrusted markdown content.
 */
export function renderMarkdownSafe(content: string): string {
  const raw = marked.parse(content, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}
