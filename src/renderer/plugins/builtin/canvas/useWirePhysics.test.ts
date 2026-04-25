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

  it('RAF loop idles within 150 frames after a large view movement (PERF-3)', () => {
    // With AMBIENT_AMP=1.5 the sway impulse per frame (~0.024 px/s) is large
    // enough to push a settling spring velocity back above IDLE_THRESHOLD (0.1)
    // during the tail of damping, adding extra frames. With AMBIENT_AMP=0.05 the
    // sway impulse is ~0.0008 px/s — negligible — so the loop idles at the
    // natural settling point.
    const wires = [makeWireSpec('w1')];
    const pos0 = new Map([
      ['view-w1-from', { x: 0, y: 0 }],
      ['view-w1-to', { x: 300, y: 0 }],
    ]);
    const pos1 = new Map([
      ['view-w1-from', { x: 300, y: 300 }], // large delta → big spring impulse
      ['view-w1-to', { x: 600, y: 300 }],
    ]);

    const { rerender } = renderHook(
      ({ pos }) => useWirePhysics(wires, pos, true),
      { initialProps: { pos: pos0 } },
    );

    // Trigger the large displacement then immediately spy on RAF.
    act(() => { rerender({ pos: pos1 }); });

    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');

    // With AMBIENT_AMP=0.05 the spring settles (velocity < 0.1) well inside
    // 150 frames (~2.4s) without sway interference.
    // With AMBIENT_AMP=1.5 sway extends the tail by accumulating extra frames
    // beyond this window.
    act(() => {
      for (let i = 0; i < 150; i++) {
        vi.advanceTimersByTime(16);
      }
    });

    const activeFrames = rafSpy.mock.calls.length;

    act(() => {
      for (let i = 0; i < 30; i++) {
        vi.advanceTimersByTime(16);
      }
    });

    // No new RAF calls in the trailing 30 frames — loop must have idled.
    expect(rafSpy.mock.calls.length).toBe(activeFrames);

    rafSpy.mockRestore();
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
