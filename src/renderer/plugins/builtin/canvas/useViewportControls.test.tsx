import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useBatchedViewportChange } from './canvas-viewport-batching';

describe('useBatchedViewportChange', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('batches rapid viewport updates into one commit per animation frame', () => {
    const onViewportChange = vi.fn();
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(() => cb(0));
      return frames.length;
    });

    const { result } = renderHook(() => useBatchedViewportChange(onViewportChange));

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
});
