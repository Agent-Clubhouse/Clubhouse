import { InputRule, inputRules, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { history, closeHistory, undo, redo } from 'prosemirror-history';
import { baseKeymap, chainCommands, deleteSelection, joinBackward, joinForward, selectNodeBackward, selectNodeForward, toggleMark } from 'prosemirror-commands';
import { sinkListItem, liftListItem, splitListItem } from 'prosemirror-schema-list';
import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { keymap } from 'prosemirror-keymap';
import { type EditorView } from 'prosemirror-view';
import { parsePrompt, promptSchema } from './prompt-codec';

export function promptRules() {
  const { bullet_list, ordered_list } = promptSchema.nodes;
  const emphasisRule = (strong: boolean) => new InputRule(
    strong ? /(^|[\s([{])\*\*([^\s*](?:[^*]*?[^\s*])?)\*\*$/ : /(^|[\s([{])\*([^\s*](?:[^*]*?[^\s*])?)\*$/,
    (state, match, start, end) => {
      start += match[1].length;
      const mark = strong ? promptSchema.marks.strong : promptSchema.marks.em;
      return closeHistory(state.tr.insertText(match[2], start, end).addMark(start, start + match[2].length, mark.create()).setStoredMarks([]));
    },
  );
  return inputRules({ rules: [
    wrappingInputRule(/^([-*]) $/, bullet_list, (m) => ({ bullet: m[1] })),
    wrappingInputRule(/^(\d+)\. $/, ordered_list, (m) => ({ order: +m[1] }), (m, node) => node.attrs.order + node.childCount === +m[1]),
    emphasisRule(true), emphasisRule(false),
  ] });
}

export function createPromptState(text: string) {
  return EditorState.create({
    schema: promptSchema, doc: parsePrompt(text),
    plugins: [promptRules(), history(), keymap(Object.fromEntries(Object.entries(baseKeymap).filter(([key]) => key !== 'Enter')))],
  });
}

export function inList(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type === promptSchema.nodes.list_item) return true;
  return false;
}

const action = (view: EditorView, command: Command) => command(view.state, (tr) => view.dispatch(closeHistory(tr)), view);

export function softReturn(view: EditorView): boolean {
  if (inList(view.state)) {
    if (!view.state.selection.$from.parent.content.size) return action(view, liftListItem(promptSchema.nodes.list_item));
    return action(view, splitListItem(promptSchema.nodes.list_item));
  }
  const tr = view.state.tr.replaceSelectionWith(promptSchema.nodes.hard_break.create()).scrollIntoView();
  view.dispatch(closeHistory(tr));
  return true;
}

export function indentItems(view: EditorView, outdent: boolean): boolean {
  if (!inList(view.state)) return false;
  action(view, (outdent ? liftListItem : sinkListItem)(promptSchema.nodes.list_item));
  return true;
}

/** schema-list joins item containers first. Merge adjacent paragraph bodies in
 * that same transaction so Delete/Backspace behave like one textual join. */
function joinItems(command: Command): Command {
  return (state, dispatch, view) => command(state, dispatch && ((tr) => {
    const cursor = tr.selection.$from;
    let joinAt: number | null = null;
    if (tr.docChanged && cursor.parent.isTextblock && cursor.depth > 1 && cursor.node(cursor.depth - 1).type === promptSchema.nodes.list_item) {
      if (!cursor.parentOffset) joinAt = cursor.pos;
      else if (cursor.parentOffset === cursor.parent.content.size) {
        const after = cursor.after();
        if (tr.doc.nodeAt(after)?.type === promptSchema.nodes.paragraph) joinAt = after + 1;
      }
    }
    if (joinAt !== null) {
      tr.setSelection(TextSelection.create(tr.doc, joinAt));
      const next = state.apply(tr);
      joinBackward(next, (joined) => {
        for (const step of joined.steps) tr.step(step);
        tr.setSelection(TextSelection.create(tr.doc, joined.selection.from, joined.selection.to));
      });
    }
    dispatch(tr);
  }), view);
}

/** All IME/229 guards run before this; the host handles send/slash first. */
export function editingKey(view: EditorView, e: KeyboardEvent, mac: boolean): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (mod && !e.altKey) {
    if (!e.shiftKey && /^(b|i)$/i.test(e.key)) {
      return action(view, toggleMark(e.key.toLowerCase() === 'b' ? promptSchema.marks.strong : promptSchema.marks.em));
    }
    if (e.key.toLowerCase() === 'z') {
      return e.shiftKey ? redo(view.state, view.dispatch) : chainCommands(undoInputRule, undo)(view.state, view.dispatch, view);
    }
    if (!mac && e.key.toLowerCase() === 'y' && !e.shiftKey) return redo(view.state, view.dispatch);
  }
  if (e.key === 'Backspace' && !e.metaKey && !e.altKey && !e.ctrlKey) {
    const { $from, empty } = view.state.selection;
    if (empty && !$from.parentOffset && inList(view.state)) {
      const nested = $from.depth > 3;
      if (nested || $from.index($from.depth - 2) === 0) return action(view, liftListItem(promptSchema.nodes.list_item));
    }
    return action(view, chainCommands(deleteSelection, joinItems(joinBackward), selectNodeBackward));
  }
  if (e.key === 'Delete' && !e.metaKey && !e.altKey && !e.ctrlKey) return action(view, chainCommands(deleteSelection, joinItems(joinForward), selectNodeForward));
  return false;
}

export function selectSource(view: EditorView, from: number, to = from): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)).setMeta('addToHistory', false));
}

/** Each external draft gets a fresh history; echoes of local transactions never do. */
export function replaceDraft(view: EditorView, text: string): void {
  view.updateState(createPromptState(text));
}

export function insertPlainText(view: EditorView, text: string): void {
  // A hard break for each LF, never parse pasted Markdown/HTML into nodes.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const content = lines.flatMap((line, i) => [
    ...(i ? [promptSchema.nodes.hard_break.create()] : []),
    ...(line ? [promptSchema.text(line)] : []),
  ]);
  let tr: Transaction = view.state.tr.deleteSelection();
  let at = tr.selection.from;
  for (const node of content) { tr = tr.insert(at, node); at += node.nodeSize; }
  tr.setSelection(TextSelection.create(tr.doc, at));
  view.dispatch(closeHistory(tr).scrollIntoView());
}
