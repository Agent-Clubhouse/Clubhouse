import { useEffect, useState, useMemo } from 'react';
import { useUIStore } from '../../stores/uiStore';
import hljs from 'highlight.js/lib/core';

// Register common languages
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';
import plaintext from 'highlight.js/lib/languages/plaintext';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('plaintext', plaintext);

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python',
  json: 'json',
  css: 'css', scss: 'css',
  html: 'xml', htm: 'xml', svg: 'xml', xml: 'xml',
  md: 'markdown', mdx: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sql: 'sql',
  diff: 'diff', patch: 'diff',
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);
const BINARY_EXTS = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot', 'zip', 'gz', 'tar', 'pdf', 'exe', 'dmg', 'so', 'dylib', 'node']);

function getExt(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() || '';
}

export function FileViewer() {
  const { selectedFilePath } = useUIStore();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ext = selectedFilePath ? getExt(selectedFilePath) : '';
  const fileName = selectedFilePath?.split('/').pop() || '';

  useEffect(() => {
    if (!selectedFilePath) return;
    setContent(null);
    setError(null);

    if (BINARY_EXTS.has(ext)) {
      setError('Binary file — cannot display');
      return;
    }
    if (IMAGE_EXTS.has(ext) && ext !== 'svg') {
      // Images handled separately in render
      return;
    }

    setLoading(true);
    window.clubhouse.file.read(selectedFilePath)
      .then((text: string) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [selectedFilePath, ext]);

  if (!selectedFilePath) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <div className="text-center text-ctp-subtext0">
          <p className="text-lg mb-2">No file selected</p>
          <p className="text-sm">Select a file from the tree to view it</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <p className="text-ctp-subtext0 text-sm">{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <p className="text-ctp-subtext0 text-sm">Loading...</p>
      </div>
    );
  }

  // Image viewer
  if (IMAGE_EXTS.has(ext) && ext !== 'svg') {
    return (
      <div className="h-full bg-ctp-base flex flex-col">
        <FileHeader name={fileName} path={selectedFilePath} lang="" />
        <div className="flex-1 flex items-center justify-center p-8 overflow-auto">
          <img
            src={`file://${selectedFilePath}`}
            alt={fileName}
            className="max-w-full max-h-full object-contain rounded"
          />
        </div>
      </div>
    );
  }

  if (content === null) return null;

  // Markdown preview
  if (ext === 'md' || ext === 'mdx') {
    return (
      <div className="h-full bg-ctp-base flex flex-col">
        <FileHeader name={fileName} path={selectedFilePath} lang="markdown" />
        <div className="flex-1 overflow-auto">
          <CodeView content={content} lang="markdown" />
        </div>
      </div>
    );
  }

  // Source code view
  const lang = EXT_TO_LANG[ext] || '';

  return (
    <div className="h-full bg-ctp-base flex flex-col">
      <FileHeader name={fileName} path={selectedFilePath} lang={lang || ext} />
      <div className="flex-1 overflow-auto">
        <CodeView content={content} lang={lang} />
      </div>
    </div>
  );
}

function FileHeader({ name, path, lang }: { name: string; path: string; lang: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-surface-0 bg-ctp-mantle flex-shrink-0">
      <span className="text-sm font-medium text-ctp-text">{name}</span>
      {lang && (
        <span className="text-xs px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0">{lang}</span>
      )}
      <span className="text-xs text-ctp-subtext0 truncate ml-auto">{path}</span>
    </div>
  );
}

function CodeView({ content, lang }: { content: string; lang: string }) {
  const highlighted = useMemo(() => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(content, { language: lang }).value;
      } catch {
        // fall through
      }
    }
    return escapeHtml(content);
  }, [content, lang]);

  const lines = content.split('\n');

  return (
    <div className="flex text-xs font-mono leading-5">
      {/* Line numbers */}
      <div className="flex-shrink-0 text-right pr-3 pl-4 py-3 select-none text-ctp-subtext0/50 border-r border-surface-0 bg-ctp-mantle/30">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      {/* Code content */}
      <pre className="flex-1 py-3 pl-4 pr-4 overflow-x-auto">
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
