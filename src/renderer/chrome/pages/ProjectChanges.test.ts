import { describe, it, expect } from 'vitest';
import { overlaps } from './ProjectChanges';

const branch = (paths: string[]) => ({ available: true, files: paths.map((path) => ({ path, status: 'modified' as const, additions: 1, deletions: 0, binary: false })), ahead: 1, uncommitted: 0 });

describe('overlaps', () => {
  it('flags files two agent branches both change', () => {
    const out = overlaps(
      { a: branch(['src/AgentRow.tsx', 'src/a.ts']), b: branch(['src/AgentRow.tsx']), c: branch(['src/c.ts']) },
      { a: 'gallant-swift', b: 'bold-falcon', c: 'radiant-bobcat' },
    );
    expect(out.a).toEqual([{ path: 'src/AgentRow.tsx', others: ['bold-falcon'] }]);
    expect(out.b).toEqual([{ path: 'src/AgentRow.tsx', others: ['gallant-swift'] }]);
    expect(out.c).toBeUndefined();
  });

  it('ignores branches not read yet', () => {
    expect(overlaps({ a: null, b: branch(['x']) }, {})).toEqual({});
  });
});
