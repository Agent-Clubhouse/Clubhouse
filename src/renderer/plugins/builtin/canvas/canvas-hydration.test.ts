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

  it.each(['canvas-instances', 'canvas-instances-backup'])(
    'rejects a failed empty-canvas confirmation of %s without writing, then retries', async (failedKey) => {
      let failing = false;
      const { map, storage } = createStorage({}, (key) => failing && key === failedKey);
      const store = createCanvasStore();
      await store.getState().loadCanvas(storage);
      store.getState().addView('agent', { x: 123, y: 456 });
      const edits = store.getState().canvases;

      failing = true;
      await expect(store.getState().saveCanvas(storage)).rejects.toThrow('EACCES');
      expect(storage.write).not.toHaveBeenCalled();
      expect(store.getState().canvases).toBe(edits);

      failing = false;
      await store.getState().saveCanvas(storage);
      expect(map.get('canvas-instances')).toEqual(map.get('canvas-instances-backup'));
      expect((map.get('canvas-instances') as any[])[0].views).toEqual(edits[0].views);
    },
  );

  it.each(['canvas-instances', 'canvas-instances-backup'])('reloads data that reappears in %s after an empty load without overwriting it', async (key) => {
    // The directory read as absent during load (e.g. briefly unmounted)…
    const { map, storage } = createStorage({});
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().views).toHaveLength(0);

    // …and is back by the time the debounced autosave runs.
    const original = canvasWith(card('a'), card('b'));
    store.getState().addView('agent', { x: 123, y: 456 });
    map.set(key, original);

    await store.getState().saveCanvas(storage);

    expect(storage.write).not.toHaveBeenCalled();
    expect(map.get(key)).toBe(original);
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

  it.each(['canvas-wires', 'canvas-zone-wires'])(
    'rejects pending edits after an unreadable %s load without writing, and reopens after a successful re-read', async (key) => {
      const original = [{ agentId: 'durable_a', targetId: 'durable_b', targetKind: 'agent', label: 'B' }];
      const originalZones = [{ id: 'zw_1', sourceZoneId: 'z1', targetId: 'durable_a', targetType: 'agent' }];
      let unreadable = true;
      const { map, storage } = createStorage({
        'canvas-instances': canvasWith(card('a'), card('b')),
        'canvas-wires': original,
        'canvas-zone-wires': originalZones,
      }, (k) => unreadable && k === key);
      const store = createCanvasStore();
      await store.getState().loadCanvas(storage);
      await store.getState().loadWires(storage);
      const edit = () => {
        if (key === 'canvas-wires') {
          store.getState().addWireDefinition({ agentId: 'durable_b', targetId: 'durable_a', targetKind: 'agent', label: 'A' });
        } else {
          store.getState().addZoneWireDefinition({ sourceZoneId: 'z2', targetId: 'durable_b', targetType: 'agent' });
        }
      };
      const save = () => key === 'canvas-wires' ? store.getState().saveWires(storage) : store.getState().saveCanvas(storage);
      // No-op removals create fresh arrays but do not create pending edits.
      if (key === 'canvas-wires') store.getState().removeWireDefinition('missing', 'missing');
      else store.getState().removeZoneWireDefinition('missing');
      await save();
      vi.mocked(storage.write).mockClear();
      edit();
      await expect(save()).rejects.toThrow(/changes not saved.*could not be read/);
      expect(storage.write).not.toHaveBeenCalled();
      expect(map.get('canvas-wires')).toBe(original);
      expect(map.get('canvas-zone-wires')).toBe(originalZones);
      if (key === 'canvas-wires') {
        await store.getState().loadWires(storage);
        await expect(save()).rejects.toThrow(/changes not saved.*could not be read/);
      }

      unreadable = false;
      await store.getState().loadCanvas(storage);
      await store.getState().loadWires(storage);
      edit();
      await save();
      expect(map.get(key)).toHaveLength(2);
      expect(storage.delete).not.toHaveBeenCalled();
    },
  );

  it('keeps remote-owned wire and zone-wire saves silent even with edits', async () => {
    const { storage } = createStorage({});
    const store = createCanvasStore();
    store.getState().hydrateFromRemote(canvasWith(card('remote')), 'canvas_1', [], []);
    store.getState().addWireDefinition({ agentId: 'remote-a', targetId: 'remote-b', targetKind: 'agent', label: 'B' });
    store.getState().addZoneWireDefinition({ sourceZoneId: 'remote-zone', targetId: 'remote-a', targetType: 'agent' });
    await expect(store.getState().saveCanvas(storage)).resolves.toBeUndefined();
    await expect(store.getState().saveWires(storage)).resolves.toBeUndefined();
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('keeps a newer local disk version and puts all retained edits in a separate recovery bundle', async () => {
    const original = canvasWith(card('original'));
    const { map, storage } = createStorage({ 'canvas-instances': original });
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    await store.getState().loadWires(storage);
    store.getState().addView('agent', { x: 1, y: 2 });
    store.getState().addWireDefinition({ agentId: 'local-a', targetId: 'local-b', targetKind: 'agent', label: 'B' });
    store.getState().addZoneWireDefinition({ sourceZoneId: 'local-zone', targetId: 'local-a', targetType: 'agent' });
    store.setState({ autosaveFailed: true });
    const retained = store.getState();
    store.getState().hydrateFromRemote([{ ...original[0], id: 'remote', views: [] }], 'remote', [], []);
    const newer = canvasWith(card('newer-disk-card'));
    map.set('canvas-instances', newer);
    map.set('canvas-instances-backup', newer);
    vi.mocked(storage.write).mockClear();

    expect(await store.getState().restoreFailedLocalState(storage)).toBe(true);
    expect(store.getState().views.map((v) => v.id)).toEqual(['newer-disk-card']);
    expect(store.getState().unsavedRecoveryCopy).toBe(true);
    const keys = [...map.keys()].filter((key) => key.startsWith('canvas-unsaved-copy-'));
    expect(keys).toHaveLength(1);
    expect(map.get(keys[0])).toEqual({
      version: 1, canvases: retained.canvases, activeCanvasId: retained.activeCanvasId,
      wireDefinitions: retained.wireDefinitions, zoneWireDefinitions: retained.zoneWireDefinitions,
    });
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(map.get('canvas-instances')).toBe(newer);
    expect(map.get('canvas-instances-backup')).toBe(newer);
    await store.getState().saveCanvas(storage);
    expect(JSON.stringify(map.get('canvas-instances'))).toContain('newer-disk-card');
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('stops a timed-out writer before it can replace a newer primary and keeps both versions', async () => {
    const { map, storage } = createStorage({ 'canvas-instances': canvasWith(card('original')) });
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    await store.getState().loadWires(storage);
    store.getState().addView('agent', { x: 1, y: 2 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = vi.mocked(storage.write).getMockImplementation()!;
    vi.mocked(storage.write).mockImplementation(async (key, value) => { if (key === 'canvas-instances-backup') await gate; return write(key, value); });
    const saving = store.getState().saveCanvas(storage);
    store.setState({ autosaveFailed: true });
    const retained = store.getState().canvases;
    store.getState().hydrateFromRemote([{ ...retained[0], id: 'remote', views: [] }], 'remote', [], []);
    const newer = canvasWith(card('newer'));
    map.set('canvas-instances', newer);
    map.set('canvas-instances-backup', newer);
    release();
    await expect(saving).rejects.toThrow('Canvas source changed');
    expect(map.get('canvas-instances')).toBe(newer);
    await store.getState().restoreFailedLocalState(storage);
    expect(store.getState().views.map((v) => v.id)).toEqual(['newer']);
    const copy = [...map.entries()].find(([key]) => key.startsWith('canvas-unsaved-copy-'));
    expect(copy?.[1]).toEqual(expect.objectContaining({ canvases: retained }));
  });

  it('preserves a newer divergent backup before autosave can rotate either disk copy', async () => {
    const original = canvasWith(card('original'));
    const { map, storage } = createStorage({ 'canvas-instances': original, 'canvas-instances-backup': original });
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    await store.getState().loadWires(storage);
    store.getState().addView('agent', { x: 1, y: 2 });
    store.setState({ autosaveFailed: true });
    const retained = store.getState().canvases;
    store.getState().hydrateFromRemote([{ ...original[0], id: 'remote', views: [] }], 'remote', [], []);
    const newer = canvasWith(card('newer-backup'));
    map.set('canvas-instances-backup', newer);
    await store.getState().restoreFailedLocalState(storage);
    expect(store.getState().views.map((v) => v.id)).toEqual(['newer-backup']);
    const copy = [...map.entries()].find(([key]) => key.startsWith('canvas-unsaved-copy-'));
    expect(copy?.[1]).toEqual(expect.objectContaining({ canvases: retained, diskCopies: { primary: original, backup: newer } }));
    await store.getState().saveCanvas(storage);
    expect(JSON.stringify(map.get('canvas-instances-backup'))).toContain('newer-backup');
    expect(JSON.stringify(map.get('canvas-instances'))).toContain('newer-backup');
  });

  it('never retains remote wire fields when local canvas hydration precedes its wire read', async () => {
    const original = canvasWith(card('local'));
    const { map, storage } = createStorage({ 'canvas-instances': original });
    const store = createCanvasStore();
    const remote = [{ ...original[0], id: 'remote', views: [] }];
    store.getState().hydrateFromRemote(remote, 'remote', [{ agentId: 'REMOTE-SECRET', targetId: 'remote-target', targetKind: 'agent', label: 'remote' }], []);
    await store.getState().loadCanvas(storage);
    expect(store.getState().wireDefinitions).toEqual([]);
    expect(store.getState().wiresLoaded).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.mocked(storage.read).getMockImplementation()!;
    vi.mocked(storage.read).mockImplementation(async (key) => { if (key === 'canvas-wires') await gate; return read(key); });
    const loading = store.getState().loadWires(storage);
    store.setState({ autosaveFailed: true });
    store.getState().hydrateFromRemote(remote, 'remote', [], []);
    release();
    await loading;
    const newer = canvasWith(card('newer'));
    map.set('canvas-instances', newer);
    map.set('canvas-instances-backup', newer);
    await store.getState().restoreFailedLocalState(storage);
    const copy = [...map.entries()].find(([key]) => key.startsWith('canvas-unsaved-copy-'));
    expect(copy).toBeDefined();
    expect(JSON.stringify(copy?.[1])).not.toContain('REMOTE-SECRET');
  });

  it('keeps retained edits in memory when disk cannot be checked, and retries once readable', async () => {
    let unreadable = false;
    const { storage } = createStorage({}, () => unreadable);
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    await store.getState().loadWires(storage);
    store.getState().addView('agent', { x: 1, y: 2 });
    store.setState({ autosaveFailed: true });
    const retained = store.getState().canvases;
    store.getState().hydrateFromRemote([{ ...retained[0], id: 'remote', views: [] }], 'remote', [], []);
    unreadable = true;
    await store.getState().restoreFailedLocalState(storage);
    expect(store.getState().canvases).toBe(retained);
    expect(store.getState().autosaveFailed).toBe(true);
    await expect(store.getState().saveCanvas(storage)).rejects.toThrow('EACCES');
    expect(storage.write).not.toHaveBeenCalled();
    unreadable = false;
    await store.getState().saveCanvas(storage);
    expect(storage.write).toHaveBeenCalledWith('canvas-instances', expect.any(Array));
  });

  it.each(['navigation', 'save'])('invalidates retained state after a newer local %s', async (path) => {
    const { storage } = createStorage({ 'canvas-instances': canvasWith(card('original')) });
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    await store.getState().loadWires(storage);
    store.setState({ autosaveFailed: true });
    store.getState().hydrateFromRemote([{ ...canvasWith()[0], id: 'remote' }], 'remote', [], []);
    if (path === 'navigation') {
      store.getState().hydrateForNavigation({ canvases: canvasWith(card('newer')), wires: [], zoneWires: [] }, 'canvas_1');
    } else {
      await store.getState().loadCanvas(storage);
      store.getState().addView('agent', { x: 7, y: 8 });
      await store.getState().saveCanvas(storage);
    }
    const local = store.getState().canvases;
    expect(await store.getState().restoreFailedLocalState(storage)).toBe(false);
    expect(store.getState().canvases).toBe(local);
  });

  it('reports wire edits made during the first unreadable wire read as unsaved', async () => {
    const { storage } = createStorage({ 'canvas-instances': canvasWith(card('a'), card('b')) });
    const store = createCanvasStore();
    await store.getState().loadCanvas(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.mocked(storage.read).getMockImplementation()!;
    vi.mocked(storage.read).mockImplementation(async (key) => {
      if (key === 'canvas-wires') { await gate; throw eacces(); }
      return read(key);
    });
    const loading = store.getState().loadWires(storage);
    store.getState().addWireDefinition({ agentId: 'durable_a', targetId: 'durable_b', targetKind: 'agent', label: 'B' });
    release();
    await loading;
    await expect(store.getState().saveWires(storage)).rejects.toThrow(/changes not saved/);
    expect(storage.write).not.toHaveBeenCalled();
  });

  it.each(['canvas', 'wires'])('does not publish a superseded local %s load into a remote store', async (kind) => {
    const { storage } = createStorage({ 'canvas-instances': canvasWith(card('local')) });
    const store = createCanvasStore();
    const remote = [{ ...canvasWith()[0], id: 'remote' }];
    store.getState().hydrateFromRemote(remote, 'remote', [], []);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.mocked(storage.read).getMockImplementation()!;
    const key = kind === 'canvas' ? 'canvas-instances' : 'canvas-wires';
    vi.mocked(storage.read).mockImplementation(async (k) => { if (k === key) await gate; return read(k); });
    const loading = kind === 'canvas' ? store.getState().loadCanvas(storage) : store.getState().loadWires(storage);
    await vi.waitFor(() => expect(storage.read).toHaveBeenCalledWith(key));
    store.getState().hydrateFromRemote(remote, 'remote', [], []);
    release();
    await loading;
    expect(store.getState().dataOrigin).toBe('remote');
    expect(store.getState().activeCanvasId).toBe('remote');
    await store.getState().saveCanvas(storage);
    await store.getState().saveWires(storage);
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('refuses to save a store that was never hydrated from storage', async () => {
    const { storage } = createStorage({ 'canvas-instances': canvasWith(card('a')) });
    const store = createCanvasStore();
    await store.getState().saveCanvas(storage);
    expect(storage.write).not.toHaveBeenCalled();
  });
});
