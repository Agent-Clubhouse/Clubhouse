import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { undo } from 'prosemirror-history';
import { ECHO_WINDOW_MS, PromptEditor, promptView } from './PromptEditor';
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

  describe('echoes that never came back', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 }); });
    afterEach(() => { vi.useRealTimers(); });
    const type = (view: ReturnType<typeof promptView>, text: string) => act(() => { view.dispatch(view.state.tr.insertText(text)); });

    it('a text that came and went in one batch cannot swallow a later external clear', () => {
      const { editor, rerenderWith, source } = mount('');
      const view = promptView(editor);
      type(view, 'h');
      act(() => { view.dispatch(view.state.tr.delete(1, 2)); });
      // Both renders coalesced away: the owner still has '' and never saw 'h'.
      vi.advanceTimersByTime(ECHO_WINDOW_MS + 500);
      type(view, 'h');
      act(() => rerenderWith('h'));
      // Sending clears the draft from outside.
      act(() => rerenderWith(''));
      expect(source()).toBe('');
    });

    it('a text typed and deleted in one batch cannot swallow a later external edit', () => {
      const { editor, rerenderWith, source } = mount('a');
      const view = promptView(editor);
      view.focus();
      act(() => { view.dispatch(view.state.tr.insertText('b', view.state.doc.content.size - 1)); });
      act(() => { view.dispatch(view.state.tr.delete(view.state.doc.content.size - 2, view.state.doc.content.size - 1)); });
      expect(source()).toBe('a');
      vi.advanceTimersByTime(ECHO_WINDOW_MS + 500);
      act(() => rerenderWith('ab'));
      expect(source()).toBe('ab');
    });

    it('an echo inside the window is still recognised as late', () => {
      const { editor, rerenderWith, source } = mount('');
      const view = promptView(editor);
      type(view, 'a');
      vi.advanceTimersByTime(ECHO_WINDOW_MS - 500);
      type(view, 'b');
      act(() => rerenderWith('a'));
      expect(source()).toBe('ab');
      act(() => rerenderWith('ab'));
      expect(source()).toBe('ab');
    });
  });
});
