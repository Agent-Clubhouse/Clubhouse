/**
 * A line diff: lines only in one text, only in the other, and shared. Used
 * by the stale part edit dialog (#2897) and by Switch to plain (#2927) to
 * find what was added to a file since Clubhouse wrote it.
 */
export interface DiffLine {
  kind: 'same' | 'theirs' | 'yours';
  text: string;
}

/** Past this many line pairs, the diff shows their lines then yours rather than matching them up. */
const MAX_CELLS = 2_000_000;

/** A line diff from their version to yours: lines only in theirs, only in yours, and shared. */
export function lineDiff(theirs: string, yours: string): DiffLine[] {
  const a = theirs.split('\n');
  const b = yours.split('\n');
  // Shared lines at either end need no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = a.slice(0, start).map((text): DiffLine => ({ kind: 'same', text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ kind: 'same', text }));
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  if (ma.length * mb.length > MAX_CELLS) {
    return [...head, ...ma.map((text): DiffLine => ({ kind: 'theirs', text })), ...mb.map((text): DiffLine => ({ kind: 'yours', text })), ...tail];
  }
  // Longest common subsequence, by suffix lengths.
  const n = ma.length;
  const m = mb.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = ma[i] === mb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ma[i] === mb[j]) { middle.push({ kind: 'same', text: ma[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { middle.push({ kind: 'theirs', text: ma[i] }); i++; }
    else { middle.push({ kind: 'yours', text: mb[j] }); j++; }
  }
  while (i < n) middle.push({ kind: 'theirs', text: ma[i++] });
  while (j < m) middle.push({ kind: 'yours', text: mb[j++] });
  return [...head, ...middle, ...tail];
}
