import { describe, expect, it } from 'vitest';
import { parsePrompt, serializePrompt, sourcePosition } from './prompt-codec';
const roundTrip = (text: string) => serializePrompt(parsePrompt(text)).text;

describe('restricted prompt codec', () => {
  it.each([
    '', 'plain', '  leading and trailing  \n\n', '**bold** and *italic*', '***both***', '- first\n  continuation\n- next',
    '- first\n- second\n  * nested\n  * next\n- last',
    '7. first\n8. second\n  3. nested\n9. last',
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
    const doc = parsePrompt('8. **first**\n  - *nested*\n9. next');
    expect(doc.firstChild?.type.name).toBe('ordered_list');
    expect(doc.firstChild?.attrs.order).toBe(8);
    expect(doc.firstChild?.firstChild?.lastChild?.type.name).toBe('bullet_list');
    expect(doc.textContent).toBe('firstnestednext');
  });

  it('normalizes numbered siblings deterministically', () => {
    const once = roundTrip('8. a\n40. b\n  6. child\n100. c');
    expect(once).toBe('8. a\n9. b\n  6. child\n10. c');
    expect(roundTrip(once)).toBe(once);
  });

  it('maps slash-token offsets through list and emphasis syntax', () => {
    const doc = parsePrompt('- **hello** /co');
    const source = serializePrompt(doc);
    const at = sourcePosition(doc, source.text.length);
    expect(source.positions[at]).toBe(source.text.length);
    expect(doc.resolve(at).parent.textContent).toBe('hello /co');
  });
});
