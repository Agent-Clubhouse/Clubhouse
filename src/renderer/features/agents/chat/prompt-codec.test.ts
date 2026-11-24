import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { parsePrompt, serializePrompt, sourcePosition, promptSchema } from './prompt-codec';
import { pastedDrafts } from './prompt-editor.testing';
const roundTrip = (text: string) => serializePrompt(parsePrompt(text)).text;

describe('restricted prompt codec', () => {
  it.each([
    '', 'plain', '  leading and trailing  \n\n', '**bold** and *italic*', '***both***', '- first  \n  continuation\n- next',
    '- first\n- second\n  * nested\n  * next\n- last',
    '7. first\n8. second\n   3. nested\n9. last',
    'before\n\n* bullet\n\nafter',
  ])('is stable for subset source %j', (text) => {
    expect(roundTrip(text)).toBe(text);
    expect(roundTrip(roundTrip(text))).toBe(text);
  });

  it.each([
    '# heading\n## other', '```js\n**literal**\n- code\n```',
    '~~~html\n<div>\n~~~', '    **indented code**\n    a_b_c',
    '<b>literal</b>\n<script>no()</script>', '[link](https://example.com)\n![image](file.png)',
    'C:\\Users\\user_name\\file.ts\n/dir_with_underscores/file_name',
    'a*b*c file_*name*', '| a | b |\n| - | - |', '> quote\n---',
    'a\r\nb\r\n', 'tabs\tand spaces  \n\n', '\\*escaped\\* and \\- item',
  ])('preserves non-subset bytes %j', (text) => {
    expect(roundTrip(text)).toBe(text);
  });

  it('creates only schema-supported semantic lists and marks', () => {
    const doc = parsePrompt('8. **first**\n   - *nested*\n9. next');
    expect(doc.firstChild?.type.name).toBe('ordered_list');
    expect(doc.firstChild?.attrs.order).toBe(8);
    expect(doc.firstChild?.firstChild?.lastChild?.type.name).toBe('bullet_list');
    expect(doc.textContent).toBe('firstnestednext');
  });

  it('normalizes numbered siblings deterministically', () => {
    const once = roundTrip('8. a\n40. b\n    6. child\n100. c');
    expect(once).toBe('8. a\n9. b\n   6. child\n10. c');
    expect(roundTrip(once)).toBe(once);
  });

  it('keeps irregular numbering exactly for the composer', () => {
    const text = '8. a\n40. b\n    6. child\n100. c';
    expect(serializePrompt(parsePrompt(text, { exact: true })).text).toBe(text);
    expect(parsePrompt('8. a\n9. b\n   6. child\n10. c', { exact: true }).firstChild?.type.name).toBe('ordered_list');
  });

  it('maps slash-token offsets through list and emphasis syntax', () => {
    const doc = parsePrompt('- **hello** /co');
    const source = serializePrompt(doc);
    const at = sourcePosition(doc, source.text.length);
    expect(source.positions[at]).toBe(source.text.length);
    expect(doc.resolve(at).parent.textContent).toBe('hello /co');
  });
});

// Source metadata must not be necessary for preserving text after an edit.
function withoutSources(node: import('prosemirror-model').Node): import('prosemirror-model').Node {
  if (node.isText) return node;
  return node.type.create({ ...node.attrs, source: null },
    Array.from({ length: node.childCount }, (_, i) => withoutSources(node.child(i))), node.marks);
}

it.each([
  String.raw`C:\repo\.env`, String.raw`C:\a\-b`, String.raw`C:\path\\name\*glob*`,
  '```diff\n- old\n+ **Note**\n```', '`- old **Note**`', '    - code\n    **Note**',
])('preserves edited source without cached source attributes: %j', (text) => {
  const doc = withoutSources(parsePrompt(text));
  expect(serializePrompt(doc).text).toBe(text);
});

it('leaves four-space list-looking code literal', () => {
  const doc = parsePrompt('    - code\n    1. code');
  expect(doc.firstChild?.type.name).toBe('paragraph');
  expect(serializePrompt(withoutSources(doc)).text).toBe('    - code\n    1. code');
});

it('uses parent marker widths for nesting and continuation, compatible with marked', async () => {
  const { marked } = await import('marked');
  const doc = parsePrompt('9. parent\n   - nested\n10. next\n    - child');
  const markdown = serializePrompt(withoutSources(doc)).text;
  expect(markdown).toBe('9. parent\n   - nested\n10. next\n    - child');
  const html = marked.parse(markdown) as string;
  const body = document.createElement('div'); body.innerHTML = html;
  expect(body.querySelectorAll('ol > li > ul > li')).toHaveLength(2);
});

it('property: normalized non-crossing documents round-trip with paragraphs, breaks and nested lists', () => {
  const { nodes: n, marks: m } = promptSchema;
  let seed = 3540;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const paragraph = () => {
    const content = [];
    for (let i = 0, count = 2 + random(6); i < count; i++) {
      if (i) content.push(random(7) === 0 ? n.hard_break.create() : promptSchema.text(' '));
      const mask = random(4);
      const text = ['alpha', 'beta', '"quote"', "'word'", 'x:y', 'tail', 'intraword'][random(7)];
      content.push(promptSchema.text(text, [...(mask & 2 ? [m.strong.create()] : []), ...(mask & 1 ? [m.em.create()] : [])]));
    }
    return n.paragraph.create(null, content);
  };
  const list = (depth: number): import('prosemirror-model').Node => {
    const ordered = random(2) === 0;
    const items = Array.from({ length: 1 + random(3) }, () => n.list_item.create(null,
      [paragraph(), ...(depth && random(2) ? [list(depth - 1)] : [])]));
    return ordered ? n.ordered_list.create({ order: 8 + random(5) }, items) : n.bullet_list.create(null, items);
  };
  // Enclosing whitespace is intentionally outside marks in Markdown. Compare
  // the canonical semantic document, ignoring source/literal cache attributes.
  const signature = (node: import('prosemirror-model').Node): unknown => {
    if (node.type === n.paragraph) {
      const chars: { text: string; mask: number }[] = [];
      node.forEach((child) => {
        const mask = child.marks.reduce((bits, mark) => bits | (mark.type === m.strong ? 2 : 1), 0);
        for (const text of child.type === n.hard_break ? '\n' : child.text ?? '') chars.push({ text, mask });
      });
      for (const bit of [1, 2]) for (let i = 0; i < chars.length;) {
        if (!(chars[i].mask & bit)) { i++; continue; }
        let end = i; while (end < chars.length && chars[end].mask & bit) end++;
        let left = i; while (left < end && /\s/.test(chars[left].text)) chars[left++].mask &= ~bit;
        let right = end - 1; while (right >= left && /\s/.test(chars[right].text)) chars[right--].mask &= ~bit;
        i = end;
      }
      return ['paragraph', chars];
    }
    return [node.type.name, node.attrs.order ?? null, Array.from({ length: node.childCount }, (_, i) => signature(node.child(i)))];
  };
  for (let i = 0; i < 300; i++) {
    const doc = n.doc.create(null, [paragraph(), list(2), paragraph()]);
    const source = serializePrompt(doc).text;
    expect(signature(parsePrompt(source)), `seed case ${i}: ${source}`).toEqual(signature(doc));
  }
});


it('property: arbitrary crossing marks serialize without added literal asterisks or altered text', () => {
  const { nodes: n, marks: m } = promptSchema;
  let seed = 3542;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let sample = 0; sample < 1000; sample++) {
    const children = Array.from({ length: 2 + random(9) }, () => {
      const mask = random(4);
      return promptSchema.text(['alpha', ' beta ', '"quote"', "'word'", 'x:y', 'tail ', 'intraword'][random(7)],
        [...(mask & 2 ? [m.strong.create()] : []), ...(mask & 1 ? [m.em.create()] : [])]);
    });
    const doc = n.doc.create(null, n.paragraph.create(null, children));
    const markdown = serializePrompt(doc).text;
    const body = document.createElement('div');
    body.innerHTML = marked.parseInline(markdown) as string;
    expect(body.textContent, `arbitrary sample ${sample}: ${markdown}`).toBe(doc.textContent);
    expect(body.textContent).not.toContain('*');
  }
});

it.each([
  [[2, 'a'], [3, 'b'], [1, 'c']],
  [[1, 'a'], [3, 'b'], [2, 'c']],
  [[2, 'a'], [3, 'b']],
  [[3, 'a'], [2, 'b']],
  [[0, 'prefix'], [1, 'word'], [0, 'suffix']],
  [[0, '"'], [2, 'word '], [0, '"']],
  [[2, 'one '], [3, 'two '], [1, 'three']],
].map((runs) => [runs]))('keeps targeted crossing/adjacent/whitespace text clean: %j', (runs) => {
  const { nodes: n, marks: m } = promptSchema;
  const doc = n.doc.create(null, n.paragraph.create(null, runs.map(([mask, text]) =>
    promptSchema.text(text as string, [...((mask as number) & 2 ? [m.strong.create()] : []), ...((mask as number) & 1 ? [m.em.create()] : [])]))));
  const markdown = serializePrompt(doc).text;
  const body = document.createElement('div'); body.innerHTML = marked.parseInline(markdown) as string;
  expect(body.textContent).toBe(doc.textContent);
  expect(parsePrompt(markdown).textContent).toBe(doc.textContent);
});


it.each(['src/*foo*/x', 'file_*name*', 'http://x/*a*/b', '/path/**glob**/name', 'foo*bar*baz'])('keeps paths, URLs, globs and intraword markers literal: %s', (text) => {
  const doc = parsePrompt(text);
  expect(doc.textContent).toBe(text);
  expect(doc.firstChild?.firstChild?.marks).toEqual([]);
  expect(serializePrompt(withoutSources(doc)).text).toBe(text);
});

it('drops intraword italic that cannot honestly round-trip with the parser boundary rule', () => {
  const { nodes: n, marks: m } = promptSchema;
  const doc = n.doc.create(null, n.paragraph.create(null, [promptSchema.text('foo'), promptSchema.text('bar', [m.em.create()]), promptSchema.text('baz')]));
  expect(serializePrompt(doc).text).toBe('foobarbaz');
});

it.each(pastedDrafts)('restores pasted text exactly: %j', (text) => {
  expect(serializePrompt(parsePrompt(text, { exact: true })).text).toBe(text);
  expect(serializePrompt(withoutSources(parsePrompt(text, { exact: true }))).text).toBe(text);
});

// Behavior-value focused assertions.
it('behavior-value: preserves supported strong and emphasis semantics', () => {
  const doc = parsePrompt('**bold** and *italic*');
  expect(doc.firstChild?.child(0).marks.map((mark) => mark.type.name)).toEqual(['strong']);
  expect(doc.firstChild?.child(2).marks.map((mark) => mark.type.name)).toEqual(['em']);
});

it('behavior-value: maps visible selections to slash token and marked text', () => {
  const doc = parsePrompt('- **hello** /co');
  const source = serializePrompt(doc);
  const selectedSource = (visible: string) => {
    let found: [number, number] | undefined;
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return;
      const start = node.textContent.indexOf(visible);
      if (start >= 0) found = [pos + 1 + start, pos + 1 + start + visible.length];
    });
    expect(found).toBeDefined();
    const [from, to] = found!;
    expect(doc.textBetween(from, to)).toBe(visible);
    return source.text.slice(source.positions[from], source.positions[to]);
  };
  expect(selectedSource('/co')).toBe('/co');
  expect(selectedSource('hello')).toBe('hello');
  expect(selectedSource('hello')).not.toContain('*');
});

it('behavior-value: keeps fenced emphasis visibly literal and unmarked', () => {
  const text = '```\n**literal**\n```';
  const doc = parsePrompt(text);
  expect(doc.child(1).textContent).toBe('**literal**');
  expect(doc.child(1).firstChild?.marks).toEqual([]);
  expect(serializePrompt(doc).text).toBe(text);
});
