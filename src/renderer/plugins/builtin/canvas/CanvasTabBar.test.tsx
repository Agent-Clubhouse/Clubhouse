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

  it('renders + button that opens dropdown when onAddFromBlueprint is provided', () => {
    const onAddFromBlueprint = vi.fn();
    render(<CanvasTabBar {...defaultProps} onAddFromBlueprint={onAddFromBlueprint} />);

    const addBtn = screen.getByTestId('canvas-add-button');
    fireEvent.click(addBtn);

    expect(screen.getByTestId('canvas-add-menu')).toBeDefined();
    expect(screen.getByTestId('canvas-add-new')).toBeDefined();
    expect(screen.getByTestId('canvas-add-from-blueprint')).toBeDefined();
  });

  it('"New Canvas" menu item calls onAddCanvas', () => {
    const onAddFromBlueprint = vi.fn();
    render(<CanvasTabBar {...defaultProps} onAddFromBlueprint={onAddFromBlueprint} />);

    fireEvent.click(screen.getByTestId('canvas-add-button'));
    fireEvent.click(screen.getByTestId('canvas-add-new'));

    expect(defaultProps.onAddCanvas).toHaveBeenCalled();
  });

  it('"From Blueprint" menu item calls onAddFromBlueprint', () => {
    const onAddFromBlueprint = vi.fn();
    render(<CanvasTabBar {...defaultProps} onAddFromBlueprint={onAddFromBlueprint} />);

    fireEvent.click(screen.getByTestId('canvas-add-button'));
    fireEvent.click(screen.getByTestId('canvas-add-from-blueprint'));

    expect(onAddFromBlueprint).toHaveBeenCalled();
  });

  it('+ button calls onAddCanvas directly when no onAddFromBlueprint', () => {
    render(<CanvasTabBar {...defaultProps} />);
    fireEvent.click(screen.getByTestId('canvas-add-button'));
    expect(defaultProps.onAddCanvas).toHaveBeenCalled();
  });

  it('+ button is NOT inside the scrollable tabs container (overflow-x-auto regression guard)', () => {
    // When overflow-x is set to auto, CSS computes overflow-y as auto too,
    // clipping any absolutely-positioned dropdown that extends below the
    // container. This test enforces that the + button lives in a sibling
    // container so its dropdown is never clipped in real browsers.
    render(<CanvasTabBar {...defaultProps} onAddFromBlueprint={vi.fn()} />);
    const addButton = screen.getByTestId('canvas-add-button');
    const tab = screen.getByTestId('canvas-tab-c1');

    // The button and a canvas tab must NOT share the same immediate parent.
    // If this fails, the button has been moved back inside the scrollable div.
    expect(addButton.parentElement).not.toBe(tab.parentElement);
    // And the scrollable tabs container must not contain the + button.
    expect(tab.parentElement?.contains(addButton)).toBe(false);
  });

  it('right-click on tab shows context menu with Export as Blueprint', () => {
    const onExportBlueprint = vi.fn();
    render(<CanvasTabBar {...defaultProps} onExportBlueprint={onExportBlueprint} />);

    const tab = screen.getByTestId('canvas-tab-c1');
    fireEvent.contextMenu(tab);

    expect(screen.getByTestId('canvas-tab-context-menu')).toBeDefined();
    expect(screen.getByTestId('canvas-tab-export-blueprint')).toBeDefined();
  });

  it('Export as Blueprint context menu item calls onExportBlueprint', () => {
    const onExportBlueprint = vi.fn();
    render(<CanvasTabBar {...defaultProps} onExportBlueprint={onExportBlueprint} />);

    const tab = screen.getByTestId('canvas-tab-c1');
    fireEvent.contextMenu(tab);
    fireEvent.click(screen.getByTestId('canvas-tab-export-blueprint'));

    expect(onExportBlueprint).toHaveBeenCalledWith('c1');
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

  it('clicking + → New Canvas adds a canvas via the real store action', () => {
    // Hoist the store outside React so re-renders don't recreate it and
    // strict-mode double-effects can't influence the count we're asserting.
    const store = createCanvasStore();
    expect(store.getState().canvases).toHaveLength(1);

    function Host() {
      const [, force] = useState(0);
      // Subscribe ONCE; strict-mode-safe via cleanup.
      React.useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
      const state = store.getState();
      return (
        <CanvasTabBar
          canvases={state.canvases}
          activeCanvasId={state.activeCanvasId}
          onSelectCanvas={() => undefined}
          onAddCanvas={() => store.getState().addCanvas()}
          onAddFromBlueprint={() => undefined}
          onRemoveCanvas={() => undefined}
          onRenameCanvas={() => undefined}
        />
      );
    }

    const { container } = render(<Host />);
    expect(getRenderedTabs(container).length).toBe(1);

    // Click + to open the dropdown (matches production: main.ts always
    // wires both onAddCanvas and onAddFromBlueprint, so users always see
    // the dropdown variant of the + button).
    fireEvent.click(screen.getByTestId('canvas-add-button'));
    expect(screen.getByTestId('canvas-add-menu')).toBeDefined();

    // Click "New Canvas" — this is what real users click
    fireEvent.click(screen.getByTestId('canvas-add-new'));

    // The store action must have fired exactly once and added one canvas
    expect(store.getState().canvases).toHaveLength(2);
    // And the DOM must reflect the new canvas tab
    expect(getRenderedTabs(container).length).toBe(2);
  });

  it('clicking + (no dropdown variant) adds a canvas via the real store action', () => {
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
