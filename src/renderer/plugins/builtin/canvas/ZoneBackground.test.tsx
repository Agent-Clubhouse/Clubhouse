import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ZoneBackground } from './ZoneBackground';
import type { ZoneCanvasView } from './canvas-types';

function makeZone(overrides?: Partial<ZoneCanvasView>): ZoneCanvasView {
  return {
    id: 'zone-1',
    type: 'zone',
    position: { x: 100, y: 200 },
    size: { width: 600, height: 400 },
    title: 'Test Zone',
    displayName: 'Test Zone',
    zIndex: 5,
    themeId: 'catppuccin-mocha',
    containedViewIds: [],
    metadata: {},
    ...overrides,
  };
}

describe('ZoneBackground', () => {
  it('renders at zone position and size', () => {
    const zone = makeZone();
    const { getByTestId } = render(<ZoneBackground zone={zone} />);
    const el = getByTestId('zone-background-zone-1');
    expect(el.style.left).toBe('100px');
    expect(el.style.top).toBe('200px');
    expect(el.style.width).toBe('600px');
    expect(el.style.height).toBe('400px');
  });

  it('applies drag offset as transform', () => {
    const zone = makeZone();
    const { getByTestId } = render(
      <ZoneBackground zone={zone} dragOffset={{ dx: 10, dy: 20 }} />,
    );
    const el = getByTestId('zone-background-zone-1');
    expect(el.style.transform).toBe('translate(10px, 20px)');
  });

  it('applies resize override for size and position', () => {
    const zone = makeZone();
    const { getByTestId } = render(
      <ZoneBackground
        zone={zone}
        resizeOverride={{ size: { width: 800, height: 500 }, position: { x: 50, y: 100 } }}
      />,
    );
    const el = getByTestId('zone-background-zone-1');
    expect(el.style.left).toBe('50px');
    expect(el.style.top).toBe('100px');
    expect(el.style.width).toBe('800px');
    expect(el.style.height).toBe('500px');
  });

  describe('resize handles', () => {
    it('renders resize handles when onResizeStart is provided', () => {
      const onResizeStart = vi.fn();
      const zone = makeZone();
      const { getByTestId } = render(
        <ZoneBackground zone={zone} onResizeStart={onResizeStart} />,
      );

      // All 8 handles should be present
      for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        expect(getByTestId(`zone-resize-${dir}-zone-1`)).toBeTruthy();
      }
    });

    it('does not render resize handles when onResizeStart is not provided', () => {
      const zone = makeZone();
      const { queryByTestId } = render(<ZoneBackground zone={zone} />);
      expect(queryByTestId('zone-resize-se-zone-1')).toBeNull();
    });

    it('calls onResizeStart with correct direction on mousedown', () => {
      const onResizeStart = vi.fn();
      const zone = makeZone();
      const { getByTestId } = render(
        <ZoneBackground zone={zone} onResizeStart={onResizeStart} />,
      );

      fireEvent.mouseDown(getByTestId('zone-resize-se-zone-1'));
      expect(onResizeStart).toHaveBeenCalledWith('se', expect.anything());

      onResizeStart.mockClear();
      fireEvent.mouseDown(getByTestId('zone-resize-n-zone-1'));
      expect(onResizeStart).toHaveBeenCalledWith('n', expect.anything());
    });

    it('renders SE corner grip indicator', () => {
      const onResizeStart = vi.fn();
      const zone = makeZone();
      const { getByTestId } = render(
        <ZoneBackground zone={zone} onResizeStart={onResizeStart} />,
      );

      const seHandle = getByTestId('zone-resize-se-zone-1');
      expect(seHandle.querySelector('svg')).toBeTruthy();
    });
  });
});
