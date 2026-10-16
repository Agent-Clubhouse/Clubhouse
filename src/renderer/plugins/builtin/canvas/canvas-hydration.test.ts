/**
 * Hydration safety: autosave rewrites the primary AND the backup shortly after
 * every load, so a load that produced the wrong state used to destroy every
 * recovery copy. These tests pin that a failed or degraded hydration never
 * persists over data it could not (fully) read.
 */
import { describe, it, expect, vi } from 'vitest';
import { createCanvasStore } from './canvas-store';
import type { ScopedStorage } from '../../../../shared/plugin-types';

const card = (id: string) => ({
  id,
  type: 'agent',
  position: { x: 10, y: 20 },
  size: { width: 400, height: 300 },
  title: id,
  zIndex: 1,
  agentId: `durable_${id}`,
});

const canvasWith = (...views: unknown[]) => [{
  id: 'canvas_1',
  name: 'goobers-bridge',
  views,
  viewport: { panX: 0, panY: 0, zoom: 1 },
  nextZIndex: views.length,
}];

function eacces(): NodeJS.ErrnoException {
  return Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
}

/** Map-backed storage; reads of a key throw EACCES while `failReads(key)` returns true. */
function createStorage(data: Record<string, unknown>, failReads: (key: string) => boolean = () => false) {
  const map = new Map<string, unknown>(Object.entries(data));
  const storage: ScopedStorage = {
    read: vi.fn(async (key: string) => {
      if (failReads(key)) throw eacces();
      return map.get(key) ?? undefined;
    }),
    write: vi.fn(async (key: string, value: unknown) => { map.set(key, value); }),
    delete: vi.fn(async (key: string) => { map.delete(key); }),
    list: vi.fn(async () => [...map.keys()]),
  };
  return { map, storage };
}

describe('canvas hydration safety', () => {
  it('rides out a transiently unreadable storage directory instead of loading empty', async () => {
    let failures = 2;
    const { storage } = createStorage(
      { 'canvas-instances': canvasWith(card('a'), card('b')) },
      (key) => key === 'canvas-instances' && failures-- > 0,
    );
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);

    expect(store.getState().loaded).toBe(true);
    expect(store.getState().loadError).toBeNull();
    expect(store.getState().views.map((v) => v.id)).toEqual(['a', 'b']);
  });

  it('stays unloaded and never writes when the canvas stays unreadable', async () => {
    const original = canvasWith(card('a'));
    const { map, storage } = createStorage(
      { 'canvas-instances': original, 'canvas-instances-backup': original },
      (key) => key.startsWith('canvas-instances'),
    );
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);

    expect(store.getState().loaded).toBe(false);
    expect(store.getState().loadError).toMatch(/could not be read/);

    // Autosave (or any explicit save) must be refused.
    await store.getState().saveCanvas(storage);
    // Inserting a canvas (blueprint import / hub upgrade) must not save either.
    await expect(
      store.getState().loadAndInsertCanvas(
        { ...store.getState().canvases[0], id: 'canvas_new' },
        storage,
      ),
    ).rejects.toThrow(/could not be read/);

    expect(storage.write).not.toHaveBeenCalled();
    expect(map.get('canvas-instances')).toBe(original);
    expect(map.get('canvas-instances-backup')).toBe(original);
  });

  it('recovers on retry once storage becomes readable again', async () => {
    let unreadable = true;
    const { storage } = createStorage(
      { 'canvas-instances': canvasWith(card('a')) },
      (key) => unreadable && key.startsWith('canvas-instances'),
    );
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    expect(store.getState().loaded).toBe(false);

    unreadable = false;
    await store.getState().loadCanvas(storage);
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().loadError).toBeNull();
    expect(store.getState().views.map((v) => v.id)).toEqual(['a']);
  });

  it('does not overwrite data that reappears after an empty (missing) load', async () => {
    // The directory read as absent during load (e.g. briefly unmounted)…
    const { map, storage } = createStorage({});
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().views).toHaveLength(0);

    // …and is back by the time the debounced autosave runs.
    const original = canvasWith(card('a'), card('b'));
    map.set('canvas-instances', original);
    map.set('canvas-instances-backup', original);

    await store.getState().saveCanvas(storage);

    expect(storage.write).not.toHaveBeenCalled();
    expect(map.get('canvas-instances')).toBe(original);
    // The real canvas is reloaded instead.
    expect(store.getState().views.map((v) => v.id)).toEqual(['a', 'b']);

    // Subsequent saves proceed normally.
    await store.getState().saveCanvas(storage);
    expect((map.get('canvas-instances') as any[])[0].views).toHaveLength(2);
  });

  it('a genuinely fresh canvas still persists', async () => {
    const { map, storage } = createStorage({});
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    store.getState().addView('agent', { x: 0, y: 0 });
    await store.getState().saveCanvas(storage);

    expect((map.get('canvas-instances') as any[])[0].views).toHaveLength(1);
    expect((map.get('canvas-instances-backup') as any[])[0].views).toHaveLength(1);
  });

  it('drops a null view but keeps the valid card, preserving the raw data before saving', async () => {
    const raw = canvasWith(null, card('a'));
    const { map, storage } = createStorage({ 'canvas-instances': raw, 'canvas-instances-backup': raw });
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);

    expect(store.getState().loaded).toBe(true);
    expect(store.getState().views.map((v) => v.id)).toEqual(['a']);

    const order: string[] = [];
    (storage.write as any).mockImplementation(async (key: string, value: unknown) => {
      order.push(key);
      map.set(key, value);
    });
    await store.getState().saveCanvas(storage);

    const recoveryKey = order.find((k) => k.startsWith('canvas-instances-recovery-'));
    expect(recoveryKey).toBeDefined();
    expect(map.get(recoveryKey!)).toEqual(raw);
    // Snapshot lands before either rotating copy is touched.
    expect(order.indexOf(recoveryKey!)).toBeLessThan(order.indexOf('canvas-instances-backup'));
    expect((map.get('canvas-instances') as any[])[0].views.map((v: any) => v.id)).toEqual(['a']);

    // Only the first save after a degraded load snapshots.
    order.length = 0;
    await store.getState().saveCanvas(storage);
    expect(order.some((k) => k.startsWith('canvas-instances-recovery-'))).toBe(false);
  });

  it('prefers a healthy backup over a degraded primary instead of overwriting it', async () => {
    const healthy = canvasWith(card('a'), card('b'));
    const { map, storage } = createStorage({
      'canvas-instances': canvasWith(null, card('a')),
      'canvas-instances-backup': healthy,
    });
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);

    expect(store.getState().views.map((v) => v.id)).toEqual(['a', 'b']);
    await store.getState().saveCanvas(storage);
    expect((map.get('canvas-instances-backup') as any[])[0].views.map((v: any) => v.id)).toEqual(['a', 'b']);
    expect((map.get('canvas-instances') as any[])[0].views.map((v: any) => v.id)).toEqual(['a', 'b']);
  });

  it('a failed active-canvas read does not empty the load', async () => {
    const { storage } = createStorage(
      { 'canvas-instances': canvasWith(card('a')), 'canvas-active-id': 'canvas_1' },
      (key) => key === 'canvas-active-id',
    );
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);

    expect(store.getState().loaded).toBe(true);
    expect(store.getState().activeCanvasId).toBe('canvas_1');
    expect(store.getState().views.map((v) => v.id)).toEqual(['a']);
  });

  it('does not overwrite zone wires that could not be read', async () => {
    const zoneWires = [{ id: 'zw_1', sourceZoneId: 'z1', targetId: 'durable_a', targetType: 'agent' }];
    const { map, storage } = createStorage(
      { 'canvas-instances': canvasWith(card('a')), 'canvas-zone-wires': zoneWires },
      (key) => key === 'canvas-zone-wires',
    );
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    expect(store.getState().loaded).toBe(true);

    await store.getState().saveCanvas(storage);
    expect(storage.write).not.toHaveBeenCalledWith('canvas-zone-wires', expect.anything());
    expect(map.get('canvas-zone-wires')).toBe(zoneWires);
  });

  it('does not overwrite wires that could not be read', async () => {
    const wires = [{ agentId: 'durable_a', targetId: 'durable_b', targetKind: 'agent', label: 'B' }];
    const { map, storage } = createStorage(
      { 'canvas-instances': canvasWith(card('a')), 'canvas-wires': wires },
      (key) => key === 'canvas-wires',
    );
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    await store.getState().loadWires(storage);

    // Canvas autosave isn't held up…
    expect(store.getState().wiresLoaded).toBe(true);
    // …but the empty in-memory wire list is never persisted over the real one.
    await store.getState().saveWires(storage);
    expect(storage.write).not.toHaveBeenCalledWith('canvas-wires', expect.anything());
    expect(map.get('canvas-wires')).toBe(wires);
  });

  it('refuses to save a store that was never hydrated from storage', async () => {
    const { storage } = createStorage({ 'canvas-instances': canvasWith(card('a')) });
    const store = createCanvasStore();
    await store.getState().saveCanvas(storage);
    expect(storage.write).not.toHaveBeenCalled();
  });
});
