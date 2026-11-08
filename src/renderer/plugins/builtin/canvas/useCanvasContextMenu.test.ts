import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { useCanvasContextMenu } from './useCanvasContextMenu';

function setup() {
  return renderHook(() => useCanvasContextMenu({
    viewport: { panX: 0, panY: 0, zoom: 1 },
    containerRef: { current: document.createElement('div') },
    layoutCenterId: null,
    onAddView: vi.fn(), onAddPluginView: vi.fn(), onSetLayoutCenterId: vi.fn(),
  })).result;
}
function event(target: Element, defaultPrevented = false) {
  const nativeEvent = new MouseEvent('contextmenu', { clientX: 12, clientY: 20 });
  Object.defineProperty(nativeEvent, 'target', { value: target });
  return { target, nativeEvent, defaultPrevented, clientX: 12, clientY: 20,
    preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent;
}
afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges(); });
describe('canvas content context menu boundary', () => {
  it.each(['link', 'image', 'selection', 'input'])('lets %s copy actions reach the native fallback', (kind) => {
    document.body.innerHTML = '<div data-testid="canvas-view-content"><a href="https://example.com">link</a><img src="https://example.com/a.png"><p>selected text</p><input></div>';
    const target = document.querySelector({ link: 'a', image: 'img', selection: 'p', input: 'input' }[kind]!)!;
    if (kind === 'image') Object.defineProperties(target, { complete: { value: true }, naturalWidth: { value: 100 } });
    if (kind === 'selection') {
      const range = document.createRange(); range.selectNodeContents(target); document.getSelection()!.addRange(range);
    }
    const result = setup(); const e = event(target);
    act(() => result.current.handleViewContextMenu('view', e));
    expect(e.preventDefault).not.toHaveBeenCalled(); expect(e.stopPropagation).not.toHaveBeenCalled();
    expect(result.current.viewContextMenu).toBeNull();
  });
  it('yields for a loaded local image even though the canvas rescales the event point', () => {
    document.body.innerHTML = '<div data-testid="canvas-view-content"><img src="data:image/png;base64,AA=="></div>';
    const img = document.querySelector('img')!;
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } });
    const result = setup(); const e = event(img);
    act(() => result.current.handleViewContextMenu('view', e));
    expect(e.preventDefault).not.toHaveBeenCalled(); expect(result.current.viewContextMenu).toBeNull();
  });
  it('keeps the view menu when the only selection is in another panel', () => {
    document.body.innerHTML = '<p id="elsewhere">chat text</p><div data-testid="canvas-view-content"><div id="empty"></div></div>';
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#elsewhere')!); document.getSelection()!.addRange(range);
    const result = setup(); const e = event(document.querySelector('#empty')!);
    act(() => result.current.handleViewContextMenu('view', e));
    expect(e.preventDefault).toHaveBeenCalledOnce(); expect(result.current.viewContextMenu).toEqual({ viewId: 'view', x: 12, y: 20 });
  });
  it('keeps the frame menu and unselected empty content menu', () => {
    const result = setup(); const e = event(document.createElement('div'));
    act(() => result.current.handleViewContextMenu('view', e));
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(result.current.viewContextMenu).toEqual({ viewId: 'view', x: 12, y: 20 });
  });
  it('does not replace a menu already claimed by an editor', () => {
    const result = setup(); const e = event(document.createElement('div'), true);
    act(() => result.current.handleViewContextMenu('view', e));
    expect(e.preventDefault).not.toHaveBeenCalled(); expect(result.current.viewContextMenu).toBeNull();
  });
});
