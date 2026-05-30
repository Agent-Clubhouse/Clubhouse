import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOrderedShallow } from './useOrderedShallow';

describe('useOrderedShallow', () => {
  it('returns previous reference when keys and values match in the same order', () => {
    const { result } = renderHook(() =>
      useOrderedShallow<{ x: Record<string, number> }, Record<string, number>>((s) => s.x),
    );
    const selector = result.current;

    const first = { a: 1, b: 2 };
    const r1 = selector({ x: first });
    expect(r1).toBe(first);

    const second = { a: 1, b: 2 };
    const r2 = selector({ x: second });
    expect(r2).toBe(first);
  });

  it('returns the new reference when key order changes (regression: drag-reorder)', () => {
    const { result } = renderHook(() =>
      useOrderedShallow<{ x: Record<string, number> }, Record<string, number>>((s) => s.x),
    );
    const selector = result.current;

    const first = { a: 1, b: 2, c: 3 };
    selector({ x: first });

    const reordered = { c: 3, a: 1, b: 2 };
    const r2 = selector({ x: reordered });
    expect(r2).toBe(reordered);
    expect(r2).not.toBe(first);
  });

  it('returns the new reference when a value changes (status polling with content delta)', () => {
    const { result } = renderHook(() =>
      useOrderedShallow<{ x: Record<string, { status: string }> }, Record<string, { status: string }>>((s) => s.x),
    );
    const selector = result.current;

    const a = { status: 'idle' };
    const b = { status: 'idle' };
    const first = { a, b };
    selector({ x: first });

    const updatedA = { status: 'running' };
    const second = { a: updatedA, b };
    const r2 = selector({ x: second });
    expect(r2).toBe(second);
    expect(r2).not.toBe(first);
  });

  it('returns the new reference when a key is added or removed', () => {
    const { result } = renderHook(() =>
      useOrderedShallow<{ x: Record<string, number> }, Record<string, number>>((s) => s.x),
    );
    const selector = result.current;

    const first = { a: 1, b: 2 };
    selector({ x: first });

    const added = { a: 1, b: 2, c: 3 };
    expect(selector({ x: added })).toBe(added);

    const removed = { a: 1 };
    expect(selector({ x: removed })).toBe(removed);
  });

  it('handles primitives and null without throwing', () => {
    const { result } = renderHook(() =>
      useOrderedShallow<{ x: number | null }, number | null>((s) => s.x),
    );
    const selector = result.current;
    expect(selector({ x: null })).toBe(null);
    expect(selector({ x: null })).toBe(null);
    expect(selector({ x: 5 })).toBe(5);
    expect(selector({ x: 5 })).toBe(5);
    expect(selector({ x: 6 })).toBe(6);
  });
});
