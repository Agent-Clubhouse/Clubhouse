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

export function renderWikiMarkdown(content: string, pageNames: string[]): string {
  const md = new Marked();

  const renderer = new Marked().defaults.renderer!;
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

  md.use({
    extensions: [createWikiLinkExtension(pageNames)],
    renderer: { code: codeRenderer },
  });

  return md.parse(content) as string;
}

// ── React component ─────────────────────────────────────────────────

interface WikiMarkdownPreviewProps {
  content: string;
  pageNames: string[];
  onNavigate: (pageName: string) => void;
}

export function WikiMarkdownPreview({ content, pageNames, onNavigate }: WikiMarkdownPreviewProps) {
  injectWikiLinkStyle();

  const containerRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    return renderWikiMarkdown(content, pageNames);
  }, [content, pageNames]);

  const handleClick = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const link = target.closest('[data-wiki-link]') as HTMLElement | null;
    if (!link) return;
    // Only navigate valid (non-broken) links
    if (link.classList.contains('wiki-link-broken')) return;
    e.preventDefault();
    const pageName = link.getAttribute('data-wiki-link');
    if (pageName) {
      onNavigate(pageName);
    }
  }, [onNavigate]);

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
