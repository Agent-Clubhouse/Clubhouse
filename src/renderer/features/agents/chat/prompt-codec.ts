import { Lexer, type Token } from 'marked';
import { Schema, type Node as PMNode } from 'prosemirror-model';
import { orderedList, bulletList, listItem } from 'prosemirror-schema-list';

export const promptSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*', group: 'block', attrs: { source: { default: null }, literal: { default: false } },
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
/** CommonMark asterisk emphasis only. Every other token stays literal,
 * including backslash escapes: a Windows path must never lose a character. */
function parseInline(source: string, literal = false): { nodes: PMNode[]; offsets: number[] } {
  const nodes: PMNode[] = [];
  const offsets: number[] = [0];
  const add = (text: string, sourceAt: number, marks: PMNode['marks'] = []) => {
    if (!text) return;
    nodes.push(promptSchema.text(text, marks));
    for (let i = 0; i < text.length; i++) offsets.push(sourceAt + i + 1);
  };
  if (literal) { add(source, 0); return { nodes, offsets }; }
  function tokens(items: Token[], base: number, marks: PMNode['marks'] = []) {
    let at = base;
    for (const token of items) {
      if ((token.type === 'strong' || token.type === 'em') && token.raw.startsWith('*')
        && (at === base || /[\s([{]/.test(source[at - 1]))) {
        const width = token.type === 'strong' ? 2 : 1;
        offsets[offsets.length - 1] = at + width;
        tokens(token.tokens, at + width, [...marks, promptSchema.marks[token.type].create()]);
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
  const paragraph = (source: string, literal = false) => promptSchema.nodes.paragraph.create({ source, literal }, parseInline(source, literal).nodes);
  const readList = (indent: number): PMNode => {
    const first = itemPattern.exec(lines[at])!;
    const ordered = first[2].endsWith('.');
    const items: PMNode[] = [];
    while (at < lines.length) {
      const item = itemPattern.exec(lines[at]);
      if (!item || item[1].length !== indent || item[2].endsWith('.') !== ordered) break;
      at++;
      const width = item[2].length + 1;
      const content = [paragraph(item[3])];
      while (at < lines.length) {
        const child = itemPattern.exec(lines[at]);
        if (child && child[1].length >= indent + width) {
          content.push(readList(child[1].length));
        } else if (!child && lines[at].startsWith(' '.repeat(indent + width))) {
          const body = lines[at++].slice(indent + width);
          const previous = content[content.length - 1];
          const added = parseInline(body).nodes;
          if (previous.type === promptSchema.nodes.paragraph) {
            content[content.length - 1] = promptSchema.nodes.paragraph.create(null,
              previous.content.cut(0, previous.content.size - (previous.textContent.endsWith('  ') ? 2 : 0)).append(promptSchema.nodes.paragraph.create(null, [promptSchema.nodes.hard_break.create(), ...added]).content));
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
    } else if (!fence && !/^ {4}/.test(line) && itemPattern.test(line)) {
      blocks.push(readList(itemPattern.exec(line)![1].length));
    } else {
      const literal = !!fence || /^ {4}/.test(line);
      if (!literal && line.endsWith('  ') && at + 1 < lines.length) {
        const content: PMNode[] = [];
        let body = lines[at++];
        for (;;) {
          const hard = body.endsWith('  ') && at < lines.length;
          content.push(...parseInline(hard ? body.slice(0, -2) : body).nodes);
          if (!hard) break;
          content.push(promptSchema.nodes.hard_break.create());
          body = lines[at++];
        }
        blocks.push(promptSchema.nodes.paragraph.create(null, content));
      } else { blocks.push(paragraph(line, literal)); at++; }
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
  const inline = (node: PMNode, pos: number, continuation: string) => {
    const source: unknown = node.attrs.source;
    if (typeof source === 'string') {
      const parsed = node.attrs.literal
        ? { nodes: source.split('\n').flatMap((line, i) => [...(i ? [promptSchema.nodes.hard_break.create()] : []), ...(line ? [promptSchema.text(line)] : [])]), offsets: Array.from({ length: source.length + 1 }, (_, i) => i) }
        : parseInline(source);
      if (promptSchema.nodes.paragraph.create(null, parsed.nodes).content.eq(node.content)) {
        const base = text.length; text += source;
        parsed.offsets.forEach((offset, i) => { positions[pos + 1 + i] = base + offset; });
        return;
      }
    }
    const chars: { value: string; mask: number; at: number; break?: boolean }[] = [];
    node.forEach((child, offset) => {
      const mask = child.marks.reduce((bits, mark) => bits | (mark.type === promptSchema.marks.strong ? 2 : 1), 0);
      if (child.type === promptSchema.nodes.hard_break) chars.push({ value: '\n', mask: 0, at: pos + 1 + offset, break: true });
      else for (let i = 0; i < (child.text?.length ?? 0); i++) chars.push({ value: child.text![i], mask, at: pos + 1 + offset + i });
    });
    // Expel enclosing whitespace per mark run, not per text node. This keeps
    // shared strong/em runs together across adjacent differently marked nodes.
    for (const bit of [1, 2]) {
      for (let i = 0; i < chars.length;) {
        if (!(chars[i].mask & bit)) { i++; continue; }
        let end = i; while (end < chars.length && chars[end].mask & bit) end++;
        let left = i; while (left < end && /\s/.test(chars[left].value)) chars[left++].mask &= ~bit;
        let right = end - 1; while (right >= left && /\s/.test(chars[right].value)) chars[right--].mask &= ~bit;
        i = end;
      }
    }
    const render = (line: typeof chars, simplify: (mask: number) => number) => {
      let value = '';
      const active: number[] = [];
      const mapped = new Map<number, number>();
      for (const char of line) {
        const mask = simplify(char.mask);
        const marks = [...(mask & 2 ? [2] : []), ...(mask & 1 ? [1] : [])];
        let keep = 0; while (keep < active.length && keep < marks.length && active[keep] === marks[keep]) keep++;
        while (active.length > keep) value += '*'.repeat(active.pop()!);
        for (const mark of marks.slice(keep)) { active.push(mark); value += '*'.repeat(mark); }
        mapped.set(char.at, value.length); value += char.value; mapped.set(char.at + 1, value.length);
      }
      while (active.length) value += '*'.repeat(active.pop()!);
      return { value, mapped };
    };
    const writeLine = (line: typeof chars) => {
      const plain = line.map((char) => char.value).join('');
      // Try balanced close/reopen runs first. CommonMark cannot represent every
      // crossing mark configuration without extra syntax. Simplify conflicting
      // marks instead of leaking literal markers or changing the user's text.
      const candidates = [(mask: number) => mask, (mask: number) => mask === 3 ? 2 : mask,
        (mask: number) => mask & 2, (mask: number) => mask & 1, () => 0];
      let output = render(line, () => 0);
      for (const simplify of candidates) {
        const candidate = render(line, simplify);
        const parsed = parseInline(candidate.value).nodes.flatMap((child) => {
          const mask = child.marks.reduce((bits, mark) => bits | (mark.type === promptSchema.marks.strong ? 2 : 1), 0);
          return (child.text ?? '').split('').map((value) => ({ value, mask }));
        });
        if (parsed.map((char) => char.value).join('') === plain && parsed.length === line.length
          && parsed.every((char, i) => char.mask === simplify(line[i].mask))) { output = candidate; break; }
      }
      const base = text.length; text += output.value;
      output.mapped.forEach((offset, at) => { positions[at] = base + offset; });
    };
    positions[pos + 1] = text.length;
    let line: typeof chars = [];
    for (const char of chars) {
      if (!char.break) { line.push(char); continue; }
      writeLine(line); line = [];
      positions[char.at] = text.length;
      // Literal paste must not acquire list indentation on the next keystroke.
      text += node.attrs.literal ? '\n' : '  \n' + continuation;
      positions[char.at + 1] = text.length;
    }
    writeLine(line);
  };
  const paragraph = (node: PMNode, pos: number, prefix: string, continuation = '') => {
    if (lineCount++) text += '\n';
    positions[pos] = text.length;
    text += prefix;
    inline(node, pos, continuation);
  };
  const list = (node: PMNode, pos: number, indent: number) => {
    let number = node.attrs.order as number;
    node.forEach((item, offset) => {
      const itemPos = pos + 1 + offset;
      const marker = node.type === promptSchema.nodes.ordered_list ? `${number++}. ` : `${node.attrs.bullet} `;
      const width = marker.length;
      let first = true;
      item.forEach((child, childOffset) => {
        const childPos = itemPos + 1 + childOffset;
        if (child.type === promptSchema.nodes.paragraph) {
          paragraph(child, childPos, ' '.repeat(indent) + (first ? marker : ' '.repeat(width)), ' '.repeat(indent + width));
          first = false;
        } else list(child, childPos, indent + width);
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
