import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCanvasStore } from './canvas-store';
import type { ScopedStorage } from '../../../../shared/plugin-types';

function createMockStorage(data: Record<string, unknown> = {}): ScopedStorage {
  const store = new Map<string, unknown>(Object.entries(data));
  return {
    read: vi.fn(async (key: string) => store.get(key) ?? undefined),
    write: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async () => [...store.keys()]),
  };
}

describe('canvas-store', () => {
  let store: ReturnType<typeof createCanvasStore>;

  beforeEach(() => {
    store = createCanvasStore();
  });

  it('starts with one canvas and no views', () => {
    const state = store.getState();
    expect(state.canvases).toHaveLength(1);
    expect(state.views).toHaveLength(0);
    expect(state.loaded).toBe(false);
  });

  it('loads fresh canvas from empty storage', async () => {
    const storage = createMockStorage();
    await store.getState().loadCanvas(storage);
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().canvases).toHaveLength(1);
  });

  it('saves and loads canvas state round-trip', async () => {
    const storage = createMockStorage();
    await store.getState().loadCanvas(storage);

    // Add a view
    store.getState().addView('agent', { x: 100, y: 200 });
    expect(store.getState().views).toHaveLength(1);

    // Save
    await store.getState().saveCanvas(storage);

    // Create new store and load
    const store2 = createCanvasStore();
    await store2.getState().loadCanvas(storage);

    expect(store2.getState().loaded).toBe(true);
    expect(store2.getState().views).toHaveLength(1);
    expect(store2.getState().views[0].type).toBe('agent');
  });

  // ── Canvas tab management ──────────────────────────────────────

  it('adds a new canvas', () => {
    const id = store.getState().addCanvas();
    expect(store.getState().canvases).toHaveLength(2);
    expect(store.getState().activeCanvasId).toBe(id);
  });

  it('removes a canvas', () => {
    const id = store.getState().addCanvas();
    expect(store.getState().canvases).toHaveLength(2);
    store.getState().removeCanvas(id);
    expect(store.getState().canvases).toHaveLength(1);
  });

  it('resets when removing the last canvas', () => {
    const original = store.getState().canvases[0].id;
    store.getState().removeCanvas(original);
    expect(store.getState().canvases).toHaveLength(1);
    expect(store.getState().canvases[0].id).not.toBe(original);
  });

  it('renames a canvas', () => {
    const id = store.getState().canvases[0].id;
    store.getState().renameCanvas(id, 'My Canvas');
    expect(store.getState().canvases[0].name).toBe('My Canvas');
  });

  it('switches active canvas', () => {
    const id1 = store.getState().canvases[0].id;
    const id2 = store.getState().addCanvas();

    // Should have switched to id2
    expect(store.getState().activeCanvasId).toBe(id2);

    // Switch back
    store.getState().setActiveCanvas(id1);
    expect(store.getState().activeCanvasId).toBe(id1);
  });

  // ── View operations ────────────────────────────────────────────

  it('adds and removes views', () => {
    const viewId = store.getState().addView('agent', { x: 100, y: 200 });
    expect(store.getState().views).toHaveLength(1);
    expect(store.getState().views[0].id).toBe(viewId);

    store.getState().removeView(viewId);
    expect(store.getState().views).toHaveLength(0);
  });

  it('moves a view', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().moveView(viewId, { x: 300, y: 400 });
    expect(store.getState().views[0].position).toEqual({ x: 300, y: 400 });
  });

  it('resizes a view', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().resizeView(viewId, { width: 600, height: 500 });
    expect(store.getState().views[0].size).toEqual({ width: 600, height: 500 });
  });

  it('renames a view', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().renameView(viewId, 'My Agent');
    expect(store.getState().views[0].title).toBe('My Agent');
  });

  it('focuses a view (brings to front)', () => {
    const id1 = store.getState().addView('agent', { x: 0, y: 0 });
    const id2 = store.getState().addView('agent', { x: 200, y: 200 });

    // id2 should have higher zIndex initially
    const z1Before = store.getState().views.find((v) => v.id === id1)!.zIndex;
    const z2Before = store.getState().views.find((v) => v.id === id2)!.zIndex;
    expect(z2Before).toBeGreaterThan(z1Before);

    // Focus id1
    store.getState().focusView(id1);
    const z1After = store.getState().views.find((v) => v.id === id1)!.zIndex;
    const z2After = store.getState().views.find((v) => v.id === id2)!.zIndex;
    expect(z1After).toBeGreaterThan(z2After);
  });

  it('updates arbitrary view fields', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().updateView(viewId, { displayName: 'Custom Name' });
    expect(store.getState().views[0].displayName).toBe('Custom Name');
  });

  // ── Viewport ───────────────────────────────────────────────────

  it('updates viewport', () => {
    store.getState().setViewport({ panX: -100, panY: -200, zoom: 1.5 });
    expect(store.getState().viewport).toEqual({ panX: -100, panY: -200, zoom: 1.5 });
  });

  it('clamps viewport zoom', () => {
    store.getState().setViewport({ panX: 0, panY: 0, zoom: 10 });
    expect(store.getState().viewport.zoom).toBe(2.0);
  });

  // ── Zoom view ───────────────────────────────────────────────────

  it('starts with no zoomed view', () => {
    expect(store.getState().zoomedViewId).toBeNull();
  });

  it('zooms a view', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().zoomView(viewId);
    expect(store.getState().zoomedViewId).toBe(viewId);
  });

  it('unzooms a view', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().zoomView(viewId);
    store.getState().zoomView(null);
    expect(store.getState().zoomedViewId).toBeNull();
  });

  it('zoomed view is per-canvas', () => {
    const canvas1 = store.getState().canvases[0].id;
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().zoomView(viewId);
    expect(store.getState().zoomedViewId).toBe(viewId);

    // Switch to new canvas — zoomed should be null
    store.getState().addCanvas();
    expect(store.getState().zoomedViewId).toBeNull();

    // Switch back — should still be zoomed
    store.getState().setActiveCanvas(canvas1);
    expect(store.getState().zoomedViewId).toBe(viewId);
  });

  // ── Canvas isolation ───────────────────────────────────────────

  it('views are isolated per canvas', () => {
    const id1 = store.getState().canvases[0].id;
    store.getState().addView('agent', { x: 0, y: 0 });
    expect(store.getState().views).toHaveLength(1);

    store.getState().addCanvas();
    // New canvas should have no views
    expect(store.getState().views).toHaveLength(0);

    store.getState().addView('agent', { x: 100, y: 100 });
    expect(store.getState().views).toHaveLength(1);

    // Switch back — should have original view
    store.getState().setActiveCanvas(id1);
    expect(store.getState().views).toHaveLength(1);
    expect(store.getState().views[0].type).toBe('agent');
  });
});
