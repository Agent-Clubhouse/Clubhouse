import { describe, expect, it } from 'vitest';
import { readOnlyTextDiff } from './read-only-diff';

describe('bounded passive worktree line diff', () => {
  it.each([
    ['', 'one\n', 1, 0], ['one\n', '', 0, 1], ['a\nb\nc\n', 'a\nx\nc\n', 1, 1],
    ['a\nb\n', 'a\nb\nx', 1, 0], ['a\r\n', 'a\n', 1, 1], ['a', 'a\n', 1, 1],
  ])('counts exact line edits and emits a reconstructable diff for %j -> %j', (before, after, additions, deletions) => {
    const result = readOnlyTextDiff(before as string, after as string, 'file')!;
    expect(result).toMatchObject({ additions, deletions });
    expect(result.patch).toContain('--- a/file\n+++ b/file\n@@');
  });
  it('keeps separate hunks with context and distinguishes resource exhaustion from no changes', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');
    const result = readOnlyTextDiff(before, before.replace('line 2\n', 'changed 2\n').replace('line 35\n', 'changed 35\n'), 'file')!;
    expect(result).toMatchObject({ additions: 2, deletions: 2 });
    expect(result.patch.match(/^@@ /gm)).toHaveLength(2);
    expect(result.patch).not.toContain('line 15');
    expect(readOnlyTextDiff('a\n', 'a\n', 'file')).toEqual({ additions: 0, deletions: 0, patch: '' });
    expect(readOnlyTextDiff('a\n', 'b\n', 'file', 0)).toBeNull();
    expect(readOnlyTextDiff('a\n', 'b\n', 'file', 100, 1)).toBeNull();
    expect(readOnlyTextDiff('a', 'b', 'file')?.patch).toContain('\\ No newline at end of file');
  });
  it('matches independent LCS edit counts and reconstructs varied small files from the emitted hunks', () => {
    let seed = 12345;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let run = 0; run < 150; run++) {
      const before = Array.from({ length: random(10) }, () => `${random(4)}\n`);
      const after = Array.from({ length: random(10) }, () => `${random(4)}\n`);
      const dp = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
      for (let a = before.length - 1; a >= 0; a--) for (let b = after.length - 1; b >= 0; b--) dp[a][b] = before[a] === after[b] ? 1 + dp[a + 1][b + 1] : Math.max(dp[a + 1][b], dp[a][b + 1]);
      const diff = readOnlyTextDiff(before.join(''), after.join(''), 'file')!;
      expect(diff).toMatchObject({ additions: after.length - dp[0][0], deletions: before.length - dp[0][0] });
      if (!diff.patch) { expect(before).toEqual(after); continue; }
      const restored: string[] = [];
      let cursor = 0;
      for (const line of diff.patch.split('\n').slice(2, -1)) {
        const hunk = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(line);
        if (hunk) { const start = Number(hunk[1]) - (Number(hunk[2]) === 0 ? 0 : 1); restored.push(...before.slice(cursor, start)); cursor = start; }
        else if (line.startsWith('+')) restored.push(line.slice(1) + '\n');
        else if (line.startsWith('-')) { expect(before[cursor++]).toBe(line.slice(1) + '\n'); }
        else if (line.startsWith(' ')) { expect(before[cursor]).toBe(line.slice(1) + '\n'); restored.push(before[cursor++]); }
      }
      restored.push(...before.slice(cursor));
      expect(restored).toEqual(after);
    }
  });
});
