import { describe, it, expect, beforeEach } from 'vitest';
import { createCanvasStore } from './canvas-store';

describe('canvas selection', () => {
  let store: ReturnType<typeof createCanvasStore>;

  beforeEach(() => {
    store = createCanvasStore();
  });

  it('starts with no selected view', () => {
    expect(store.getState().selectedViewId).toBeNull();
  });

  it('selects a view', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().selectView(viewId);
    expect(store.getState().selectedViewId).toBe(viewId);
  });

  it('deselects by passing null', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().selectView(viewId);
    store.getState().selectView(null);
    expect(store.getState().selectedViewId).toBeNull();
  });

  it('selecting a view brings it to front (increases zIndex)', () => {
    const id1 = store.getState().addView('agent', { x: 0, y: 0 });
    const id2 = store.getState().addView('agent', { x: 100, y: 0 });

    const z1Before = store.getState().views.find((v) => v.id === id1)!.zIndex;
    store.getState().selectView(id1);
    const z1After = store.getState().views.find((v) => v.id === id1)!.zIndex;

    expect(z1After).toBeGreaterThan(z1Before);
    // id1 should now be above id2
    const z2 = store.getState().views.find((v) => v.id === id2)!.zIndex;
    expect(z1After).toBeGreaterThan(z2);
  });

  it('clears selection when the selected view is removed', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().selectView(viewId);
    expect(store.getState().selectedViewId).toBe(viewId);

    store.getState().removeView(viewId);
    expect(store.getState().selectedViewId).toBeNull();
  });

  it('preserves selection when a different view is removed', () => {
    const id1 = store.getState().addView('agent', { x: 0, y: 0 });
    const id2 = store.getState().addView('agent', { x: 100, y: 0 });

    store.getState().selectView(id1);
    store.getState().removeView(id2);
    expect(store.getState().selectedViewId).toBe(id1);
  });

  it('switching canvases resets selection via syncDerivedState', () => {
    const canvas1Id = store.getState().activeCanvasId;
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().selectView(viewId);
    expect(store.getState().selectedViewId).toBe(viewId);

    // Add and switch to a new canvas
    const canvas2Id = store.getState().addCanvas();
    expect(store.getState().activeCanvasId).toBe(canvas2Id);
    expect(store.getState().selectedViewId).toBeNull();

    // Switch back — selection should still be there
    store.getState().setActiveCanvas(canvas1Id);
    expect(store.getState().selectedViewId).toBe(viewId);
  });

  it('selectedViewId is not persisted to storage', async () => {
    const dataStore = new Map<string, unknown>();
    const storage = {
      read: async (key: string) => dataStore.get(key) ?? undefined,
      write: async (key: string, value: unknown) => { dataStore.set(key, value); },
      delete: async (key: string) => { dataStore.delete(key); },
      list: async () => [...dataStore.keys()],
    };

    await store.getState().loadCanvas(storage as any);
    store.getState().addView('agent', { x: 0, y: 0 });
    const viewId = store.getState().views[0].id;
    store.getState().selectView(viewId);

    await store.getState().saveCanvas(storage as any);

    // Load into a fresh store — selection should be null
    const store2 = createCanvasStore();
    await store2.getState().loadCanvas(storage as any);
    expect(store2.getState().selectedViewId).toBeNull();
  });
});
