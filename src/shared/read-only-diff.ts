/** Bounded line diff for passive host worktree inspection; no git snapshots or temporary files. */
export interface ReadOnlyTextDiff { additions: number; deletions: number; patch: string }
type Op = { kind: ' ' | '+' | '-'; line: string };
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export function readOnlyTextDiff(before: string, after: string, file: string, maxSteps = 2_000_000, maxBytes = 128 * 1024, budget?: { remaining: number }): ReadOnlyTextDiff | null {
  if (before === after) return { additions: 0, deletions: 0, patch: '' };
  const a = lines(before), b = lines(after);
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let steps = 0;
  const spend = (n: number) => { steps += n; if (budget) budget.remaining -= n; return steps <= maxSteps && (!budget || budget.remaining >= 0); };
  let depth = -1;
  for (let d = 0; d <= a.length + b.length; d++) {
    if (!spend(frontier.size)) return null;
    trace.push(new Map(frontier));
    for (let k = -d; k <= d; k += 2) {
      if (!spend(1)) return null;
      let x = k === -d || k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1)
        ? frontier.get(k + 1) ?? 0 : (frontier.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; if (!spend(1)) return null; }
      frontier.set(k, x);
      if (x >= a.length && y >= b.length) { depth = d; break; }
    }
    if (depth >= 0) break;
  }
  const reversed: Op[] = [];
  let x = a.length, y = b.length;
  for (let d = depth; d >= 0; d--) {
    frontier = trace[d];
    const k = x - y;
    const prevK = k === -d || k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1) ? k + 1 : k - 1;
    const prevX = frontier.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { reversed.push({ kind: ' ', line: a[--x] }); y--; }
    if (d === 0) break;
    if (x === prevX) reversed.push({ kind: '+', line: b[--y] });
    else reversed.push({ kind: '-', line: a[--x] });
  }
  const ops = reversed.reverse();
  const starts: { old: number; next: number }[] = [];
  let old = 1, next = 1;
  for (const op of ops) {
    starts.push({ old, next });
    if (op.kind !== '+') old++;
    if (op.kind !== '-') next++;
  }
  const hunks: { start: number; end: number }[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind === ' ') continue;
    const start = Math.max(0, i - 3), end = Math.min(ops.length, i + 4);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end) last.end = end;
    else hunks.push({ start, end });
  }
  let patch = `--- a/${file}\n+++ b/${file}\n`;
  for (const h of hunks) {
    const entries = ops.slice(h.start, h.end);
    const oldCount = entries.filter((o) => o.kind !== '+').length;
    const newCount = entries.filter((o) => o.kind !== '-').length;
    patch += `@@ -${starts[h.start].old - (oldCount === 0 ? 1 : 0)},${oldCount} +${starts[h.start].next - (newCount === 0 ? 1 : 0)},${newCount} @@\n`;
    for (const op of entries) patch += op.kind + op.line + (op.line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
    if (new TextEncoder().encode(patch).byteLength > maxBytes) return null;
  }
  return { additions: ops.filter((o) => o.kind === '+').length, deletions: ops.filter((o) => o.kind === '-').length, patch };
}
