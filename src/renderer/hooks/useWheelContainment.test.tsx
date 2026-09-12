import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWheelContainment, stopPlainWheelPropagation } from './useWheelContainment';

describe('useWheelContainment', () => {
  it('stops plain wheel events from bubbling', () => {
    const { result } = renderHook(() => useWheelContainment());
    const stopPropagation = vi.fn();
    const event = { ctrlKey: false, metaKey: false, stopPropagation } as unknown as React.WheelEvent;

    result.current(event);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('lets Ctrl+wheel and Meta+wheel gestures bubble', () => {
    const { result } = renderHook(() => useWheelContainment());
    const stopPropagation = vi.fn();

    result.current({ ctrlKey: true, metaKey: false, stopPropagation } as unknown as React.WheelEvent);
    result.current({ ctrlKey: false, metaKey: true, stopPropagation } as unknown as React.WheelEvent);

    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it('exposes the same behavior for direct event handlers', () => {
    const stopPropagation = vi.fn();
    const event = { ctrlKey: false, metaKey: false, stopPropagation } as unknown as React.WheelEvent;

    stopPlainWheelPropagation(event);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });
});
