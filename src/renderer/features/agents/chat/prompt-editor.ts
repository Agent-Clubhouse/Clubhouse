import { InputRule, inputRules, undoInputRule } from 'prosemirror-inputrules';
import { history, closeHistory, undo, redo } from 'prosemirror-history';
import { baseKeymap, chainCommands, deleteSelection, joinBackward, joinForward, selectNodeBackward, selectNodeForward, toggleMark } from 'prosemirror-commands';
import { sinkListItem, liftListItem, splitListItem } from 'prosemirror-schema-list';
import { EditorState, Plugin, Selection, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { canJoin, findWrapping } from 'prosemirror-transform';
import { type Node as ProseNode, type NodeType } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import { type EditorView } from 'prosemirror-view';
import { parsePrompt, promptSchema } from './prompt-codec';

const boundaryMeta = 'promptHistoryBoundary';

/** Marks a list operation as its own undo event. prosemirror-history groups
 * steps that land within newGroupDelay of each other, so without this one
 * Mod+Z after a fast "- " + exit would also undo the typing around it, and a
 * slow one would not. closeHistory starts a new event at this transaction; the
 * boundary plugin below closes it again so later typing cannot join it. */
function boundary(tr: Transaction): Transaction {
  return closeHistory(tr).setMeta(boundaryMeta, true);
}

const historyBoundaries = new Plugin({
  appendTransaction: (trs, _old, state) => trs.some((tr) => tr.getMeta(boundaryMeta)) ? closeHistory(state.tr) : null,
});

/** prosemirror-inputrules' wrappingInputRule, with the conversion as its own history event. */
function listRule(match: RegExp, type: NodeType, getAttrs: (m: RegExpMatchArray) => Record<string, unknown>,
  joinPredicate?: (m: RegExpMatchArray, before: ProseNode) => boolean) {
  return new InputRule(match, (state, m, start, end) => {
    const tr = state.tr.delete(start, end);
    const range = tr.doc.resolve(start).blockRange();
    const wrapping = range && findWrapping(range, type, getAttrs(m));
    if (!range || !wrapping) return null;
    tr.wrap(range, wrapping);
    const before = tr.doc.resolve(start - 1).nodeBefore;
    if (before && before.type === type && canJoin(tr.doc, start - 1) && (!joinPredicate || joinPredicate(m, before))) tr.join(start - 1);
    return boundary(tr);
  });
}

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
    listRule(/^([-*]) $/, bullet_list, (m) => ({ bullet: m[1] })),
    listRule(/^(\d+)\. $/, ordered_list, (m) => ({ order: +m[1] }), (m, node) => node.attrs.order + node.childCount === +m[1]),
    emphasisRule(true), emphasisRule(false),
  ] });
}

export function createPromptState(text: string) {
  return EditorState.create({
    schema: promptSchema, doc: parsePrompt(text),
    plugins: [promptRules(), historyBoundaries, history(), keymap(Object.fromEntries(Object.entries(baseKeymap).filter(([key]) => key !== 'Enter')))],
  });
}

export function inList(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type === promptSchema.nodes.list_item) return true;
  return false;
}

const action = (view: EditorView, command: Command) => command(view.state, (tr) => view.dispatch(closeHistory(tr)), view);
const listAction = (view: EditorView, command: Command) => command(view.state, (tr) => view.dispatch(boundary(tr)), view);

export function softReturn(view: EditorView): boolean {
  if (inList(view.state)) {
    if (!view.state.selection.$from.parent.content.size) return listAction(view, liftListItem(promptSchema.nodes.list_item));
    return listAction(view, splitListItem(promptSchema.nodes.list_item));
  }
  const tr = view.state.tr.replaceSelectionWith(promptSchema.nodes.hard_break.create()).scrollIntoView();
  const parent = tr.selection.$from;
  tr.setNodeMarkup(parent.before(), undefined, { ...parent.parent.attrs, source: null, literal: true });
  view.dispatch(closeHistory(tr));
  return true;
}

export function indentItems(view: EditorView, outdent: boolean): boolean {
  if (!inList(view.state)) return false;
  return listAction(view, (outdent ? liftListItem : sinkListItem)(promptSchema.nodes.list_item));
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

/** A selection that spans the whole draft leaves an empty list item behind when
 * it is deleted inside a list (select-all, Delete in a one-item list gives "- "),
 * which neither shows the placeholder nor lets "- " start a list. Clearing the
 * whole draft always means one empty paragraph. */
export const clearDraft: Command = (state, dispatch) => {
  const { selection, doc } = state;
  if (selection.empty || selection.from > Selection.atStart(doc).from || selection.to < Selection.atEnd(doc).to) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith(0, doc.content.size, promptSchema.nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.atStart(tr.doc)));
  }
  return true;
};

/** ProseMirror learns the DOM selection from an async selectionchange, so a key
 * that arrives right after a programmatic select-all (Playwright's fill(''), an
 * assistive tool) still sees the old caret in state. clearDraft then declines and
 * the browser deletes natively, leaving an empty list item (#3589). Read the live
 * DOM selection into state before a deletion decides what it covers. */
function syncDomSelection(view: EditorView): void {
  if (view.composing) return;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = (view.root as Document).getSelection() ?? {};
  if (!anchorNode || !focusNode || !view.dom.contains(anchorNode) || !view.dom.contains(focusNode)) return;
  const { doc } = view.state;
  let selection: Selection;
  try {
    selection = TextSelection.between(doc.resolve(view.posAtDOM(anchorNode, anchorOffset!)), doc.resolve(view.posAtDOM(focusNode, focusOffset!)));
  } catch {
    // telemetry-exempt: a DOM position the model cannot map just means there is nothing to sync.
    return;
  }
  if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false));
}

/** The list markers are input rules, which prosemirror-view runs from its DOM
 * diff after the browser has already inserted the space. Run them from the
 * keydown instead, so "- " converts without depending on that diff matching. */
function spaceStartsList(view: EditorView, e: KeyboardEvent): boolean {
  if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey || !view.state.selection.empty) return false;
  const { from, to } = view.state.selection;
  return !!view.someProp('handleTextInput', (rules) => rules(view, from, to, ' ', () => view.state.tr.insertText(' ', from, to)));
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
  const deleting = (e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.altKey && !e.ctrlKey;
  if (deleting) syncDomSelection(view);
  if (e.key === 'Backspace' && deleting) {
    const { $from, empty } = view.state.selection;
    if (empty && !$from.parentOffset && inList(view.state)) {
      const nested = $from.depth > 3;
      if (nested || $from.index($from.depth - 2) === 0) return listAction(view, liftListItem(promptSchema.nodes.list_item));
    }
    return action(view, chainCommands(clearDraft, deleteSelection, joinItems(joinBackward), selectNodeBackward));
  }
  if (e.key === 'Delete' && !e.metaKey && !e.altKey && !e.ctrlKey) return action(view, chainCommands(clearDraft, deleteSelection, joinItems(joinForward), selectNodeForward));
  if (spaceStartsList(view, e)) return true;
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
  const lines = text.split('\n');
  const content = lines.flatMap((line, i) => [
    ...(i ? [promptSchema.nodes.hard_break.create()] : []),
    ...(line ? [promptSchema.text(line)] : []),
  ]);
  let tr: Transaction = view.state.tr.deleteSelection();
  let at = tr.selection.from;
  for (const node of content) { tr = tr.insert(at, node); at += node.nodeSize; }
  tr.setSelection(TextSelection.create(tr.doc, at));
  const affected: { pos: number; node: typeof tr.doc }[] = [];
  tr.doc.descendants((node, pos) => {
    if (node.isTextblock && pos <= at && pos + node.nodeSize >= tr.mapping.map(view.state.selection.from)) affected.push({ pos, node });
  });
  for (const { pos, node } of affected) {
    const unformatted = !Array.from({ length: node.childCount }, (_, i) => node.child(i)).some((child) => child.marks.length);
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, literal: true,
      source: unformatted ? node.textBetween(0, node.content.size, '\n', '\n') : null });
  }
  view.dispatch(closeHistory(tr).scrollIntoView());
}
