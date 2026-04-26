import React, { useMemo } from 'react';
import { marked, type Token, type TokensList } from 'marked';
import { useSafeMarkdownLinks } from '../../../utils/safe-markdown-links';
import { sanitizeMarkdownHtml } from '../../../utils/safe-markdown';
import { MermaidDiagram } from './MermaidDiagram';
import hljs from 'highlight.js/lib/core';

// Register languages selectively to keep bundle small
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

// Configure marked with highlight.js via renderer
const renderer = new marked.Renderer();
const _originalCode = renderer.code;
renderer.code = function (args: { text: string; lang?: string; escaped?: boolean }) {
  const lang = args.lang || '';
  const code = args.text;
  if (lang && hljs.getLanguage(lang)) {
    const highlighted = hljs.highlight(code, { language: lang }).value;
    return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
  }
  const auto = hljs.highlightAuto(code).value;
  return `<pre><code class="hljs">${auto}</code></pre>`;
};
marked.setOptions({ renderer });

// CSS that maps hljs classes to Clubhouse theme CSS custom properties
const HLJS_THEME_CSS = `
.hljs { color: inherit; background: transparent; }
.hljs-keyword { color: var(--hljs-keyword); }
.hljs-string { color: var(--hljs-string); }
.hljs-number { color: var(--hljs-number); }
.hljs-literal { color: var(--hljs-number); }
.hljs-comment { color: var(--hljs-comment); font-style: italic; }
.hljs-doctag { color: var(--hljs-comment); }
.hljs-function { color: var(--hljs-function); }
.hljs-title { color: var(--hljs-function); }
.hljs-title.function_ { color: var(--hljs-function); }
.hljs-type { color: var(--hljs-type); }
.hljs-built_in { color: var(--hljs-type); }
.hljs-variable { color: var(--hljs-variable); }
.hljs-params { color: var(--hljs-variable); }
.hljs-regexp { color: var(--hljs-regexp); }
.hljs-tag { color: var(--hljs-tag); }
.hljs-attr { color: var(--hljs-attribute); }
.hljs-attribute { color: var(--hljs-attribute); }
.hljs-symbol { color: var(--hljs-symbol); }
.hljs-meta { color: var(--hljs-meta); }
.hljs-addition { color: var(--hljs-addition); }
.hljs-deletion { color: var(--hljs-deletion); }
.hljs-property { color: var(--hljs-property); }
.hljs-punctuation { color: var(--hljs-punctuation); }
.hljs-selector-class { color: var(--hljs-type); }
.hljs-selector-id { color: var(--hljs-type); }
.hljs-selector-tag { color: var(--hljs-tag); }
`;

let styleInjected = false;

function injectHljsStyle(): void {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.textContent = HLJS_THEME_CSS;
  document.head.appendChild(style);
  styleInjected = true;
}

type Segment =
  | { kind: 'html'; html: string }
  | { kind: 'mermaid'; code: string };

/** Split markdown into html/mermaid segments by extracting top-level mermaid fenced blocks.
 *  Nested blocks (inside lists/blockquotes) fall through to normal code-block rendering. */
export function splitMermaidSegments(content: string): Segment[] {
  const tokens = marked.lexer(content) as TokensList;
  const segments: Segment[] = [];
  let buffer: Token[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    // marked.parser uses links from the buffer; preserve the lexer's link references.
    Object.assign(buffer, { links: tokens.links });
    const html = marked.parser(buffer as unknown as TokensList);
    segments.push({ kind: 'html', html });
    buffer = [];
  };

  for (const token of tokens) {
    if (token.type === 'code' && (token as { lang?: string }).lang === 'mermaid') {
      flush();
      segments.push({ kind: 'mermaid', code: (token as { text: string }).text });
    } else {
      buffer.push(token);
    }
  }
  flush();
  return segments;
}

export function MarkdownPreview({ content }: { content: string }) {
  injectHljsStyle();
  const handleClick = useSafeMarkdownLinks();

  const segments = useMemo(() => splitMermaidSegments(content), [content]);

  return React.createElement(
    'div',
    {
      className: 'help-content p-4 overflow-auto h-full focus:outline-none',
      onClick: handleClick,
      tabIndex: 0,
    },
    ...segments.map((segment, i) => {
      if (segment.kind === 'mermaid') {
        return React.createElement(MermaidDiagram, { key: `m-${i}`, code: segment.code });
      }
      return React.createElement('div', {
        key: `h-${i}`,
        dangerouslySetInnerHTML: { __html: sanitizeMarkdownHtml(segment.html) },
      });
    }),
  );
}
