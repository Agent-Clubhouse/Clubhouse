import { describe, it, expect, vi } from 'vitest';
import { revealLocation } from './reveal-location';

/** A fake editor over `lines`: just what revealLocation uses. */
function fakeEditor(lines: string[]) {
  return {
    getModel: () => ({ getLineCount: () => lines.length, getLineMaxColumn: (n: number) => lines[n - 1].length + 1 }),
    setSelection: vi.fn(),
    setPosition: vi.fn(),
    revealLineInCenter: vi.fn(),
    revealPositionInCenter: vi.fn(),
  };
}

describe('revealLocation', () => {
  it('selects the whole line when there is no column', () => {
    const editor = fakeEditor(['a', 'hello', 'c']);
    revealLocation(editor, { line: 2 });
    expect(editor.setSelection).toHaveBeenCalledWith({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6 });
    expect(editor.revealLineInCenter).toHaveBeenCalledWith(2);
    expect(editor.setPosition).not.toHaveBeenCalled();
  });

  it('puts the cursor at the column', () => {
    const editor = fakeEditor(['a', 'hello', 'c']);
    revealLocation(editor, { line: 2, column: 3 });
    expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 3 });
    expect(editor.revealPositionInCenter).toHaveBeenCalledWith({ lineNumber: 2, column: 3 });
  });

  it('stops at the last line and the end of the line', () => {
    const editor = fakeEditor(['a', 'hello', 'c']);
    revealLocation(editor, { line: 99 });
    expect(editor.revealLineInCenter).toHaveBeenCalledWith(3);
    revealLocation(editor, { line: 2, column: 80 });
    expect(editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 2, column: 6 });
    revealLocation(editor, { line: 0, column: 0 });
    expect(editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 1, column: 1 });
  });

  it('does nothing without a model', () => {
    const editor = { ...fakeEditor([]), getModel: () => null };
    revealLocation(editor, { line: 2 });
    expect(editor.revealLineInCenter).not.toHaveBeenCalled();
  });
});
