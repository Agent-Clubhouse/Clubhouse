import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useBatchedViewportChange } from './canvas-viewport-batching';

describe('useBatchedViewportChange', () => {
  const initialViewport = { panX: 0, panY: 0, zoom: 1 };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('batches rapid viewport updates into one commit per animation frame', () => {
    const onViewportChange = vi.fn();
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(() => cb(0));
      return frames.length;
    });

    const { result } = renderHook(() => useBatchedViewportChange(onViewportChange, initialViewport));

    act(() => {
      result.current.scheduleViewportChange({ panX: 0, panY: 0, zoom: 1 });
      result.current.scheduleViewportChange({ panX: 9, panY: 18, zoom: 1 });
      result.current.scheduleViewportChange({ panX: 24, panY: 36, zoom: 1.2 });
    });

    expect(onViewportChange).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    act(() => {
      frames[0]();
    });

    expect(onViewportChange).toHaveBeenCalledTimes(1);
    expect(onViewportChange).toHaveBeenCalledWith({ panX: 24, panY: 36, zoom: 1.2 });
  });

  it('accumulates functional updates against the pending viewport', () => {
    const onViewportChange = vi.fn();
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(() => cb(0));
      return frames.length;
    });

    const { result } = renderHook(() => useBatchedViewportChange(onViewportChange, initialViewport));
    act(() => {
      result.current.scheduleViewportChange((current) => ({ ...current, panX: current.panX + 5 }));
      result.current.scheduleViewportChange((current) => ({ ...current, panX: current.panX + 7 }));
      frames[0]();
    });

    expect(onViewportChange).toHaveBeenCalledOnce();
    expect(onViewportChange).toHaveBeenCalledWith({ panX: 12, panY: 0, zoom: 1 });
  });

  it('cancels a pending frame when the hook unmounts', () => {
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 42));
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

    const { result, unmount } = renderHook(() => useBatchedViewportChange(vi.fn(), initialViewport));
    act(() => result.current.scheduleViewportChange({ panX: 1, panY: 2, zoom: 1 }));
    unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
  });
});
