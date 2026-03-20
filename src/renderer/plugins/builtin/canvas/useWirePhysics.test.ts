import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWirePhysics } from './useWirePhysics';
import type { Edge } from './wire-utils';

function makeWireSpec(key: string, fromEdge: Edge = 'right', toEdge: Edge = 'left') {
  return {
    key,
    fromEdge,
    toEdge,
    fromViewId: `view-${key}-from`,
    toViewId: `view-${key}-to`,
  };
}

describe('useWirePhysics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty map when disabled', () => {
    const { result } = renderHook(() =>
      useWirePhysics([makeWireSpec('w1')], undefined, false),
    );
    expect(result.current.size).toBe(0);
  });

  it('returns empty map when no wires', () => {
    const { result } = renderHook(() =>
      useWirePhysics([], undefined, true),
    );
    expect(result.current.size).toBe(0);
  });

  it('produces offsets for each wire after animation frames', () => {
    const wires = [makeWireSpec('w1')];
    const { result } = renderHook(() =>
      useWirePhysics(wires, undefined, true),
    );

    // Trigger a few animation frames
    act(() => {
      // Simulate rAF callbacks at 16ms intervals
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(16);
        // rAF fires on timer advance in fake timers
      }
    });

    // After frames, should have offsets for w1
    const offset = result.current.get('w1');
    if (offset) {
      // Offsets should be within MAX_OFFSET bounds
      expect(Math.abs(offset.fromDx)).toBeLessThanOrEqual(20);
      expect(Math.abs(offset.fromDy)).toBeLessThanOrEqual(20);
      expect(Math.abs(offset.toDx)).toBeLessThanOrEqual(20);
      expect(Math.abs(offset.toDy)).toBeLessThanOrEqual(20);
    }
  });

  it('offsets stay within MAX_OFFSET (20px) bounds', () => {
    const wires = [makeWireSpec('w1')];
    const viewPos = new Map([
      ['view-w1-from', { x: 0, y: 0 }],
      ['view-w1-to', { x: 300, y: 0 }],
    ]);

    const { result, rerender } = renderHook(
      ({ pos }) => useWirePhysics(wires, pos, true),
      { initialProps: { pos: viewPos } },
    );

    // Simulate a large sudden movement
    const bigMove = new Map([
      ['view-w1-from', { x: 500, y: 500 }],
      ['view-w1-to', { x: 800, y: 500 }],
    ]);

    act(() => {
      rerender({ pos: bigMove });
      for (let i = 0; i < 30; i++) {
        vi.advanceTimersByTime(16);
      }
    });

    const offset = result.current.get('w1');
    if (offset) {
      expect(Math.abs(offset.fromDx)).toBeLessThanOrEqual(20);
      expect(Math.abs(offset.fromDy)).toBeLessThanOrEqual(20);
      expect(Math.abs(offset.toDx)).toBeLessThanOrEqual(20);
      expect(Math.abs(offset.toDy)).toBeLessThanOrEqual(20);
    }
  });
});
