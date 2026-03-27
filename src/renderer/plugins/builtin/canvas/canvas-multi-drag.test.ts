import { describe, it, expect, beforeEach } from 'vitest';
import { createCanvasStore } from './canvas-store';
import { snapPosition } from './canvas-operations';
import type { Position } from './canvas-types';

// ── Helper ───────────────────────────────────────────────────────────

function makeStore() {
  const store = createCanvasStore();
  const id1 = store.getState().addView('agent', { x: 100, y: 100 });
  const id2 = store.getState().addView('agent', { x: 400, y: 100 });
  const id3 = store.getState().addView('anchor', { x: 100, y: 400 });
  return { store, id1, id2, id3 };
}

// ── Multi-drag: relative position preservation ───────────────────────

describe('multi-drag relative position preservation', () => {
  let store: ReturnType<typeof createCanvasStore>;
  let id1: string, id2: string, id3: string;

  beforeEach(() => {
    ({ store, id1, id2, id3 } = makeStore());
  });

  it('moveViews applies a uniform delta to all selected views', () => {
    const views = store.getState().views;
    const v1 = views.find((v) => v.id === id1)!;
    const v2 = views.find((v) => v.id === id2)!;

    // Simulate a drag delta of (60, 40)
    const dx = 60;
    const dy = 40;
    const positions = new Map<string, Position>();
    positions.set(id1, snapPosition({ x: v1.position.x + dx, y: v1.position.y + dy }));
    positions.set(id2, snapPosition({ x: v2.position.x + dx, y: v2.position.y + dy }));

    store.getState().moveViews(positions);

    const after = store.getState().views;
    const a1 = after.find((v) => v.id === id1)!;
    const a2 = after.find((v) => v.id === id2)!;
    const a3 = after.find((v) => v.id === id3)!;

    // Both selected views moved by the snapped delta
    expect(a1.position).toEqual(snapPosition({ x: 100 + dx, y: 100 + dy }));
    expect(a2.position).toEqual(snapPosition({ x: 400 + dx, y: 100 + dy }));

    // Unselected view unchanged
    expect(a3.position).toEqual({ x: 100, y: 400 });
  });

  it('preserves relative distance between views after move', () => {
    const views = store.getState().views;
    const v1 = views.find((v) => v.id === id1)!;
    const v2 = views.find((v) => v.id === id2)!;

    const relativeX = v2.position.x - v1.position.x;
    const relativeY = v2.position.y - v1.position.y;

    const dx = 200;
    const dy = 100;
    const positions = new Map<string, Position>();
    positions.set(id1, snapPosition({ x: v1.position.x + dx, y: v1.position.y + dy }));
    positions.set(id2, snapPosition({ x: v2.position.x + dx, y: v2.position.y + dy }));

    store.getState().moveViews(positions);

    const after = store.getState().views;
    const a1 = after.find((v) => v.id === id1)!;
    const a2 = after.find((v) => v.id === id2)!;

    const newRelativeX = a2.position.x - a1.position.x;
    const newRelativeY = a2.position.y - a1.position.y;

    expect(newRelativeX).toBe(relativeX);
    expect(newRelativeY).toBe(relativeY);
  });
});

// ── Multi-drag: selection clearing after drop ────────────────────────

describe('multi-drag selection clearing', () => {
  let store: ReturnType<typeof createCanvasStore>;
  let id1: string, id2: string;

  beforeEach(() => {
    ({ store, id1, id2 } = makeStore());
  });

  it('clearSelection empties selectedViewIds after moveViews', () => {
    // Simulate multi-select
    store.getState().setSelectedViewIds([id1, id2]);
    expect(store.getState().selectedViewIds).toEqual([id1, id2]);

    // Simulate drop: move views then clear selection (as workspace handler does)
    const positions = new Map<string, Position>();
    positions.set(id1, { x: 200, y: 200 });
    positions.set(id2, { x: 500, y: 200 });
    store.getState().moveViews(positions);
    store.getState().clearSelection();

    expect(store.getState().selectedViewIds).toEqual([]);
    expect(store.getState().selectedViewId).toBeNull();
  });

  it('clearSelection also clears focused selectedViewId', () => {
    store.getState().selectView(id1);
    store.getState().setSelectedViewIds([id1, id2]);
    expect(store.getState().selectedViewId).toBe(id1);

    store.getState().clearSelection();
    expect(store.getState().selectedViewId).toBeNull();
  });
});

// ── dragOffset computation ───────────────────────────────────────────

describe('dragOffset computation for multi-drag', () => {
  /**
   * Mirrors the computation in CanvasWorkspace:
   *   Non-primary selected views during multi-drag receive a dragOffset
   *   equal to multiDragDelta so they visually move with the primary view.
   */
  function computeDragOffset(
    multiDragActive: boolean,
    dragViewId: string | null,
    selectedViewIds: string[],
    viewId: string,
    delta: { dx: number; dy: number },
  ): { dx: number; dy: number } | undefined {
    if (multiDragActive && selectedViewIds.includes(viewId) && viewId !== dragViewId) {
      return delta;
    }
    return undefined;
  }

  it('returns undefined when no multi-drag is active', () => {
    expect(computeDragOffset(false, null, ['v1', 'v2'], 'v1', { dx: 10, dy: 20 })).toBeUndefined();
  });

  it('returns undefined for the primary drag view', () => {
    expect(computeDragOffset(true, 'v1', ['v1', 'v2'], 'v1', { dx: 10, dy: 20 })).toBeUndefined();
  });

  it('returns the delta for non-primary selected views during multi-drag', () => {
    const delta = { dx: 50, dy: 30 };
    expect(computeDragOffset(true, 'v1', ['v1', 'v2'], 'v2', delta)).toEqual(delta);
  });

  it('returns undefined for views not in the selection', () => {
    expect(computeDragOffset(true, 'v1', ['v1', 'v2'], 'v3', { dx: 10, dy: 20 })).toBeUndefined();
  });

  it('returns the delta for all non-primary views in a 3-item selection', () => {
    const delta = { dx: 100, dy: 50 };
    expect(computeDragOffset(true, 'v1', ['v1', 'v2', 'v3'], 'v2', delta)).toEqual(delta);
    expect(computeDragOffset(true, 'v1', ['v1', 'v2', 'v3'], 'v3', delta)).toEqual(delta);
  });
});

// ── Zone drag offset computation ────────────────────────────────────

describe('dragOffset computation for zone drag', () => {
  function computeZoneDragOffset(
    zoneDrag: { zoneId: string; containedViewIds: string[] } | null,
    viewId: string,
    delta: { dx: number; dy: number },
  ): { dx: number; dy: number } | undefined {
    if (zoneDrag && zoneDrag.containedViewIds.includes(viewId)) {
      return delta;
    }
    return undefined;
  }

  it('returns undefined when no zone drag is active', () => {
    expect(computeZoneDragOffset(null, 'v1', { dx: 10, dy: 20 })).toBeUndefined();
  });

  it('returns the delta for contained views during zone drag', () => {
    const delta = { dx: 60, dy: 40 };
    expect(computeZoneDragOffset({ zoneId: 'z1', containedViewIds: ['v1', 'v2'] }, 'v1', delta)).toEqual(delta);
    expect(computeZoneDragOffset({ zoneId: 'z1', containedViewIds: ['v1', 'v2'] }, 'v2', delta)).toEqual(delta);
  });

  it('returns undefined for views not contained in the dragged zone', () => {
    expect(computeZoneDragOffset({ zoneId: 'z1', containedViewIds: ['v1'] }, 'v2', { dx: 10, dy: 20 })).toBeUndefined();
  });
});
