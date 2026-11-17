import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from 'prosemirror-view';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { undo, redo } from 'prosemirror-history';
import { undoInputRule } from 'prosemirror-inputrules';
import { createPromptState, editingKey, indentItems, insertPlainText, replaceDraft, softReturn } from './prompt-editor';
import { serializePrompt, sourcePosition } from './prompt-codec';

let view: EditorView;
afterEach(() => view?.destroy());
function editor(source: string, at = source.length, to = at) {
  view = new EditorView(document.createElement('div'), {
    state: createPromptState(source),
    dispatchTransaction(tr) { view.updateState(view.state.apply(tr)); },
    handleScrollToSelection: () => true,
  });
  select(at, to);
  return view;
}
function select(from: number, to = from) {
  const doc = view.state.doc;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, sourcePosition(doc, from), sourcePosition(doc, to))));
}
const source = () => serializePrompt(view.state.doc).text;
function type(text: string) {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (fn) => fn(view, from, to, char, () => view.state.tr.insertText(char)));
    if (!handled) view.dispatch(view.state.tr.insertText(char));
  }
}
const key = (key: string, extra: KeyboardEventInit = {}) => editingKey(view, new KeyboardEvent('keydown', { key, ...extra }), true);

describe('structured prompt editing', () => {
  it.each([['- ', 'bullet_list', 1], ['* ', 'bullet_list', 1], ['8. ', 'ordered_list', 8]] as const)('converts typed %s to a real list and undoes to literal text', (prefix, kind, start) => {
    editor('');
    type(prefix);
    expect(view.state.doc.firstChild?.type.name).toBe(kind);
    if (kind === 'ordered_list') expect(view.state.doc.firstChild?.attrs.order).toBe(start);
    expect(undoInputRule(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(view.state.doc.textContent).toBe(prefix);
    expect(serializePrompt(createPromptState(source()).doc).text).toBe(source());
  });

  it.each([['*word*', 'em'], ['**word**', 'strong']] as const)('live-converts %s only at its closing marker, then undoes to literal asterisks', (text, mark) => {
    editor('');
    type(text.slice(0, -1));
    expect(view.state.doc.firstChild?.firstChild?.marks).toEqual([]);
    type(text.slice(-1));
    expect(view.state.doc.firstChild?.firstChild?.marks[0].type.name).toBe(mark);
    expect(view.state.doc.textContent).toBe('word');
    expect(key('z', { metaKey: true })).toBe(true);
    expect(view.state.doc.textContent).toBe(text);
    expect(view.state.doc.firstChild?.firstChild?.marks).toEqual([]);
  });

  it.each(['a*b*c', 'file_*name*', '/path/*name*', 'unclosed *word', '**unfinished*'])('does not convert midword, paths or unfinished emphasis %s', (text) => {
    editor(''); type(text);
    expect(view.state.doc.textContent).toBe(text);
    expect(view.state.doc.firstChild?.firstChild?.marks).toEqual([]);
  });

  it('splits a nonempty numbered item at the caret and renumbers', () => {
    editor('8. firstsecond\n9. next', 8);
    softReturn(view);
    expect(source()).toBe('8. first\n9. second\n10. next');
    undo(view.state, view.dispatch);
    expect(source()).toBe('8. firstsecond\n9. next');
    redo(view.state, view.dispatch);
    expect(source()).toBe('8. first\n9. second\n10. next');
  });

  it('exits an empty item and outdents an empty nested item one level', () => {
    editor('- parent\n  - ', 13);
    softReturn(view);
    expect(source()).toBe('- parent\n- ');
    softReturn(view);
    expect(source()).toBe('- parent\n');
  });

  it('inserts a line break outside lists, replacing the selection', () => {
    editor('first second', 5, 6);
    softReturn(view);
    expect(source()).toBe('first\nsecond');
    expect(view.state.doc.firstChild?.child(1).type.name).toBe('hard_break');
  });

  describe('emphasis can start on a new line after text (#3619)', () => {
    it.each([['*word*', 'em'], ['**word**', 'strong']] as const)('converts %s typed after a soft return, keeping the line break', (text, mark) => {
      editor('first'); softReturn(view); type(text);
      const paragraph = view.state.doc.firstChild!;
      expect(view.state.doc.childCount).toBe(1);
      expect([...Array(paragraph.childCount).keys()].map((i) => paragraph.child(i).type.name)).toEqual(['text', 'hard_break', 'text']);
      expect(paragraph.child(2).text).toBe('word');
      expect(paragraph.child(2).marks.map((m) => m.type.name)).toEqual([mark]);
      expect(source()).toBe(text.length > 6 ? 'first\n**word**' : 'first\n*word*');
    });

    it('undoes to the literal asterisks and keeps the soft return', () => {
      editor('first'); softReturn(view); type('*word*');
      expect(view.dom.querySelectorAll('em')).toHaveLength(1);
      key('z', { metaKey: true });
      expect(view.dom.querySelectorAll('em')).toHaveLength(0);
      expect(source()).toBe('first\n*word*');
      expect(view.state.doc.firstChild?.child(1).type.name).toBe('hard_break');
    });

    it('converts after a second soft return too', () => {
      editor('first'); softReturn(view); softReturn(view); type('**word**');
      expect(view.dom.querySelectorAll('strong')).toHaveLength(1);
      expect(source()).toBe('first\n\n**word**');
    });

    it.each(['a*b*c', 'x**word**'])('does not convert midword after a soft return: %s', (text) => {
      editor('first'); softReturn(view); type(text);
      expect(view.dom.querySelectorAll('em, strong')).toHaveLength(0);
      expect(source()).toBe(`first\n${text}`);
    });

    it('leaves emphasis that spans a line break literal rather than putting the break in as a character', () => {
      editor(''); type('*a'); softReturn(view); type('b*');
      expect(view.state.doc.toString()).not.toContain('\ufffc');
      expect(view.dom.querySelectorAll('em')).toHaveLength(0);
      expect(source()).toBe('*a\nb*');
    });
  });

  describe('a list can start on a new line after text (#3619)', () => {
    it.each([['- ', 'bullet_list'], ['* ', 'bullet_list'], ['1. ', 'ordered_list'], ['8. ', 'ordered_list']] as const)('%s after a soft return starts a list and keeps the text above as a paragraph', (marker, kind) => {
      editor('intro'); softReturn(view); type(marker); type('item');
      expect(view.state.doc.childCount).toBe(2);
      expect(view.state.doc.child(0).type.name).toBe('paragraph');
      expect(view.state.doc.child(0).textContent).toBe('intro');
      expect(view.state.doc.child(1).type.name).toBe(kind);
      expect(source()).toBe(`intro\n${marker}item`);
      expect(view.state.selection.$from.parent.textContent).toBe('item');
    });

    it('starts the list from the Space keydown too', () => {
      editor('intro'); softReturn(view); type('-');
      expect(key(' ')).toBe(true);
      expect(view.state.doc.child(1).type.name).toBe('bullet_list');
    });

    it('continues the new list with Enter and leaves it with a second Enter', () => {
      editor('intro'); softReturn(view); type('- one'); softReturn(view); type('two');
      expect(source()).toBe('intro\n- one\n- two');
      softReturn(view); softReturn(view);
      expect(source()).toBe('intro\n- one\n- two\n');
    });

    it('works after a blank line, and a second list after text and a list', () => {
      editor('intro'); softReturn(view); softReturn(view); type('- a');
      expect(source()).toBe('intro\n\n- a');
      expect(view.state.doc.child(0).textContent).toBe('intro');
      expect(view.state.doc.child(0).childCount).toBe(2);
    });

    it('is one undo event that restores the marker and the soft return', () => {
      editor('intro'); softReturn(view); type('- ');
      expect(view.state.doc.child(1).type.name).toBe('bullet_list');
      undo(view.state, view.dispatch);
      expect(view.state.doc.childCount).toBe(1);
      expect(source()).toBe('intro\n-');
      redo(view.state, view.dispatch);
      expect(view.state.doc.child(1).type.name).toBe('bullet_list');
    });

    it('Mod+Z right after the conversion gives back the literal marker', () => {
      editor('intro'); softReturn(view); type('- ');
      key('z', { metaKey: true });
      expect(view.state.doc.childCount).toBe(1);
      expect(source()).toBe('intro\n- ');
    });

    it('does not convert a marker that is not at the start of its line', () => {
      editor('intro'); softReturn(view); type('x- ');
      expect(view.state.doc.childCount).toBe(1);
      expect(source()).toBe('intro\nx- ');
    });

    it('starts a list after a soft return inside bold text', () => {
      editor('intro'); key('b', { metaKey: true }); type('bold'); softReturn(view); type('- item');
      expect(view.state.doc.child(1).type.name).toBe('bullet_list');
      expect(view.state.doc.child(1).textContent).toBe('item');
      expect(view.state.doc.child(0).textContent).toBe('introbold');
    });
    it('does not convert a marker after a hard break inside a list item', () => {
      editor('- first'); insertPlainText(view, 'a\nb'); type('- ');
      expect(view.state.doc.childCount).toBe(1);
      expect(view.dom.querySelectorAll('ul ul')).toHaveLength(0);
    });
  });

  it('indents and outdents every selected item, with semantic nesting', () => {
    editor('1. parent\n2. second\n3. third\n4. last', 13, 27);
    expect(indentItems(view, false)).toBe(true);
    expect(source()).toBe('1. parent\n   1. second\n   2. third\n2. last');
    expect(indentItems(view, true)).toBe(true);
    expect(source()).toBe('1. parent\n2. second\n3. third\n4. last');
  });

  it('leaves Tab outside a list to focus navigation', () => {
    editor('plain');
    expect(indentItems(view, false)).toBe(false);
  });

  it('Backspace outdents a first or nested item, and joins subsequent items', () => {
    editor('- parent\n  - child', 13);
    key('Backspace');
    expect(source()).toBe('- parent\n- child');
    select(11);
    key('Backspace');
    expect(source()).toBe('- parentchild');
    select(2);
    key('Backspace');
    expect(source()).toBe('parentchild');
  });

  it('Delete at the end joins the following item and renumbers', () => {
    editor('7. first\n8. second\n9. third', 8);
    key('Delete');
    expect(source()).toBe('7. firstsecond\n8. third');
  });

  it('toggles bold and italic on a cross-item selection without changing lists', () => {
    editor('- first\n- second', 2, 16);
    key('b', { metaKey: true });
    expect(source()).toBe('- **first**\n- **second**');
    key('i', { metaKey: true });
    expect(view.dom.querySelectorAll('li strong em, li em strong')).toHaveLength(2);
    key('i', { metaKey: true });
    key('b', { metaKey: true });
    expect(source()).toBe('- first\n- second');
  });

  it('pastes literal Markdown and HTML byte for byte', () => {
    editor('');
    const text = '- item\n**bold**\n<tag>hi</tag>\n# heading';
    insertPlainText(view, text);
    expect(view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')).toBe(text);
    expect(view.dom.querySelector('ul, strong, tag, h1')).toBeNull();
    expect(source()).toBe(text);
  });

  it.each(['1. pasted\n2. next', '**a*****b***', '- first\n- second'])('sends pasted %j exactly, prioritizing text over reload structure', (text) => {
    editor('');
    insertPlainText(view, text);
    expect(source()).toBe(text);
    expect(view.dom.querySelector('ul, ol, strong, em')).toBeNull();
  });

  it('retains overlapping marks and adjacent text across draft reloads', () => {
    editor('word suffix');
    select(0, 4); key('b', { metaKey: true });
    select(0, 6); key('i', { metaKey: true });
    const signature = () => {
      const values: string[] = [];
      view.state.doc.descendants((node) => { if (node.isText) values.push(`${node.text}:${node.marks.map((m) => m.type.name).sort()}`); });
      return values;
    };
    const before = signature();
    const markdown = source();
    replaceDraft(view, markdown);
    expect(signature()).toEqual(before);
    expect(source()).toBe(markdown);
  });

  it('property: random literal strings are sent byte for byte, including after an edit drops source metadata', () => {
    editor('');
    let seed = 3541;
    const alphabet = 'abc012_*`- .:/\\\n\r\t';
    for (let sample = 0; sample < 400; sample++) {
      let text = '';
      for (let i = 0; i < 80; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        text += alphabet[seed % alphabet.length];
      }
      replaceDraft(view, ''); insertPlainText(view, text);
      expect(source(), `literal sample ${sample}`).toBe(text);
      view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { source: null, literal: true }));
      expect(source(), `edited literal sample ${sample}`).toBe(text);
    }
  });

  it('lets Tab move focus when the first item cannot sink', () => {
    editor('- first');
    expect(indentItems(view, false)).toBe(false);
  });

  it('external restored drafts reset history and retain unsupported text', () => {
    editor('- draft'); softReturn(view);
    replaceDraft(view, '# restored\npath_with_underscores\n  literal  ');
    expect(source()).toBe('# restored\npath_with_underscores\n  literal  ');
    expect(undo(view.state, view.dispatch)).toBe(false);
  });

  it('does not run input rules while the browser is composing', () => {
    editor('');
    Object.defineProperty(view, 'composing', { value: true, configurable: true });
    type('**word**');
    expect(view.state.doc.textContent).toBe('**word**');
    expect(view.dom.querySelector('strong')).toBeNull();
  });
});


/** #3564: the structured-composer E2E clears the draft (select-all, Delete) and types "- " again. */
describe('clearing the whole draft', () => {
  const selectAll = () => {
    const doc = view.state.doc;
    view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(0), doc.resolve(doc.content.size))));
  };

  it.each([['- first', 'one item'], ['- first\n- second', 'two items'], ['8. first\n9. second', 'a numbered list'], ['- a\n  - b', 'a nested list'], ['text', 'plain text']])('Delete over everything in %s leaves one empty paragraph', (text) => {
    editor(text);
    selectAll();
    expect(key('Delete')).toBe(true);
    expect(view.state.doc.toString()).toBe('doc(paragraph)');
    expect(source()).toBe('');
    type('- ');
    expect(view.state.doc.firstChild?.type.name).toBe('bullet_list');
  });

  it('Backspace over everything clears it the same way', () => {
    editor('- first');
    selectAll();
    expect(key('Backspace')).toBe(true);
    expect(view.state.doc.toString()).toBe('doc(paragraph)');
  });

  /** #3589: Playwright's fill('') selects the DOM contents and presses Delete a few ms later.
   * The selectionchange that tells ProseMirror about it is async, so state can still hold the old caret. */
  describe.each(['Delete', 'Backspace'])('%s straight after a DOM select-all, before ProseMirror has seen the selection', (name) => {
    afterEach(() => { document.getSelection()?.removeAllRanges(); view.dom.parentElement?.remove(); });
    const domSelectAll = () => {
      document.body.append(view.dom.parentElement!);
      document.getSelection()!.setBaseAndExtent(view.dom, 0, view.dom, view.dom.childNodes.length);
    };

    it.each([['- first\n- second', 'a bullet list'], ['8. first\n9. second', 'a numbered list'], ['text', 'plain text']])('clears %s to one empty paragraph', (text) => {
      editor(text);
      domSelectAll();
      expect(view.state.selection.empty).toBe(true);
      expect(key(name)).toBe(true);
      expect(view.state.doc.toString()).toBe('doc(paragraph)');
      type('8. ');
      expect(view.state.doc.firstChild?.type.name).toBe('ordered_list');
    });

    it('leaves the selection alone while an IME composition is running', () => {
      editor('- first\n- second');
      domSelectAll();
      const before = view.state.selection;
      view.dom.dispatchEvent(new CompositionEvent('compositionstart'));
      expect(view.composing).toBe(true);
      key(name);
      expect(view.state.selection.eq(before)).toBe(true);
      expect(source()).toBe('- first\n- second');
    });

    it('ignores a DOM selection outside the editor', () => {
      editor('- first\n- second');
      const outside = document.createElement('p');
      outside.textContent = 'elsewhere';
      document.body.append(view.dom.parentElement!, outside);
      document.getSelection()!.setBaseAndExtent(outside, 0, outside, 1);
      const before = view.state.selection;
      key(name);
      outside.remove();
      expect(view.state.selection.eq(before)).toBe(true);
      expect(source()).toBe('- first\n- second');
    });

    it('a caret inside a list item is left to the browser, with the caret where it was', () => {
      editor('- first\n- second', 4);
      document.body.append(view.dom.parentElement!);
      const caret = view.state.selection.from;
      const at = view.domAtPos(caret);
      document.getSelection()!.setBaseAndExtent(at.node, at.offset, at.node, at.offset);
      expect(key(name)).toBe(false);
      expect(source()).toBe('- first\n- second');
      expect(view.state.selection.from).toBe(caret);
    });
  });

  describe('Backspace with the DOM selection inside the editor', () => {
    afterEach(() => { document.getSelection()?.removeAllRanges(); view.dom.parentElement?.remove(); });

    it('at the start of the first item still lifts it out of the list', () => {
      editor('- first\n- second', 2);
      document.body.append(view.dom.parentElement!);
      const at = view.domAtPos(view.state.selection.from);
      document.getSelection()!.setBaseAndExtent(at.node, at.offset, at.node, at.offset);
      expect(key('Backspace')).toBe(true);
      expect(view.state.doc.firstChild?.type.name).toBe('paragraph');
      expect(source()).toBe('first\n- second');
    });

    it('a block NodeSelection is deleted as a block, not turned into a text selection', () => {
      const run = (domCaret: boolean) => {
        editor('- first\n- second');
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1)));
        if (domCaret) {
          document.body.append(view.dom.parentElement!);
          const text = view.dom.querySelector('li')!.firstChild!.firstChild!;
          document.getSelection()!.setBaseAndExtent(text, 2, text, 2);
        }
        key('Backspace');
        return view.state.doc.toString();
      };
      const expected = run(false);
      expect(expected).not.toBe('doc(bullet_list(list_item(paragraph("first")), list_item(paragraph("second"))))');
      expect(run(true)).toBe(expected);
    });
  });

  it('clearing is one undo event that brings the list back', () => {
    editor('- first\n- second');
    selectAll();
    key('Delete');
    expect(key('z', { metaKey: true })).toBe(true);
    expect(source()).toBe('- first\n- second');
  });

  it('a partial selection still deletes only what is selected', () => {
    editor('- first\n- second', 2, 11);
    key('Delete');
    expect(view.state.doc.firstChild?.type.name).toBe('bullet_list');
    expect(source()).toBe('- econd');
  });
});

describe('the space key starts a list from keydown', () => {
  it.each([['-', 'bullet_list'], ['*', 'bullet_list'], ['8.', 'ordered_list']])('%s then Space converts without waiting for the browser to insert the space', (marker, kind) => {
    editor('');
    type(marker);
    expect(key(' ')).toBe(true);
    expect(view.state.doc.firstChild?.type.name).toBe(kind);
    expect(view.state.doc.textContent).toBe('');
    // And one Mod+Z undoes the conversion to the literal marker.
    expect(key('z', { metaKey: true })).toBe(true);
    expect(view.state.doc.textContent).toBe(`${marker} `);
  });

  it.each(['a-', 'word', '', '1 .'])('leaves Space after %j to the browser', (text) => {
    editor('');
    type(text);
    const before = view.state.doc;
    expect(key(' ')).toBe(false);
    expect(view.state.doc.eq(before)).toBe(true);
  });

  it('leaves Space alone with a modifier, over a selection, or while composing', () => {
    editor(''); type('-');
    expect(key(' ', { metaKey: true })).toBe(false);
    expect(key(' ', { ctrlKey: true })).toBe(false);
    select(0, 1);
    expect(key(' ')).toBe(false);
    select(1);
    Object.defineProperty(view, 'composing', { value: true, configurable: true });
    expect(key(' ')).toBe(false);
    expect(view.state.doc.firstChild?.type.name).toBe('paragraph');
  });
});


it('does not add indentation to multiline paste in a list after typing or reload', () => {
  editor('- item');
  insertPlainText(view, ' a\nb\n- c');
  expect(source()).toBe('- item a\nb\n- c');
  type('x');
  const sent = '- item a\nb\n- cx';
  expect(source()).toBe(sent);
  replaceDraft(view, sent);
  expect(source()).toBe(sent);
  select(sent.length); type('y');
  expect(source()).toBe(sent + 'y');
});

/** #3564: prosemirror-history merges steps within newGroupDelay (500 ms), so one
 * Mod+Z after a list operation must not depend on how fast the keys arrived. */
describe.each([['fast', 0], ['slow', 2000]] as const)('list operations are their own undo event (%s)', (_speed, gap) => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 }); });
  afterEach(() => { vi.useRealTimers(); });
  const wait = () => { vi.advanceTimersByTime(gap); };
  const mod = () => key('z', { metaKey: true });
  /** Types one character, as its own tick, with the gap before it. */
  const typeAfterGap = (text: string) => { wait(); type(text); };
  const listItems = () => view.dom.querySelectorAll('ul > li, ol > li').length;

  it('exit, then undo, restores exactly the empty item', () => {
    editor('');
    typeAfterGap('- ');
    wait(); softReturn(view);
    expect(listItems()).toBe(0);
    wait(); expect(mod()).toBe(true);
    expect(listItems()).toBe(1);
    expect(source()).toBe('- ');
  });

  it('exit after typed text does not take the typing with it', () => {
    editor('- first\n- ');
    wait(); softReturn(view);
    expect(source()).toBe('- first\n');
    wait(); mod();
    expect(source()).toBe('- first\n- ');
  });

  it('split, then undo, restores the unsplit item and keeps the text typed before it', () => {
    editor('');
    typeAfterGap('- ');
    typeAfterGap('ab');
    wait(); select(3); softReturn(view);
    expect(source()).toBe('- a\n- b');
    wait(); mod();
    expect(source()).toBe('- ab');
  });

  it('typing after a split is a separate event from the split', () => {
    editor('- ab', 3);
    softReturn(view);
    typeAfterGap('c');
    expect(source()).toBe('- a\n- cb');
    mod();
    expect(source()).toBe('- a\n- b');
    mod();
    expect(source()).toBe('- ab');
  });

  it('conversion, then undo, reverts only the conversion, never the typing before it', () => {
    editor('');
    type('-');
    wait(); type(' ');
    expect(listItems()).toBe(1);
    wait(); undo(view.state, view.dispatch);
    expect(view.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(view.state.doc.textContent).toBe('-');
  });

  it('typing right after a conversion is a separate event from the conversion', () => {
    editor('');
    type('- ');
    typeAfterGap('x');
    expect(source()).toBe('- x');
    undo(view.state, view.dispatch);
    expect(source()).toBe('- ');
    expect(listItems()).toBe(1);
    undo(view.state, view.dispatch);
    expect(listItems()).toBe(0);
  });

  it('an ordered conversion is its own event too', () => {
    editor('');
    type('3');
    typeAfterGap('.'); typeAfterGap(' ');
    expect(view.state.doc.firstChild?.attrs.order).toBe(3);
    wait(); undo(view.state, view.dispatch);
    expect(view.state.doc.textContent).toBe('3.');
  });

  it('indent, then undo, reverts only the indent', () => {
    editor('- parent\n- child', 14);
    wait(); expect(indentItems(view, false)).toBe(true);
    expect(source()).toBe('- parent\n  - child');
    wait(); mod();
    expect(source()).toBe('- parent\n- child');
  });

  it('outdent, then undo, reverts only the outdent, and typing after it stays separate', () => {
    editor('- parent\n  - child', 16);
    wait(); expect(indentItems(view, true)).toBe(true);
    expect(source()).toBe('- parent\n- child');
    typeAfterGap('!');
    mod();
    expect(source()).toBe('- parent\n- child');
    mod();
    expect(source()).toBe('- parent\n  - child');
  });

  it('Backspace at the start of the first item exits it as its own event', () => {
    editor('- ', 2);
    typeAfterGap('x'); select(2);
    wait(); key('Backspace');
    expect(listItems()).toBe(0);
    wait(); mod();
    expect(source()).toBe('- x');
  });
});
