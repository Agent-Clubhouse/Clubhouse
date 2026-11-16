import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { undo } from 'prosemirror-history';
import { PromptEditor, promptView } from './PromptEditor';
import { softReturn } from './prompt-editor';
import { serializePrompt } from './prompt-codec';

/** #3564: the owner hands text back through props after the editor reported it,
 * and React can run those effects after the next keystroke. */
function mount(text = '') {
  const onChange = vi.fn();
  const props = (value: string) => ({
    text: value, onChange, onSelection: vi.fn(), onKeyDown: () => false, onPasteFiles: () => false,
    placeholder: '', description: '', line: false,
  });
  const view = render(<PromptEditor {...props(text)} />);
  const editor = view.container.querySelector<HTMLElement>('[role="textbox"]')!;
  return {
    editor, onChange, rerenderWith: (value: string) => view.rerender(<PromptEditor {...props(value)} />),
    source: () => serializePrompt(promptView(editor).state.doc).text,
  };
}

describe('PromptEditor draft sync', () => {
  it('exit, then undo, still finds the list when the owner hands each draft back late', () => {
    const { editor, rerenderWith, onChange, source } = mount('');
    const view = promptView(editor);
    // Convert, exit, and undo all happen before React hands any prop back.
    act(() => { view.dispatch(view.state.tr.insertText('-')); });
    const at = view.state.selection.from;
    act(() => { view.someProp('handleTextInput', (fn) => fn(view, at, at, ' ', () => view.state.tr.insertText(' '))); });
    expect(view.dom.querySelectorAll('ul > li')).toHaveLength(1);
    act(() => { softReturn(view); });
    expect(view.dom.querySelectorAll('ul')).toHaveLength(0);
    act(() => { undo(view.state, view.dispatch); });
    expect(view.dom.querySelectorAll('ul > li')).toHaveLength(1);
    const echoes = onChange.mock.calls.map(([text]) => text as string);
    expect(echoes.length).toBeGreaterThan(2);
    for (const text of echoes) act(() => rerenderWith(text));
    expect(source()).toBe('- ');
    expect(view.dom.querySelectorAll('ul > li')).toHaveLength(1);
    // The history survived: the exit can be undone and redone from here.
    expect(undo(view.state, view.dispatch)).toBe(true);
  });

  it('still replaces the draft when the owner sets text the editor never reported', () => {
    const { editor, rerenderWith, source } = mount('draft');
    const view = promptView(editor);
    act(() => { view.dispatch(view.state.tr.insertText('!')); });
    act(() => rerenderWith('restored'));
    expect(source()).toBe('restored');
    expect(undo(view.state, view.dispatch)).toBe(false);
  });
});
