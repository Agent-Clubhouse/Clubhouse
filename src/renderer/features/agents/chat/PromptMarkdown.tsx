import { useMemo, type ReactNode } from 'react';
import type { Node as PMNode } from 'prosemirror-model';
import { parsePrompt } from './prompt-codec';

/** The same restricted subset as the composer; React escapes literal text.
 * No HTML parser, links, code, headings or underscore formatting. */
export function PromptMarkdown({ text }: { text: string }) {
  const doc = useMemo(() => parsePrompt(text), [text]);
  function render(node: PMNode, key: number): ReactNode {
    if (node.isText) {
      let result: ReactNode = node.text;
      for (const mark of node.marks) result = mark.type.name === 'strong' ? <strong>{result}</strong> : <em>{result}</em>;
      return <span key={key}>{result}</span>;
    }
    const children: ReactNode[] = [];
    node.forEach((child, offset) => children.push(render(child, offset)));
    switch (node.type.name) {
      case 'hard_break': return <br key={key} />;
      // A block, so an empty paragraph (a blank line) still takes a line of height.
      case 'paragraph': return <div key={key} className="whitespace-pre-wrap">{children.length ? children : <br />}</div>;
      case 'list_item': return <li key={key}>{children}</li>;
      case 'ordered_list': return <ol key={key} start={node.attrs.order} className="my-0 pl-5 list-decimal whitespace-pre-wrap">{children}</ol>;
      case 'bullet_list': return <ul key={key} className="my-0 pl-5 list-disc whitespace-pre-wrap">{children}</ul>;
      default: return null;
    }
  }
  const blocks: ReactNode[] = [];
  doc.forEach((node, offset, index) => {
    // Paragraphs are blocks now; the newline only keeps textContent (and copy) equal to the source.
    if (index && node.type.name === 'paragraph') blocks.push('\n');
    blocks.push(render(node, offset));
  });
  return <>{blocks}</>;
}
