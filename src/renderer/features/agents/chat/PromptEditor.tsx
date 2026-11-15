import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { parsePrompt, serializePrompt, sourcePosition } from './prompt-codec';
import { createPromptState, insertPlainText, replaceDraft } from './prompt-editor';

export interface PromptToken { start: number; end: number; query: string }

export interface PromptEditorHandle {
  view: EditorView | null;
  focus: () => void;
  replace: (from: number, to: number, text: string) => void;
}
interface Props {
  text: string;
  onChange: (text: string) => void;
  onSelection: (text: string, at: number, token: PromptToken | null) => void;
  onKeyDown: (view: EditorView, event: KeyboardEvent) => boolean;
  onPasteFiles: (event: ClipboardEvent) => boolean;
  disabled?: boolean;
  placeholder: string;
  description: string;
  line: boolean;
}

// Test helpers exercise real model transactions instead of imitating textarea
// change events (jsdom does not implement contenteditable's native editing).
const views = new WeakMap<HTMLElement, EditorView>();
export const promptView = (element: HTMLElement): EditorView => {
  const view = views.get(element);
  if (!view) throw new Error('Not a mounted prompt editor');
  return view;
};

export const PromptEditor = forwardRef<PromptEditorHandle, Props>(function PromptEditor(props, ref) {
  const mount = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const echoed = useRef(props.text);

  useImperativeHandle(ref, () => ({
    get view() { return viewRef.current; },
    focus: () => viewRef.current?.focus(),
    replace(from, to, text) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,
        sourcePosition(view.state.doc, from), sourcePosition(view.state.doc, to))));
      insertPlainText(view, text);
      view.focus();
    },
  }), []);

  useLayoutEffect(() => {
    const view = new EditorView(mount.current!, {
      state: createPromptState(latest.current.text),
      editable: () => !latest.current.disabled,
      attributes: () => ({
        role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Message',
        'aria-description': latest.current.description, title: latest.current.description,
        'aria-disabled': String(!!latest.current.disabled), 'aria-readonly': String(!!latest.current.disabled),
        'data-placeholder': latest.current.placeholder,
        'data-empty': String(!viewRef.current?.state.doc.textContent && viewRef.current?.state.doc.childCount === 1),
        class: `relative outline-none min-w-0 text-[13px] text-ctp-text whitespace-pre-wrap break-words overflow-y-auto [&_p]:m-0 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:pl-0 [&_li>p]:inline [&_strong]:font-bold [&_em]:italic ${latest.current.line ? 'px-1.5 py-1.5 max-h-[72px]' : 'px-3.5 pt-3 pb-1.5 min-h-[44px] max-h-[200px]'} data-[empty=true]:before:content-[attr(data-placeholder)] data-[empty=true]:before:absolute data-[empty=true]:before:pointer-events-none data-[empty=true]:before:text-ctp-overlay0`,
      }),
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        const source = serializePrompt(view.state.doc);
        if (tr.docChanged) {
          echoed.current = source.text;
          latest.current.onChange(source.text);
        }
        if (tr.docChanged || tr.selectionSet) {
          const { $head } = view.state.selection;
          const before = $head.parent.textBetween(0, $head.parentOffset, '', '\n');
          const match = /(^|\s)\/([^\s/]*)$/.exec(before);
          let token: PromptToken | null = null;
          if (match) {
            const after = $head.parent.textBetween($head.parentOffset, $head.parent.content.size, '', '\n');
            const rest = /^[^\s]*/.exec(after)![0];
            if (!rest.includes('/')) token = {
              start: source.positions[$head.start() + match.index + match[1].length],
              end: source.positions[$head.pos + rest.length], query: match[2],
            };
          }
          latest.current.onSelection(source.text, source.positions[$head.pos], token);
        }
      },
      handleDOMEvents: {
        // Returning true here leaves the native IME event alone and stops all
        // editor keymaps, including the last 229 event after composition ends.
        keydown: (editor, event) => editor.composing || event.isComposing || event.keyCode === 229,
        paste: (_editor, event) => latest.current.onPasteFiles(event),
      },
      handleKeyDown: (editor, event) => latest.current.onKeyDown(editor, event),
      handlePaste(editor, event) {
        if (latest.current.disabled) return true;
        let text = event.clipboardData?.getData('text/plain');
        if (text === undefined) return false;
        if (!text) {
          // A detached template is inert, and only its text leaves this branch.
          const html = event.clipboardData?.getData('text/html');
          if (html) { const template = document.createElement('template'); template.innerHTML = html; text = template.content.textContent ?? ''; }
        }
        insertPlainText(editor, text);
        return true;
      },
      // Dropped external text/HTML is also limited to literal plain text.
      handleDrop(editor, event, _slice, moved) {
        if (moved) return false;
        const text = event.dataTransfer?.getData('text/plain');
        if (!text) return false;
        insertPlainText(editor, text);
        return true;
      },
    });
    viewRef.current = view;
    views.set(view.dom, view);
    view.updateState(view.state); // attributes can now inspect the initialized view
    return () => { views.delete(view.dom); view.destroy(); viewRef.current = null; };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (props.text !== echoed.current) {
      echoed.current = props.text;
      replaceDraft(view, props.text);
    }
    view.setProps({ editable: () => !latest.current.disabled });
  }, [props.text, props.disabled, props.description, props.placeholder, props.line]);

  return <div ref={mount} className={props.line ? 'relative flex-1 min-w-0' : 'relative min-w-0'} />;
});

/** Model-backed input helper used by component tests and no browser globals. */
export function setPromptText(element: HTMLElement, text: string, caret = text.length) {
  const view = promptView(element);
  const doc = parsePrompt(text);
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, sourcePosition(tr.doc, caret))));
}
