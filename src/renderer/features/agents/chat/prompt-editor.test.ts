import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
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

  it('indents and outdents every selected item, with semantic nesting', () => {
    editor('1. parent\n2. second\n3. third\n4. last', 13, 27);
    expect(indentItems(view, false)).toBe(true);
    expect(source()).toBe('1. parent\n  1. second\n  2. third\n2. last');
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

  it('pastes literal Markdown and HTML as plain text, with a stable draft reload', () => {
    editor('');
    const text = '- item\n**bold**\n<tag>hi</tag>\n# heading';
    insertPlainText(view, text);
    expect(view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')).toBe(text);
    expect(view.dom.querySelector('ul, strong, tag, h1')).toBeNull();
    const markdown = source();
    replaceDraft(view, markdown);
    expect(view.dom.querySelector('ul, strong, tag, h1')).toBeNull();
    expect(source()).toBe(markdown);
    expect(view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')).toBe(text);
  });

  it.each(['1. pasted\n2. next', '**a*****b***', '- first\n- second'])('keeps pasted %j literal after a draft reload', (text) => {
    editor('');
    insertPlainText(view, text);
    const markdown = source();
    replaceDraft(view, markdown);
    expect(view.dom.querySelector('ul, ol, strong, em')).toBeNull();
    expect(view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')).toBe(text);
    expect(source()).toBe(markdown);
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
