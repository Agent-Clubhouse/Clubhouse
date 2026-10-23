/** A 1-based place in a file: a line, and optionally a column on it. */
export interface EditorLocation {
  line: number;
  column?: number;
}

/** The parts of a Monaco editor `revealLocation` uses. */
interface RevealableEditor {
  getModel(): { getLineCount(): number; getLineMaxColumn(line: number): number } | null;
  setSelection(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): void;
  setPosition(position: { lineNumber: number; column: number }): void;
  revealLineInCenter(line: number): void;
  revealPositionInCenter(position: { lineNumber: number; column: number }): void;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(n) || min, min), max);
}

/**
 * Scroll `loc` into the middle of the editor: with a column, the cursor goes
 * there; without one, the whole line is selected. A place past the end goes
 * to the last line, and a column past the line's end to its end.
 */
export function revealLocation(editor: RevealableEditor, loc: EditorLocation): void {
  const model = editor.getModel();
  if (!model) return;
  const lineNumber = clamp(loc.line, 1, model.getLineCount());
  const maxColumn = model.getLineMaxColumn(lineNumber);
  if (loc.column !== undefined) {
    const position = { lineNumber, column: clamp(loc.column, 1, maxColumn) };
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    return;
  }
  editor.setSelection({ startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: maxColumn });
  editor.revealLineInCenter(lineNumber);
}
