/** Source-only composer edits. No DOM, draft storage or hidden formatting state. */
export interface Selection { start: number; end: number }
export interface TextEdit { text: string; selection: Selection }
const result = (text: string, start: number, end = start): TextEdit => ({ text, selection: { start, end } });

export function toggleEmphasis(text: string, { start, end }: Selection, marker: '*' | '**'): TextEdit {
  const n = marker.length;
  const selected = text.slice(start, end);
  if (start >= n && text.slice(start - n, start) === marker && text.slice(end, end + n) === marker) {
    return result(text.slice(0, start - n) + selected + text.slice(end + n), start - n, end - n);
  }
  if (selected.length >= n * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    return result(text.slice(0, start) + selected.slice(n, -n) + text.slice(end), start, end - n * 2);
  }
  return result(text.slice(0, start) + marker + selected + marker + text.slice(end), start + n, end + n);
}

export const listItem = (line: string) => /^( *)([-*]|\d+\.) (.*)$/.exec(line);

/** Renumber following siblings, skipping children; a blank/non-list line ends the list. */
function renumber(text: string, from: number, indent: number, number: number): string {
  const before = text.slice(0, from);
  const lines = text.slice(from).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const item = listItem(lines[i]);
    if (!item || item[1].length < indent) break;
    if (item[1].length > indent) continue;
    if (!item[2].endsWith('.')) break;
    lines[i] = `${item[1]}${number++}. ${item[3]}`;
  }
  return before + lines.join('\n');
}

export function continueList(text: string, { start, end }: Selection): TextEdit | null {
  if (start !== end) return null;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', start);
  if (start !== (lineEnd === -1 ? text.length : lineEnd)) return null;
  const item = listItem(text.slice(lineStart, start));
  if (!item) return null;
  const numbered = item[2].endsWith('.');
  const number = numbered ? Number.parseInt(item[2], 10) : 0;
  if (!item[3].trim()) {
    let next = text.slice(0, lineStart) + text.slice(start);
    if (numbered && lineEnd !== -1) next = renumber(next, lineStart + 1, item[1].length, number);
    return result(next, lineStart);
  }
  const prefix = `\n${item[1]}${numbered ? `${number + 1}.` : item[2]} `;
  let next = text.slice(0, start) + prefix + text.slice(end);
  if (numbered && lineEnd !== -1) next = renumber(next, start + prefix.length + 1, item[1].length, number + 2);
  return result(next, start + prefix.length);
}

export function indentList(text: string, selection: Selection, outdent = false): TextEdit | null {
  const lineStart = text.lastIndexOf('\n', selection.start - 1) + 1;
  const lineEnd = text.indexOf('\n', lineStart);
  const item = listItem(text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd));
  if (!item || (lineEnd !== -1 && selection.end > lineEnd)) return null;
  const removed = outdent ? Math.min(2, item[1].length) : 0;
  const inserted = outdent ? '' : '  ';
  const shift = inserted.length - removed;
  return result(text.slice(0, lineStart) + inserted + text.slice(lineStart + removed),
    Math.max(lineStart, selection.start + shift), Math.max(lineStart, selection.end + shift));
}
