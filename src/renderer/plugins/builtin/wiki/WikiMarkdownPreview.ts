import React, { useMemo, useEffect, useRef, useCallback } from 'react';
import { Marked } from 'marked';
import hljs from 'highlight.js/lib/core';

import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import csharp from 'highlight.js/lib/languages/csharp';
import markdown from 'highlight.js/lib/languages/markdown';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import cpp from 'highlight.js/lib/languages/cpp';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('bash', shell);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('cpp', cpp);

// ── Wiki link styles ────────────────────────────────────────────────

const WIKI_LINK_CSS = `
.wiki-link {
  color: var(--ctp-accent);
  text-decoration: underline;
  text-decoration-style: dashed;
  cursor: pointer;
}
.wiki-link:hover {
  opacity: 0.8;
}
.wiki-link-broken {
  color: var(--ctp-red);
  opacity: 0.6;
  cursor: default;
}
.wiki-link-broken:hover {
  opacity: 0.6;
}
`;

let wikiStyleInjected = false;

function injectWikiLinkStyle(): void {
  if (wikiStyleInjected) return;
  const style = document.createElement('style');
  style.textContent = WIKI_LINK_CSS;
  document.head.appendChild(style);
  wikiStyleInjected = true;
}

// ── Wiki link extension for marked ──────────────────────────────────

export function createWikiLinkExtension(pageNames: string[]) {
  const pageSet = new Set(
    pageNames.map((n) => n.replace(/\.md$/i, '').toLowerCase()),
  );

  return {
    name: 'wikiLink',
    level: 'inline' as const,
    start(src: string) {
      return src.indexOf('[[');
    },
    tokenizer(src: string) {
      const match = /^\[\[([^\]]+)\]\]/.exec(src);
      if (match) {
        return {
          type: 'wikiLink',
          raw: match[0],
          pageName: match[1].trim(),
        };
      }
      return undefined;
    },
    renderer(token: { pageName: string }) {
      const normalised = token.pageName.toLowerCase();
      const exists = pageSet.has(normalised);
      const cls = exists ? 'wiki-link' : 'wiki-link wiki-link-broken';
      return `<a class="${cls}" data-wiki-link="${token.pageName}">${token.pageName}</a>`;
    },
  };
}

/**
 * Resolve an ADO wiki link href to a wiki file path.
 * ADO links use formats like /Page-Name, /Folder/Page-Name, or ./Relative-Page.
 * Returns the resolved page name (without .md extension) or null if external.
 */
export function resolveAdoLink(href: string): string | null {
  // Skip external URLs and anchors
  if (/^https?:\/\//i.test(href) || href.startsWith('#') || href.startsWith('mailto:')) {
    return null;
  }
  // Strip leading / or ./
  let path = href.replace(/^\.?\//, '');
  // Strip .md extension if present
  path = path.replace(/\.md$/i, '');
  // Decode URI components (but keep %2D as hyphen since we're resolving to filenames)
  try {
    path = decodeURIComponent(path);
  } catch {
    // Invalid URI — keep as-is
  }
  return path || null;
}

export function renderWikiMarkdown(content: string, pageNames: string[], wikiStyle: string = 'github'): string {
  const md = new Marked();

  const codeRenderer = (args: { text: string; lang?: string }) => {
    const lang = args.lang || '';
    const code = args.text;
    if (lang && hljs.getLanguage(lang)) {
      const highlighted = hljs.highlight(code, { language: lang }).value;
      return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
    }
    const auto = hljs.highlightAuto(code).value;
    return `<pre><code class="hljs">${auto}</code></pre>`;
  };

  // In ADO mode, override the link renderer to mark internal links with data-wiki-link
  const linkRenderer = wikiStyle === 'ado'
    ? (args: { href: string; text: string; title?: string | null }) => {
        const resolved = resolveAdoLink(args.href);
        if (resolved) {
          const titleAttr = args.title ? ` title="${args.title}"` : '';
          return `<a class="wiki-link" data-wiki-link="${resolved}" href="#"${titleAttr}>${args.text}</a>`;
        }
        // External link — render normally
        const titleAttr = args.title ? ` title="${args.title}"` : '';
        return `<a href="${args.href}"${titleAttr} target="_blank" rel="noopener noreferrer">${args.text}</a>`;
      }
    : undefined;

  const extensions = wikiStyle === 'github' ? [createWikiLinkExtension(pageNames)] : [];

  md.use({
    extensions,
    renderer: {
      code: codeRenderer,
      ...(linkRenderer ? { link: linkRenderer } : {}),
    },
  });

  return md.parse(content) as string;
}

// ── React component ─────────────────────────────────────────────────

interface WikiMarkdownPreviewProps {
  content: string;
  pageNames: string[];
  onNavigate: (pageName: string) => void;
  wikiStyle?: string;
}

export function WikiMarkdownPreview({ content, pageNames, onNavigate, wikiStyle = 'github' }: WikiMarkdownPreviewProps) {
  injectWikiLinkStyle();

  const containerRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    return renderWikiMarkdown(content, pageNames, wikiStyle);
  }, [content, pageNames, wikiStyle]);

  const handleClick = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement;

    // Handle wiki-link clicks (both [[wiki links]] and ADO-style marked links)
    const wikiLink = target.closest('[data-wiki-link]') as HTMLElement | null;
    if (wikiLink) {
      if (wikiLink.classList.contains('wiki-link-broken')) return;
      e.preventDefault();
      const pageName = wikiLink.getAttribute('data-wiki-link');
      if (pageName) {
        onNavigate(pageName);
      }
      return;
    }

    // In ADO mode, intercept any remaining <a> clicks that might be internal links
    if (wikiStyle === 'ado') {
      const anchor = target.closest('a') as HTMLAnchorElement | null;
      if (anchor) {
        const href = anchor.getAttribute('href') || '';
        if (href && !href.startsWith('#') && !/^https?:\/\//i.test(href) && !href.startsWith('mailto:')) {
          e.preventDefault();
          const resolved = resolveAdoLink(href);
          if (resolved) {
            onNavigate(resolved);
          }
        }
      }
    }
  }, [onNavigate, wikiStyle]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('click', handleClick);
    return () => el.removeEventListener('click', handleClick);
  }, [handleClick]);

  return React.createElement('div', {
    ref: containerRef,
    className: 'help-content p-4 overflow-auto h-full',
    dangerouslySetInnerHTML: { __html: html },
  });
}
