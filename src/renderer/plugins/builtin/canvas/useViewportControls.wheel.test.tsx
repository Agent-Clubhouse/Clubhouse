import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type React from 'react';
import { useViewportControls } from './useViewportControls';

/**
 * Windows with "Roll the mouse wheel to scroll: One screen at a time" makes
 * Chromium send wheel events with deltaMode = DOM_DELTA_PAGE (2) and deltaY = ±1
 * per notch. Treated as pixels, the canvas would pan 1px per notch.
 */
function setup() {
  const frames: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(() => cb(0)); return frames.length; });
  const onViewportChange = vi.fn();
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientHeight', { value: 800 });
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON() {} });
  const containerRef = { current: container };
  const { result } = renderHook(() => useViewportControls({
    viewport: { panX: 0, panY: 0, zoom: 1 },
    views: [], wireDefinitions: [], selectedViewId: null, layoutCenterId: null,
    containerRef, onViewportChange, onMoveViews: vi.fn(), onUpdateWireDefinition: vi.fn(),
  }));
  return { result, frames, onViewportChange };
}

const wheel = (init: Partial<WheelEvent>) => ({
  deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 500, clientY: 400,
  preventDefault: vi.fn(), ...init,
}) as unknown as React.WheelEvent;

afterEach(() => vi.unstubAllGlobals());

describe('canvas wheel with page-mode deltas', () => {
  it('a one-notch DOM_DELTA_PAGE wheel pans a meaningful distance, not 1px', () => {
    const { result, frames, onViewportChange } = setup();
    act(() => { result.current.handleWheel(wheel({ deltaY: 1, deltaMode: 2 })); frames.forEach((f) => f()); });
    const { panY } = onViewportChange.mock.calls.at(-1)![0];
    expect(Math.abs(panY)).toBeGreaterThan(40);
  });
});
