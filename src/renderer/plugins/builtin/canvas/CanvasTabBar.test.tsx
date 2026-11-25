import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CanvasTabBar } from './CanvasTabBar';
import { createCanvasStore } from './canvas-store';
import type { CanvasInstance } from './canvas-types';

function makeCanvas(id: string, name: string): CanvasInstance {
  return {
    id,
    name,
    views: [],
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nextZIndex: 0,
    zoomedViewId: null,
    selectedViewId: null,
    minimapAutoHide: true,
    elkAlgorithm: 'layered',
    elkDirection: 'RIGHT',
    layoutCenterId: null,
  };
}

const defaultProps = {
  canvases: [makeCanvas('c1', 'Canvas 1'), makeCanvas('c2', 'Canvas 2')],
  activeCanvasId: 'c1',
  onSelectCanvas: vi.fn(),
  onAddCanvas: vi.fn(),
  onRemoveCanvas: vi.fn(),
  onRenameCanvas: vi.fn(),
};

describe('CanvasTabBar', () => {
  it('renders canvas tabs', () => {
    render(<CanvasTabBar {...defaultProps} />);
    expect(screen.getByText('Canvas 1')).toBeDefined();
    expect(screen.getByText('Canvas 2')).toBeDefined();
  });

  it('+ button calls onAddCanvas directly', () => {
    render(<CanvasTabBar {...defaultProps} />);
    fireEvent.click(screen.getByTestId('canvas-add-button'));
    expect(defaultProps.onAddCanvas).toHaveBeenCalled();
  });

  it('+ button is NOT inside the scrollable tabs container (overflow-x-auto regression guard)', () => {
    // When overflow-x is set to auto, the button would scroll away with the
    // tabs. This test enforces that the + button lives in a sibling container.
    render(<CanvasTabBar {...defaultProps} />);
    const addButton = screen.getByTestId('canvas-add-button');
    const tab = screen.getByTestId('canvas-tab-c1');

    // The button and a canvas tab must NOT share the same immediate parent.
    // If this fails, the button has been moved back inside the scrollable div.
    expect(addButton.parentElement).not.toBe(tab.parentElement);
    // And the scrollable tabs container must not contain the + button.
    expect(tab.parentElement?.contains(addButton)).toBe(false);
  });

  it('the close button on an inactive tab takes no clicks or Tab stop until hovered', () => {
    render(<CanvasTabBar {...defaultProps} />);
    const [activeClose, inactiveClose] = screen.getAllByTestId('canvas-tab-close');
    expect(activeClose.getAttribute('tabindex')).toBeNull();
    expect(activeClose.className).not.toContain('pointer-events-none');
    expect(inactiveClose.getAttribute('tabindex')).toBe('-1');
    expect(inactiveClose.className).toContain('pointer-events-none');
    expect(inactiveClose.className).toContain('group-hover:pointer-events-auto');
  });
});

// ── Integration: + button → real store → DOM update ────────────────────
//
// Mission 71 — Coverage gap: the tests above mock onAddCanvas with vi.fn(),
// so they verify the wiring from button to handler but never exercise the
// real store action behind it. A regression that broke handleAddCanvas or
// store.addCanvas() would not surface here.
//
// These tests render CanvasTabBar wired to a real canvas store via a thin
// wrapper that mirrors what main.ts MainPanel does, then assert the store
// state actually changed and the new tab is rendered to the DOM.

describe('CanvasTabBar — + button integration with real store', () => {
  // Real canvas IDs from createCanvasInstance() are formatted as
  // "canvas_xxxxxxxx" (see canvas-operations.ts:585), so the matching tab
  // testid is "canvas-tab-canvas_xxxxxxxx". This selector is specific to
  // actual tabs and excludes the wrapper ("canvas-tab-bar"), the close
  // button ("canvas-tab-close"), the popout button ("canvas-tab-popout"),
  // the rename input ("canvas-tab-rename-input"), and the context menu.
  function getRenderedTabs(container: HTMLElement): NodeListOf<Element> {
    return container.querySelectorAll('[data-testid^="canvas-tab-canvas_"]');
  }

  it('clicking + adds a canvas via the real store action', () => {
    const store = createCanvasStore();
    expect(store.getState().canvases).toHaveLength(1);

    function Host() {
      const [, force] = useState(0);
      React.useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
      const state = store.getState();
      return (
        <CanvasTabBar
          canvases={state.canvases}
          activeCanvasId={state.activeCanvasId}
          onSelectCanvas={() => undefined}
          onAddCanvas={() => store.getState().addCanvas()}
          onRemoveCanvas={() => undefined}
          onRenameCanvas={() => undefined}
        />
      );
    }

    const { container } = render(<Host />);
    expect(getRenderedTabs(container).length).toBe(1);
    fireEvent.click(screen.getByTestId('canvas-add-button'));
    expect(store.getState().canvases).toHaveLength(2);
    expect(getRenderedTabs(container).length).toBe(2);
  });
});
