import { Lexer, type Token } from 'marked';
import { Schema, type Node as PMNode } from 'prosemirror-model';
import { orderedList, bulletList, listItem } from 'prosemirror-schema-list';

export const promptSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*', group: 'block', attrs: { source: { default: null } },
      parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    hard_break: { inline: true, group: 'inline', selectable: false, toDOM: () => ['br'], parseDOM: [{ tag: 'br' }] },
    ordered_list: { ...orderedList, content: 'list_item+', group: 'block' },
    bullet_list: { ...bulletList, attrs: { bullet: { default: '-' } }, content: 'list_item+', group: 'block' },
    list_item: { ...listItem, content: 'paragraph block*' },
  },
  marks: {
    strong: { toDOM: () => ['strong', 0], parseDOM: [{ tag: 'strong' }, { tag: 'b' }] },
    em: { toDOM: () => ['em', 0], parseDOM: [{ tag: 'em' }, { tag: 'i' }] },
  },
});

const itemPattern = /^( *)([-*]|\d+\.) (.*)$/;
/** Lex only inline tokens, accepting asterisk strong/em and explicit escapes.
 * Every other token (including links, HTML, code and underscore emphasis) is
 * retained as its literal raw source. Never invokes marked's HTML renderer. */
function parseInline(source: string, literal = false): { nodes: PMNode[]; offsets: number[] } {
  const nodes: PMNode[] = [];
  const offsets: number[] = [0];
  const add = (text: string, sourceAt: number, marks: PMNode['marks'] = [], width = 1) => {
    if (!text) return;
    nodes.push(promptSchema.text(text, marks));
    for (let i = 0; i < text.length; i++) offsets.push(sourceAt + i + width);
  };
  if (literal) { add(source, 0); return { nodes, offsets }; }
  function tokens(items: Token[], base: number, marks: PMNode['marks'] = []) {
    let at = base;
    let convertedEnd = -1;
    for (const token of items) {
      const allowed = (token.type === 'strong' || token.type === 'em') && token.raw.startsWith('*') &&
        (marks.length || at === 0 || /[\s([{]/.test(source[at - 1]) || convertedEnd === at);
      if (allowed && (token.type === 'strong' || token.type === 'em')) {
        const width = token.type === 'strong' ? 2 : 1;
        offsets[offsets.length - 1] = at + width;
        tokens(token.tokens, at + width, [...marks, promptSchema.marks[token.type].create()]);
        convertedEnd = at + token.raw.length;
      } else if (token.type === 'escape' && /^\\[*.-]$/.test(token.raw)) {
        add(token.text, at, marks, 2);
      } else add(token.raw, at, marks);
      at += token.raw.length;
    }
  }
  tokens(Lexer.lexInline(source, { gfm: false }), 0);
  return { nodes, offsets };
}

/** One source line per paragraph preserves unsupported Markdown and blank lines.
 * Only list prefixes and asterisk emphasis are interpreted. Never parses HTML. */
export function parsePrompt(markdown: string): PMNode {
  const lines = markdown.split('\n');
  let at = 0;
  let fence: string | null = null;
  const paragraph = (source: string, literal = false) => promptSchema.nodes.paragraph.create({ source }, parseInline(source, literal).nodes);
  const readList = (indent: number): PMNode => {
    const first = itemPattern.exec(lines[at])!;
    const ordered = first[2].endsWith('.');
    const items: PMNode[] = [];
    while (at < lines.length) {
      const item = itemPattern.exec(lines[at]);
      if (!item || item[1].length !== indent || item[2].endsWith('.') !== ordered) break;
      at++;
      const content = [paragraph(item[3])];
      while (at < lines.length) {
        const child = itemPattern.exec(lines[at]);
        if (child && child[1].length > indent) {
          content.push(readList(child[1].length));
        } else if (!child && lines[at].startsWith(' '.repeat(indent + 2))) {
          const body = lines[at++].slice(indent + 2);
          const previous = content[content.length - 1];
          const added = parseInline(body).nodes;
          if (previous.type === promptSchema.nodes.paragraph) {
            content[content.length - 1] = promptSchema.nodes.paragraph.create(null,
              previous.content.append(promptSchema.nodes.paragraph.create(null, [promptSchema.nodes.hard_break.create(), ...added]).content));
          } else content.push(paragraph(body));
        } else break;
      }
      items.push(promptSchema.nodes.list_item.create(null, content));
    }
    return ordered
      ? promptSchema.nodes.ordered_list.create({ order: Number.parseInt(first[2], 10) }, items)
      : promptSchema.nodes.bullet_list.create({ bullet: first[2] }, items);
  };
  const blocks: PMNode[] = [];
  while (at < lines.length) {
    const line = lines[at];
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (fence[0] === delimiter[0] && delimiter.length >= fence.length) fence = null;
      blocks.push(paragraph(line, true));
      at++;
    } else if (!fence && itemPattern.test(line)) {
      blocks.push(readList(itemPattern.exec(line)![1].length));
    } else {
      blocks.push(paragraph(line, !!fence || /^ {4}/.test(line)));
      at++;
    }
  }
  return promptSchema.nodes.doc.create(null, blocks);
}

export interface PromptSource { text: string; positions: number[] }

/** Deterministic Markdown plus editor-position → source-offset mapping for the
 * existing slash-token contract. Unedited literal paragraphs retain exact bytes. */
export function serializePrompt(doc: PMNode): PromptSource {
  let text = '';
  const positions: number[] = Array(doc.content.size + 1).fill(0);
  let lineCount = 0;
  const inline = (node: PMNode, pos: number, continuation: string, plainStart: boolean) => {
    const source: unknown = node.attrs.source;
    if (typeof source === 'string') {
      // Both literal and subset paragraphs may retain their original spelling.
      for (const literal of [false, true]) {
        const parsed = parseInline(source, literal);
        const original = promptSchema.nodes.paragraph.create(null, parsed.nodes);
        if (original.content.eq(node.content)) {
          const base = text.length;
          text += source;
          parsed.offsets.forEach((offset, i) => { positions[pos + 1 + i] = base + offset; });
          return;
        }
      }
    }
    positions[pos + 1] = text.length;
    node.forEach((child, offset) => {
      if (child.type === promptSchema.nodes.hard_break) {
        positions[pos + 1 + offset] = text.length;
        text += '\n' + continuation;
        plainStart = true;
        positions[pos + 2 + offset] = text.length;
        return;
      }
      const marker = child.marks.map((m) => m.type === promptSchema.marks.strong ? '**' : '*').join('');
      text += marker;
      const content = child.text ?? '';
      // Plain pasted Markdown must survive a reload as literal text. Escape
      // only actual emphasis tokens, keeping paths and unmatched stars intact.
      const escaped = new Set<number>();
      if (!marker && parseInline(content).nodes.some((n) => n.marks.length)) {
        for (let i = 0; i < content.length; i++) if (content[i] === '*') escaped.add(i);
      }
      const item = plainStart && !marker ? itemPattern.exec(content) : null;
      if (item) escaped.add(item[1].length + (item[2].endsWith('.') ? item[2].length - 1 : 0));
      plainStart = false;
      for (let i = 0; i <= content.length; i++) {
        positions[pos + 1 + offset + i] = text.length;
        if (i < content.length) text += (escaped.has(i) ? '\\' : '') + content[i];
      }
      text += marker;
    });
  };
  const paragraph = (node: PMNode, pos: number, prefix: string, continuation = '') => {
    if (lineCount++) text += '\n';
    positions[pos] = text.length;
    text += prefix;
    inline(node, pos, continuation, !prefix);
  };
  const list = (node: PMNode, pos: number, indent: number) => {
    let number = node.attrs.order as number;
    node.forEach((item, offset) => {
      const itemPos = pos + 1 + offset;
      let first = true;
      item.forEach((child, childOffset) => {
        const childPos = itemPos + 1 + childOffset;
        if (child.type === promptSchema.nodes.paragraph) {
          const marker = first ? (node.type === promptSchema.nodes.ordered_list ? `${number++}. ` : `${node.attrs.bullet} `) : '  ';
          paragraph(child, childPos, ' '.repeat(indent) + marker, ' '.repeat(indent + 2));
          first = false;
        } else list(child, childPos, indent + 2);
      });
    });
  };
  doc.forEach((node, pos) => {
    if (node.type === promptSchema.nodes.paragraph) paragraph(node, pos, '');
    else list(node, pos, 0);
  });
  positions[doc.content.size] = text.length;
  return { text, positions };
}

export function sourcePosition(doc: PMNode, offset: number): number {
  const { positions } = serializePrompt(doc);
  let best = 1;
  let distance = Infinity;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    for (let i = pos + 1; i <= pos + node.nodeSize - 1; i++) {
      const delta = Math.abs(positions[i] - offset);
      if (delta < distance) { best = i; distance = delta; }
    }
  });
  return best;
}
