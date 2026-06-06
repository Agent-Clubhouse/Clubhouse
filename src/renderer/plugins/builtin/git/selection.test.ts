import { describe, it, expect } from 'vitest';
import { evaluateSelectionPersistence } from './selection';

describe('evaluateSelectionPersistence', () => {
  it('keeps selection when the file is present in status', () => {
    const status = [{ path: 'a.ts' }, { path: 'b.ts' }];
    const result = evaluateSelectionPersistence(status, 'a.ts', 0);
    expect(result).toEqual({ drop: false, misses: 0 });
  });

  it('resets the miss counter when the file reappears', () => {
    const status = [{ path: 'a.ts' }];
    const result = evaluateSelectionPersistence(status, 'a.ts', 1);
    expect(result).toEqual({ drop: false, misses: 0 });
  });

  it('never drops the selection when nothing is selected', () => {
    const result = evaluateSelectionPersistence([], null, 0);
    expect(result).toEqual({ drop: false, misses: 0 });
  });

  it('does not drop on a transient empty status snapshot', () => {
    // Empty status = likely a failed/partial read. Preserve both the
    // selection and the existing miss count.
    const result = evaluateSelectionPersistence([], 'a.ts', 1);
    expect(result).toEqual({ drop: false, misses: 1 });
  });

  it('does not drop on the first miss from a non-empty status', () => {
    const status = [{ path: 'other.ts' }];
    const result = evaluateSelectionPersistence(status, 'a.ts', 0);
    expect(result).toEqual({ drop: false, misses: 1 });
  });

  it('drops only after two consecutive non-empty misses', () => {
    const status = [{ path: 'other.ts' }];
    const first = evaluateSelectionPersistence(status, 'a.ts', 0);
    expect(first).toEqual({ drop: false, misses: 1 });
    const second = evaluateSelectionPersistence(status, 'a.ts', first.misses);
    expect(second).toEqual({ drop: true, misses: 2 });
  });

  it('does not let a transient empty poll between two misses cause a false drop', () => {
    const populated = [{ path: 'other.ts' }];
    // Miss 1 (file genuinely absent)
    const a = evaluateSelectionPersistence(populated, 'a.ts', 0);
    expect(a).toEqual({ drop: false, misses: 1 });
    // Transient empty read — counter held, no drop
    const b = evaluateSelectionPersistence([], 'a.ts', a.misses);
    expect(b).toEqual({ drop: false, misses: 1 });
    // File comes back — counter resets
    const c = evaluateSelectionPersistence([{ path: 'a.ts' }], 'a.ts', b.misses);
    expect(c).toEqual({ drop: false, misses: 0 });
  });
});
