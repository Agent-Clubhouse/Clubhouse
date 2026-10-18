import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWheelContainment, stopPlainWheelPropagation, isInScrollableRegion, containScrollableWheel } from './useWheelContainment';

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

describe('isInScrollableRegion / containScrollableWheel', () => {
  function tree(overflowY: string, { scrollHeight = 500, clientHeight = 100 } = {}) {
    const boundary = document.createElement('div');
    const scroller = document.createElement('div');
    const leaf = document.createElement('span');
    scroller.style.overflowY = overflowY;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: clientHeight });
    scroller.appendChild(leaf);
    boundary.appendChild(scroller);
    document.body.appendChild(boundary);
    return { boundary, scroller, leaf };
  }

  it.each(['auto', 'scroll'])('finds an overflowing overflow:%s ancestor', (overflow) => {
    const { boundary, leaf } = tree(overflow);
    expect(isInScrollableRegion(leaf, boundary)).toBe(true);
  });

  it('ignores overflow:hidden and regions with nothing to scroll', () => {
    expect(isInScrollableRegion(tree('hidden').leaf, tree('hidden').boundary)).toBe(false);
    const flat = tree('auto', { scrollHeight: 100, clientHeight: 100 });
    expect(isInScrollableRegion(flat.leaf, flat.boundary)).toBe(false);
  });

  it('finds horizontal scrollers', () => {
    const { boundary, scroller, leaf } = tree('visible');
    scroller.style.overflowX = 'auto';
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 800 });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 });
    expect(isInScrollableRegion(leaf, boundary)).toBe(true);
  });

  it('does not look past the boundary', () => {
    const { scroller, leaf } = tree('auto');
    const inner = document.createElement('div');
    inner.appendChild(document.createElement('i'));
    leaf.appendChild(inner);
    expect(isInScrollableRegion(inner.firstChild, inner)).toBe(false);
    expect(isInScrollableRegion(inner.firstChild, scroller)).toBe(true);
  });

  it('stops a plain wheel in a scroller and lets Ctrl/Meta bubble', () => {
    const { boundary, leaf } = tree('auto');
    const stopPropagation = vi.fn();
    containScrollableWheel({ ctrlKey: false, metaKey: false, stopPropagation, target: leaf } as unknown as React.WheelEvent, boundary);
    containScrollableWheel({ ctrlKey: true, metaKey: false, stopPropagation, target: leaf } as unknown as React.WheelEvent, boundary);
    containScrollableWheel({ ctrlKey: false, metaKey: true, stopPropagation, target: leaf } as unknown as React.WheelEvent, boundary);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });
});
