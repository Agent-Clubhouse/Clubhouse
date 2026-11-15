import { describe, expect, it } from 'vitest';
import { continueList, indentList, toggleEmphasis } from './markdown-aids';
const selection = (start: number, end = start) => ({ start, end });
const edit = (text: string, start: number, end = start) => ({ text, selection: selection(start, end) });

describe('source Markdown aids', () => {
  it.each(['*', '**'] as const)('wraps, unwraps and inserts %s with the inner selection retained', (marker) => {
    const n = marker.length;
    const wrapped = toggleEmphasis('a word!', selection(2, 6), marker);
    expect(wrapped).toEqual(edit(`a ${marker}word${marker}!`, 2 + n, 6 + n));
    expect(toggleEmphasis(wrapped.text, wrapped.selection, marker)).toEqual(edit('a word!', 2, 6));
    expect(toggleEmphasis(wrapped.text, selection(2, 6 + n * 2), marker)).toEqual(edit('a word!', 2, 6));
    expect(toggleEmphasis('ab', selection(1), marker)).toEqual(edit(`a${marker}${marker}b`, 1 + n));
  });

  it.each(['- ', '* ', '8. ', '  99. '])('continues %s at end of a nonempty item', (prefix) => {
    const text = prefix + 'hello';
    const nextPrefix = prefix.replace('8.', '9.').replace('99.', '100.');
    const next = text + '\n' + nextPrefix;
    expect(continueList(text, selection(text.length))).toEqual(edit(next, next.length));
  });

  it.each(['- ', '* ', '4. ', '  4.   '])('exits empty %s', (text) => {
    expect(continueList(text, selection(text.length))).toEqual(edit('', 0));
  });

  it('renumbers following numbered siblings and skips nested children', () => {
    expect(continueList('8. a\n9. b\n  1. child\n10. c\n\n50. separate', selection(4)))
      .toEqual(edit('8. a\n9. \n10. b\n  1. child\n11. c\n\n50. separate', 8));
    expect(continueList('8. a\n9. \n10. b', selection(8)))
      .toEqual(edit('8. a\n\n9. b', 5));
  });

  it.each(['- a', '* a', '12. a'])('indents and outdents %s by two spaces, preserving selection', (text) => {
    const indented = indentList(text, selection(2, 3));
    expect(indented).toEqual(edit('  ' + text, 4, 5));
    expect(indentList(indented!.text, indented!.selection, true)).toEqual(edit(text, 2, 3));
    expect(indentList(text, selection(0), true)).toEqual(edit(text, 0));
  });

  it('leaves nonitems, multiline selections and miditem returns alone', () => {
    expect(indentList('plain', selection(2))).toBeNull();
    expect(indentList('- a\n- b', selection(2, 6))).toBeNull();
    expect(continueList('- abc\nnext', selection(3))).toBeNull();
    expect(continueList('- abc', selection(3))).toBeNull();
    expect(continueList('- abc', selection(2, 5))).toBeNull();
  });
});
