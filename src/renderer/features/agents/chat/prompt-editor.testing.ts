import { act } from '@testing-library/react';
import { TextSelection } from 'prosemirror-state';
import { promptView, setPromptText } from './PromptEditor';
import { serializePrompt, sourcePosition } from './prompt-codec';

export function typePrompt(element: HTMLElement, text: string, caret = text.length) {
  act(() => setPromptText(element, text, caret));
}
export const promptSource = (element: HTMLElement) => serializePrompt(promptView(element).state.doc).text;
export function promptSelection(element: HTMLElement): [number, number] {
  const view = promptView(element);
  const source = serializePrompt(view.state.doc);
  return [source.positions[view.state.selection.from], source.positions[view.state.selection.to]];
}
export function selectPrompt(element: HTMLElement, from: number, to = from) {
  const view = promptView(element);
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,
    sourcePosition(view.state.doc, from), sourcePosition(view.state.doc, to)))));
}

// Pasted text is stored literally. A remount or a failed-send restore parses
// the stored draft again, which must not rewrite it.
export const pastedDrafts = [
  '  * build\n  * test',
  '1. a\n1. b',
  '3. a\n5. b',
  '- a\n* b',
  '- first\n  continuation',
  '- step\n  ```sh\n  npm test\n  ```',
];
