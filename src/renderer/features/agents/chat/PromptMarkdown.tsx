import type { ReactNode } from 'react';
import { listItem } from './markdown-aids';

/** Only the composer's small source-formatting vocabulary. React escapes all
 * text: HTML, links, headings, paths, fences and other Markdown stay literal. */
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\*\*([^*\n]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)/g;
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(from, match.index));
    parts.push(match[1] !== undefined
      ? <strong key={match.index}>{match[1]}</strong>
      : <em key={match.index}>{match[2]}</em>);
    from = match.index + match[0].length;
  }
  parts.push(text.slice(from));
  return parts;
}

export function PromptMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  let at = 0;
  let fence: string | null = null;
  const nodes: ReactNode[] = [];
  function list(indent: number): ReactNode {
    const first = listItem(lines[at])!;
    const ordered = first[2].endsWith('.');
    const key = at;
    const items: ReactNode[] = [];
    while (at < lines.length) {
      const item = listItem(lines[at]);
      if (!item || item[1].length !== indent || item[2].endsWith('.') !== ordered) break;
      const itemKey = at++;
      const children: ReactNode[] = [];
      while (at < lines.length) {
        const child = listItem(lines[at]);
        if (!child || child[1].length <= indent) break;
        children.push(list(child[1].length));
      }
      items.push(<li key={itemKey}>{inline(item[3])}{children}</li>);
    }
    const className = 'my-0 pl-5 whitespace-pre-wrap';
    return ordered
      ? <ol key={key} start={Number.parseInt(first[2], 10)} className={`${className} list-decimal`}>{items}</ol>
      : <ul key={key} className={`${className} list-disc`}>{items}</ul>;
  }
  while (at < lines.length) {
    const line = lines[at];
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      nodes.push(<span key={at} className="whitespace-pre-wrap">{line}{at < lines.length - 1 ? '\n' : ''}</span>);
      at++;
    } else if (!fence && listItem(line)) {
      nodes.push(list(listItem(line)![1].length));
    } else {
      nodes.push(<span key={at} className="whitespace-pre-wrap">{fence || /^ {4}/.test(line) ? line : inline(line)}{at < lines.length - 1 ? '\n' : ''}</span>);
      at++;
    }
  }
  return <>{nodes}</>;
}
