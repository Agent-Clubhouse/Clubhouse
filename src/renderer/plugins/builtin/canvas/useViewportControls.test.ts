import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type React from 'react';
import { useViewportControls } from './useViewportControls';

function setup() {
  const onViewportChange = vi.fn();
  const { result } = renderHook(() => useViewportControls({
    viewport: { panX: 0, panY: 0, zoom: 1 },
    views: [],
    wireDefinitions: [],
    selectedViewId: null,
    layoutCenterId: null,
    containerRef: { current: document.createElement('div') },
    onViewportChange,
    onMoveViews: vi.fn(),
    onUpdateWireDefinition: vi.fn(),
  }));
  return { result, onViewportChange };
}

function keyEvent(key: string, target: EventTarget, defaultPrevented = false) {
  return { key, target, defaultPrevented, preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
}

describe('useViewportControls keyboard', () => {
  it('pans with the arrow keys on the canvas', () => {
    const { result, onViewportChange } = setup();
    result.current.handleKeyDown(keyEvent('ArrowLeft', document.createElement('div')), null, [], vi.fn());
    expect(onViewportChange).toHaveBeenCalled();
  });

  it.each([
    ['a chat composer', () => document.createElement('textarea')],
    ['an input', () => document.createElement('input')],
    ['an editable element', () => Object.assign(document.createElement('div'), { contentEditable: 'true' })],
  ])('ignores arrows and Escape typed into %s', (_name, make) => {
    const { result, onViewportChange } = setup();
    const target = make();
    // jsdom doesn't compute isContentEditable from contentEditable.
    if (target instanceof HTMLDivElement) Object.defineProperty(target, 'isContentEditable', { value: true });
    const clear = vi.fn();
    result.current.handleKeyDown(keyEvent('ArrowLeft', target), null, [], clear);
    result.current.handleKeyDown(keyEvent('Escape', target), 'view-1', ['view-1'], clear);
    expect(onViewportChange).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('ignores arrows a menu already handled (the context menu moving its highlight)', () => {
    const { result, onViewportChange } = setup();
    const clear = vi.fn();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      result.current.handleKeyDown(keyEvent(key, document.createElement('button'), true), null, [], clear);
    }
    result.current.handleKeyDown(keyEvent('Escape', document.createElement('button'), true), 'view-1', ['view-1'], clear);
    expect(onViewportChange).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});
