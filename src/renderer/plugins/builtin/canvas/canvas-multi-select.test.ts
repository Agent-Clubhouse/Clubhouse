import { describe, it, expect, beforeEach } from 'vitest';
import {
  isViewFullyInRect,
  computeTiledPositions,
  snapPosition,
} from './canvas-operations';
import { createCanvasStore } from './canvas-store';
import type { CanvasView } from './canvas-types';
import { GRID_SIZE } from './canvas-types';

// ── Helper to create a minimal view for testing ─────────────────────

function makeView(id: string, x: number, y: number, w = 200, h = 200): CanvasView {
  return {
    id,
    type: 'agent',
    position: { x, y },
    size: { width: w, height: h },
    title: id,
    displayName: id,
    zIndex: 0,
    metadata: {},
    agentId: null,
  } as CanvasView;
}

// ── isViewFullyInRect ───────────────────────────────────────────────

describe('isViewFullyInRect', () => {
  const view = makeView('v1', 100, 100, 200, 200);

  it('returns true when view is fully inside the rect', () => {
    expect(isViewFullyInRect(view, { x: 50, y: 50, width: 300, height: 300 })).toBe(true);
  });

  it('returns true when view exactly matches the rect', () => {
    expect(isViewFullyInRect(view, { x: 100, y: 100, width: 200, height: 200 })).toBe(true);
  });

  it('returns false when view is partially outside (right edge)', () => {
    expect(isViewFullyInRect(view, { x: 50, y: 50, width: 200, height: 300 })).toBe(false);
  });

  it('returns false when view is partially outside (bottom edge)', () => {
    expect(isViewFullyInRect(view, { x: 50, y: 50, width: 300, height: 200 })).toBe(false);
  });

  it('returns false when view is completely outside', () => {
    expect(isViewFullyInRect(view, { x: 500, y: 500, width: 100, height: 100 })).toBe(false);
  });

  it('handles negative-direction rects (drag from bottom-right to top-left)', () => {
    // Rect specified as origin at bottom-right with negative width/height
    expect(isViewFullyInRect(view, { x: 350, y: 350, width: -300, height: -300 })).toBe(true);
  });

  it('rejects partially overlapping views with negative rects', () => {
    expect(isViewFullyInRect(view, { x: 250, y: 250, width: -100, height: -100 })).toBe(false);
  });
});

// ── computeTiledPositions ───────────────────────────────────────────

describe('computeTiledPositions', () => {
  it('returns empty map for no views', () => {
    const result = computeTiledPositions([], { x: 0, y: 0 });
    expect(result.size).toBe(0);
  });

  it('places a single view at the snapped origin', () => {
    const views = [makeView('v1', 500, 500)];
    const result = computeTiledPositions(views, { x: 100, y: 100 });
    expect(result.size).toBe(1);
    const pos = result.get('v1')!;
    expect(pos).toEqual(snapPosition({ x: 100, y: 100 }));
  });

  it('tiles two views side by side', () => {
    const views = [makeView('v1', 0, 0, 200, 200), makeView('v2', 0, 0, 200, 200)];
    const result = computeTiledPositions(views, { x: 0, y: 0 });
    expect(result.size).toBe(2);

    const pos1 = result.get('v1')!;
    const pos2 = result.get('v2')!;
    // 2 items → ceil(sqrt(2)) = 2 columns → same row
    expect(pos1.y).toBe(pos2.y);
    expect(pos2.x).toBeGreaterThan(pos1.x);
  });

  it('tiles four views in a 2×2 grid', () => {
    const views = [
      makeView('v1', 0, 0, 200, 200),
      makeView('v2', 0, 0, 200, 200),
      makeView('v3', 0, 0, 200, 200),
      makeView('v4', 0, 0, 200, 200),
    ];
    const result = computeTiledPositions(views, { x: 0, y: 0 });
    expect(result.size).toBe(4);

    const pos1 = result.get('v1')!;
    const pos2 = result.get('v2')!;
    const pos3 = result.get('v3')!;
    const pos4 = result.get('v4')!;

    // 4 items → 2 columns: [v1, v2] on row 0, [v3, v4] on row 1
    expect(pos1.x).toBe(pos3.x); // same column
    expect(pos2.x).toBe(pos4.x); // same column
    expect(pos1.y).toBe(pos2.y); // same row
    expect(pos3.y).toBe(pos4.y); // same row
    expect(pos3.y).toBeGreaterThan(pos1.y); // row 1 below row 0
  });

  it('respects gap parameter', () => {
    const views = [makeView('v1', 0, 0, 200, 200), makeView('v2', 0, 0, 200, 200)];
    const gap = 40;
    const result = computeTiledPositions(views, { x: 0, y: 0 }, gap);
    const pos1 = result.get('v1')!;
    const pos2 = result.get('v2')!;

    // Second column starts at: colWidths[0] + gap = 200 + 40 = 240 → snapped to 240
    expect(pos2.x - pos1.x).toBe(snapPosition({ x: 200 + gap, y: 0 }).x);
  });

  it('handles views of different sizes', () => {
    const views = [
      makeView('v1', 0, 0, 300, 200),
      makeView('v2', 0, 0, 200, 400),
      makeView('v3', 0, 0, 300, 200),
      makeView('v4', 0, 0, 200, 400),
    ];
    const result = computeTiledPositions(views, { x: 0, y: 0 });

    // Column 0 max width: max(300, 300) = 300
    // Column 1 offset: 300 + GRID_SIZE = 320
    const pos2 = result.get('v2')!;
    expect(pos2.x).toBe(snapPosition({ x: 300 + GRID_SIZE, y: 0 }).x);
  });

  it('snaps all positions to grid', () => {
    const views = [makeView('v1', 0, 0, 213, 200), makeView('v2', 0, 0, 200, 200)];
    const result = computeTiledPositions(views, { x: 3, y: 7 });

    for (const pos of result.values()) {
      expect(pos.x % GRID_SIZE).toBe(0);
      expect(pos.y % GRID_SIZE).toBe(0);
    }
  });
});

// ── Store multi-select actions ──────────────────────────────────────

describe('canvas-store multi-select', () => {
  let store: ReturnType<typeof createCanvasStore>;

  beforeEach(() => {
    store = createCanvasStore();
  });

  it('starts with empty selectedViewIds', () => {
    expect(store.getState().selectedViewIds).toEqual([]);
  });

  it('toggleSelectView adds a view', () => {
    const id = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().toggleSelectView(id);
    expect(store.getState().selectedViewIds).toEqual([id]);
  });

  it('toggleSelectView removes a view on second call', () => {
    const id = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().toggleSelectView(id);
    store.getState().toggleSelectView(id);
    expect(store.getState().selectedViewIds).toEqual([]);
  });

  it('toggleSelectView supports multiple views', () => {
    const id1 = store.getState().addView('agent', { x: 0, y: 0 });
    const id2 = store.getState().addView('file', { x: 200, y: 0 });
    store.getState().toggleSelectView(id1);
    store.getState().toggleSelectView(id2);
    expect(store.getState().selectedViewIds).toEqual([id1, id2]);
  });

  it('setSelectedViewIds replaces the selection', () => {
    const id1 = store.getState().addView('agent', { x: 0, y: 0 });
    const id2 = store.getState().addView('file', { x: 200, y: 0 });
    store.getState().setSelectedViewIds([id1, id2]);
    expect(store.getState().selectedViewIds).toEqual([id1, id2]);

    store.getState().setSelectedViewIds([id1]);
    expect(store.getState().selectedViewIds).toEqual([id1]);
  });

  it('clearSelection clears both selectedViewIds and selectedViewId', () => {
    const id = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().selectView(id);
    store.getState().toggleSelectView(id);
    expect(store.getState().selectedViewId).toBe(id);
    expect(store.getState().selectedViewIds).toEqual([id]);

    store.getState().clearSelection();
    expect(store.getState().selectedViewId).toBeNull();
    expect(store.getState().selectedViewIds).toEqual([]);
  });

  it('moveViews updates positions of multiple views', () => {
    const id1 = store.getState().addView('agent', { x: 0, y: 0 });
    const id2 = store.getState().addView('file', { x: 200, y: 0 });
    const id3 = store.getState().addView('browser', { x: 400, y: 0 });

    const positions = new Map<string, { x: number; y: number }>([
      [id1, { x: 100, y: 100 }],
      [id2, { x: 300, y: 100 }],
    ]);

    store.getState().moveViews(positions);

    const views = store.getState().views;
    expect(views.find((v) => v.id === id1)!.position).toEqual({ x: 100, y: 100 });
    expect(views.find((v) => v.id === id2)!.position).toEqual({ x: 300, y: 100 });
    // id3 should be unchanged
    expect(views.find((v) => v.id === id3)!.position).toEqual({ x: 400, y: 0 });
  });

  it('moveViews clamps positions to canvas bounds', () => {
    const id = store.getState().addView('agent', { x: 0, y: 0 });
    const positions = new Map([[id, { x: 999999, y: -999999 }]]);

    store.getState().moveViews(positions);

    const pos = store.getState().views[0].position;
    expect(pos.x).toBeLessThanOrEqual(20000);
    expect(pos.y).toBeGreaterThanOrEqual(-20000);
  });

  it('selectedViewIds is not persisted to storage', async () => {
    const dataStore = new Map<string, unknown>();
    const storage = {
      read: async (key: string) => dataStore.get(key) ?? undefined,
      write: async (key: string, value: unknown) => { dataStore.set(key, value); },
      delete: async (key: string) => { dataStore.delete(key); },
      list: async () => [...dataStore.keys()],
    };

    await store.getState().loadCanvas(storage as any);
    const id = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().setSelectedViewIds([id]);
    await store.getState().saveCanvas(storage as any);

    // Load into a fresh store — selectedViewIds should be empty
    const store2 = createCanvasStore();
    await store2.getState().loadCanvas(storage as any);
    expect(store2.getState().selectedViewIds).toEqual([]);
  });
});
