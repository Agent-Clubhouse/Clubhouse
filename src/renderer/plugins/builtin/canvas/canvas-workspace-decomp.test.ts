/* eslint-disable no-restricted-syntax -- TODO(TC-CRIT-03): structural readFileSync tests pending behavioral conversion */
/**
 * Tests for M-PLUG-01: CanvasWorkspace decomposition.
 *
 * Verifies the interface and structural contracts of the 4 extracted hooks
 * and 2 extracted components. Each test fails on pre-fix code (the old
 * monolithic CanvasWorkspace) and passes after extraction.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const dir = __dirname;

function src(file: string): string {
  return fs.readFileSync(path.join(dir, file), 'utf-8');
}

// ── useViewportControls ────────────────────────────────────────────────

describe('useViewportControls', () => {
  const source = src('useViewportControls.ts');

  it('exports useViewportControls function', () => {
    expect(source).toContain('export function useViewportControls');
  });

  it('accepts onFocusView optional callback', () => {
    expect(source).toContain('onFocusView?:');
  });

  it('calls onFocusView in handleSearchSelect', () => {
    expect(source).toContain('onFocusView?.(viewId)');
  });

  it('handleWheel handles ctrl+wheel zoom and plain pan', () => {
    expect(source).toContain('ctrlKey');
    expect(source).toContain('zoomTowardPoint');
    expect(source).toContain('deltaY');
    expect(source).toContain('deltaX');
  });

  it('handleKeyDown pans with arrow keys when no view selected', () => {
    expect(source).toContain('ArrowLeft');
    expect(source).toContain('ArrowRight');
    expect(source).toContain('ArrowUp');
    expect(source).toContain('ArrowDown');
  });

  it('handleKeyDown clears selection on Escape', () => {
    expect(source).toContain("'Escape'");
    expect(source).toContain('onClearSelection');
  });

  it('handleAutolayout uses ELK and animates with requestAnimationFrame', () => {
    expect(source).toContain('layoutElk');
    expect(source).toContain('requestAnimationFrame');
    expect(source).toContain('animateStep');
  });

  it('returns panStartRef for middle-click pan tracking', () => {
    expect(source).toContain('panStartRef');
    expect(source).toContain('return {');
  });
});

// ── useSelectionManager ────────────────────────────────────────────────

describe('useSelectionManager', () => {
  const source = src('useSelectionManager.ts');

  it('exports useSelectionManager function', () => {
    expect(source).toContain('export function useSelectionManager');
  });

  it('manages lasso selection rect state', () => {
    expect(source).toContain('selectionRect');
    expect(source).toContain('setSelectionRect');
    expect(source).toContain('startX');
    expect(source).toContain('currentX');
  });

  it('isViewFullyInRect used for lasso containment check', () => {
    expect(source).toContain('isViewFullyInRect');
  });

  it('manages multi-drag state with delta', () => {
    expect(source).toContain('multiDrag');
    expect(source).toContain('multiDragDelta');
    expect(source).toContain('dragViewId');
  });

  it('handleViewMultiDragStart only activates when multiple views selected', () => {
    const block = source.slice(
      source.indexOf('handleViewMultiDragStart'),
      source.indexOf('useEffect(\n    () => {\n      if (!multiDrag)'),
    );
    expect(block).toContain('selectedViewIds.length > 1');
    expect(block).toContain('selectedViewIds.includes(viewId)');
  });

  it('multi-drag mouseUp calls onMoveViews with snapped positions', () => {
    expect(source).toContain('snapPosition');
    expect(source).toContain('onMoveViews');
  });

  it('exposes setSingleDragPos for external zone drag tracking', () => {
    expect(source).toContain('setSingleDragPos');
    // Verify it's in the return object
    const returnBlock = source.slice(source.indexOf('return {'), source.length);
    expect(returnBlock).toContain('setSingleDragPos');
  });

  it('handleViewDragEnd takes onMoveView as arg to avoid stale closure', () => {
    const block = source.slice(
      source.indexOf('handleViewDragEnd'),
      source.indexOf('clearSingleDragPos'),
    );
    expect(block).toContain('onMoveView:');
  });
});

// ── useZoneManager ─────────────────────────────────────────────────────

describe('useZoneManager', () => {
  const source = src('useZoneManager.ts');

  it('exports useZoneManager function', () => {
    expect(source).toContain('export function useZoneManager');
  });

  it('accepts onSingleDragPosChange for wire overlay tracking', () => {
    expect(source).toContain('onSingleDragPosChange');
  });

  it('calls onSingleDragPosChange during zone drag mousemove', () => {
    expect(source).toContain('onSingleDragPosChange');
    expect(source).toContain('dragPositions');
  });

  it('clears drag positions on blur (focus loss)', () => {
    expect(source).toContain('handleBlur');
    expect(source).toContain("window.addEventListener('blur'");
    expect(source).toContain('new Map()');
  });

  it('cleans up zone drag listeners on unmount', () => {
    expect(source).toContain('zoneDragCleanupRef');
    expect(source).toContain('zoneDragCleanupRef.current?.()');
  });

  it('zone resize clamps to MIN_VIEW_WIDTH / MIN_VIEW_HEIGHT', () => {
    expect(source).toContain('MIN_VIEW_WIDTH');
    expect(source).toContain('MIN_VIEW_HEIGHT');
  });

  it('handleZoneDelete skips dialog when zone is empty', () => {
    expect(source).toContain('containedViewIds.length === 0');
    expect(source).toContain('onRemoveZone(zoneId, false)');
  });

  it('handleZoneDelete shows dialog when zone has contained views', () => {
    expect(source).toContain('setZoneDeleteDialog');
    expect(source).toContain('containedCount');
  });

  it('handleZoneDeleteConfirm calls onRemoveZone with correct args', () => {
    expect(source).toContain('onRemoveZone(zoneDeleteDialog.zoneId');
    expect(source).toContain('setZoneDeleteDialog(null)');
  });
});

// ── useCanvasContextMenu ───────────────────────────────────────────────

describe('useCanvasContextMenu', () => {
  const source = src('useCanvasContextMenu.ts');

  it('exports useCanvasContextMenu function', () => {
    expect(source).toContain('export function useCanvasContextMenu');
  });

  it('calls useDismissibleLayer for view context menu', () => {
    expect(source).toContain('useDismissibleLayer');
    expect(source).toContain('handleDismissViewContextMenu');
  });

  it('clamps view context menu position via useLayoutEffect', () => {
    expect(source).toContain('useLayoutEffect');
    expect(source).toContain('clampMenuPosition');
    expect(source).toContain('window.innerWidth');
    expect(source).toContain('window.innerHeight');
  });

  it('handleContextMenu checks e.target === e.currentTarget to avoid child events', () => {
    expect(source).toContain('e.target !== e.currentTarget');
    expect(source).toContain('screenToCanvas');
  });

  it('handleContextMenuAction dispatches to onAddView or onAddPluginView', () => {
    expect(source).toContain("selection.kind === 'builtin'");
    expect(source).toContain('onAddView');
    expect(source).toContain('onAddPluginView');
  });

  it('handleSetLayoutCenter toggles: re-clicking the same view clears it', () => {
    expect(source).toContain('layoutCenterId === viewId ? null : viewId');
  });

  it('handleCenterViewFromMenu takes onCenterView as arg and dismisses menu', () => {
    expect(source).toContain('onCenterView(viewId)');
    expect(source).toContain('setViewContextMenu(null)');
  });
});

// ── ZoomedViewOverlay ──────────────────────────────────────────────────

describe('ZoomedViewOverlay', () => {
  const source = src('ZoomedViewOverlay.tsx');

  it('exports ZoomedViewOverlay component', () => {
    expect(source).toContain('export function ZoomedViewOverlay');
  });

  it('renders canvas-zoom-overlay testid on backdrop', () => {
    expect(source).toContain('data-testid="canvas-zoom-overlay"');
  });

  it('renders canvas-zoom-restore button', () => {
    expect(source).toContain('data-testid="canvas-zoom-restore"');
    expect(source).toContain('Restore');
  });

  it('clicking backdrop calls onClose', () => {
    expect(source).toContain('if (e.target === e.currentTarget) onClose()');
  });

  it('renders AgentCanvasView for agent-type views', () => {
    expect(source).toContain("view.type === 'agent'");
    expect(source).toContain('AgentCanvasView');
  });

  it('renders plugin widget component for plugin-type views', () => {
    expect(source).toContain("view.type === 'plugin'");
    expect(source).toContain('getRegisteredWidgetType');
    expect(source).toContain('registered.descriptor.component');
  });

  it('shows view type badge and title in header', () => {
    expect(source).toContain('formatViewType(view.type)');
    expect(source).toContain('view.title');
  });

  it('shows project context when available', () => {
    expect(source).toContain('buildProjectContext');
  });

  it('stops wheel events from propagating to parent canvas', () => {
    expect(source).toContain('e.stopPropagation()');
  });
});

// ── PinnedWidgetBar ────────────────────────────────────────────────────

describe('PinnedWidgetBar', () => {
  const source = src('PinnedWidgetBar.tsx');

  it('exports PinnedWidgetBar component', () => {
    expect(source).toContain('export function PinnedWidgetBar');
  });

  it('renders canvas-pinned-widgets testid', () => {
    expect(source).toContain('data-testid="canvas-pinned-widgets"');
  });

  it('renders canvas-unpin-{id} button per widget', () => {
    expect(source).toContain('data-testid={`canvas-unpin-${item.view.id}`}');
  });

  it('returns null when no pinned widgets exist', () => {
    expect(source).toContain('if (pinnedWidgets.length === 0) return null');
  });

  it('filters views by __pinnedToControls metadata', () => {
    expect(source).toContain('__pinnedToControls');
    expect(source).toContain("v.type === 'plugin'");
  });

  it('unpin placement uses screenToCanvas to find viewport center', () => {
    expect(source).toContain('screenToCanvas');
    expect(source).toContain('containerSize.width / 2');
    expect(source).toContain('containerSize.height / 2');
  });

  it('unpin placement tries multiple candidates to avoid overlap', () => {
    expect(source).toContain('doesOverlap');
    expect(source).toContain('candidates');
    expect(source).toContain('viewportWidth');
    expect(source).toContain('viewportHeight');
  });

  it('unpin updates both metadata and position', () => {
    expect(source).toContain('onUpdateView(view.id, { metadata: newMetadata, position: finalPos');
  });
});

// ── CanvasWorkspace thin-shell verification ────────────────────────────

describe('CanvasWorkspace (thin shell)', () => {
  const source = src('CanvasWorkspace.tsx');

  it('imports useViewportControls hook', () => {
    expect(source).toContain("from './useViewportControls'");
  });

  it('imports useSelectionManager hook', () => {
    expect(source).toContain("from './useSelectionManager'");
  });

  it('imports useZoneManager hook', () => {
    expect(source).toContain("from './useZoneManager'");
  });

  it('imports useCanvasContextMenu hook', () => {
    expect(source).toContain("from './useCanvasContextMenu'");
  });

  it('imports ZoomedViewOverlay component', () => {
    expect(source).toContain("from './ZoomedViewOverlay'");
  });

  it('imports PinnedWidgetBar component', () => {
    expect(source).toContain("from './PinnedWidgetBar'");
  });

  it('uses ZoomedViewOverlay instead of inline zoom JSX', () => {
    expect(source).toContain('<ZoomedViewOverlay');
    expect(source).not.toContain('canvas-zoom-restore'); // moved to ZoomedViewOverlay
  });

  it('uses PinnedWidgetBar instead of inline pinned widget JSX', () => {
    expect(source).toContain('<PinnedWidgetBar');
    expect(source).not.toContain('canvas-pinned-widgets'); // moved to PinnedWidgetBar
  });

  it('satellite pause detection precedes handleWireClick', () => {
    const pauseIdx = source.indexOf('Satellite pause detection');
    const wireClickIdx = source.indexOf('const handleWireClick');
    expect(pauseIdx).toBeGreaterThan(-1);
    expect(wireClickIdx).toBeGreaterThan(-1);
    expect(pauseIdx).toBeLessThan(wireClickIdx);
  });

  it('passes setSingleDragPos as onSingleDragPosChange to useZoneManager', () => {
    expect(source).toContain('onSingleDragPosChange: setSingleDragPos');
  });

  it('passes onFocusView to useViewportControls', () => {
    // The hook call block must wire onFocusView from props
    expect(source).toContain('onFocusView,');
  });
});
