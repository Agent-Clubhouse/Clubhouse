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

  it('inserts a pre-formed canvas', () => {
    const canvas = {
      id: 'test-canvas-1',
      name: 'Imported Canvas',
      views: [
        {
          id: 'cv_test1',
          type: 'agent' as const,
          position: { x: 0, y: 0 },
          size: { width: 480, height: 480 },
          title: 'Agent',
          displayName: 'Agent',
          zIndex: 0,
          metadata: {},
          agentId: 'agent-1',
          projectId: 'proj-1',
        },
      ],
      viewport: { panX: 0, panY: 0, zoom: 1 },
      nextZIndex: 1,
      zoomedViewId: null,
      selectedViewId: null,
    };

    store.getState().insertCanvas(canvas);
    expect(store.getState().canvases).toHaveLength(2);
    expect(store.getState().activeCanvasId).toBe('test-canvas-1');
    expect(store.getState().views).toHaveLength(1);
    expect(store.getState().views[0].agentId).toBe('agent-1');
  });

  it('inserted canvas becomes the active canvas', () => {
    const canvas = {
      id: 'inserted-1',
      name: 'Test',
      views: [],
      viewport: { panX: 10, panY: 20, zoom: 0.8 },
      nextZIndex: 0,
      zoomedViewId: null,
      selectedViewId: null,
    };
    store.getState().insertCanvas(canvas);
    expect(store.getState().activeCanvasId).toBe('inserted-1');
    expect(store.getState().viewport).toEqual({ panX: 10, panY: 20, zoom: 0.8 });
  });

  // ── loadAndInsertCanvas ──────────────────────────────────────

  it('loadAndInsertCanvas loads existing data then inserts', async () => {
    // Pre-populate storage with an existing canvas
    const existingCanvas = {
      id: 'existing-1',
      name: 'Existing',
      views: [],
      viewport: { panX: 0, panY: 0, zoom: 1 },
      nextZIndex: 0,
    };
    const storage = createMockStorage({
      'canvas-instances': [existingCanvas],
      'canvas-active-id': 'existing-1',
    });

    const newCanvas = {
      id: 'new-from-hub',
      name: 'From Hub',
      views: [],
      viewport: { panX: 0, panY: 0, zoom: 1 },
      nextZIndex: 0,
      zoomedViewId: null,
      selectedViewId: null,
    };

    await store.getState().loadAndInsertCanvas(newCanvas, storage);

    // Should have both the existing canvas and the new one
    expect(store.getState().canvases).toHaveLength(2);
    expect(store.getState().canvases.map((c) => c.id)).toContain('existing-1');
    expect(store.getState().canvases.map((c) => c.id)).toContain('new-from-hub');
    // New canvas should be active
    expect(store.getState().activeCanvasId).toBe('new-from-hub');
    expect(store.getState().loaded).toBe(true);
  });

  it('loadAndInsertCanvas persists to storage immediately', async () => {
    const storage = createMockStorage();
    await store.getState().loadCanvas(storage);

    const newCanvas = {
      id: 'persisted-canvas',
      name: 'Persisted',
      views: [],
      viewport: { panX: 5, panY: 10, zoom: 0.8 },
      nextZIndex: 0,
      zoomedViewId: null,
      selectedViewId: null,
    };

    await store.getState().loadAndInsertCanvas(newCanvas, storage);

    // Verify data was written to storage
    const saved = await storage.read('canvas-instances') as any[];
    expect(saved.map((c: any) => c.id)).toContain('persisted-canvas');
    const savedActive = await storage.read('canvas-active-id');
    expect(savedActive).toBe('persisted-canvas');
  });

  it('loadAndInsertCanvas skips load if already loaded', async () => {
    const storage = createMockStorage();
    await store.getState().loadCanvas(storage);
    const initialCount = store.getState().canvases.length;

    const newCanvas = {
      id: 'after-load',
      name: 'After Load',
      views: [],
      viewport: { panX: 0, panY: 0, zoom: 1 },
      nextZIndex: 0,
      zoomedViewId: null,
      selectedViewId: null,
    };

    await store.getState().loadAndInsertCanvas(newCanvas, storage);

    // Should have initial canvas + new one (didn't double-load)
    expect(store.getState().canvases).toHaveLength(initialCount + 1);
    expect(store.getState().activeCanvasId).toBe('after-load');
  });

  it('loadAndInsertCanvas survives re-load from storage', async () => {
    const storage = createMockStorage();

    const newCanvas = {
      id: 'survive-reload',
      name: 'Survives',
      views: [],
      viewport: { panX: 0, panY: 0, zoom: 1 },
      nextZIndex: 0,
      zoomedViewId: null,
      selectedViewId: null,
    };

    // Insert (which also saves)
    await store.getState().loadAndInsertCanvas(newCanvas, storage);

    // Simulate canvas plugin re-mounting: create new store and load from same storage
    const store2 = createCanvasStore();
    await store2.getState().loadCanvas(storage);

    // The new canvas should still be there
    expect(store2.getState().canvases.map((c) => c.id)).toContain('survive-reload');
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

describe('hydrateFromRemote', () => {
  let store: ReturnType<typeof createCanvasStore>;

  beforeEach(() => {
    store = createCanvasStore();
  });

  it('hydrates canvas state from remote data', () => {
    const remoteCanvases = [{
      id: 'remote-canvas-1',
      name: 'Remote Canvas',
      views: [
        { id: 'v1', type: 'agent', position: { x: 100, y: 200 }, size: { width: 300, height: 200 }, zIndex: 0, displayName: 'Agent', metadata: {} },
      ],
      viewport: { panX: 50, panY: 50, zoom: 1.5 },
      nextZIndex: 1,
      zoomedViewId: null,
    }];

    store.getState().hydrateFromRemote(remoteCanvases, 'remote-canvas-1');

    const state = store.getState();
    expect(state.loaded).toBe(true);
    expect(state.canvases).toHaveLength(1);
    expect(state.activeCanvasId).toBe('remote-canvas-1');
    expect(state.views).toHaveLength(1);
    expect(state.views[0].type).toBe('agent');
    expect(state.viewport.panX).toBe(50);
  });

  it('does nothing with empty data', () => {
    store.getState().hydrateFromRemote([], 'nonexistent');
    expect(store.getState().loaded).toBe(false);
  });

  it('does nothing with null data', () => {
    store.getState().hydrateFromRemote(null as any, '');
    expect(store.getState().loaded).toBe(false);
  });

  it('falls back to first canvas if activeCanvasId is missing', () => {
    const remoteCanvases = [{
      id: 'c1',
      name: 'Canvas 1',
      views: [],
      viewport: { panX: 0, panY: 0, zoom: 1 },
      nextZIndex: 0,
      zoomedViewId: null,
    }];

    store.getState().hydrateFromRemote(remoteCanvases, 'nonexistent');
    expect(store.getState().activeCanvasId).toBe('c1');
    expect(store.getState().loaded).toBe(true);
  });

  it('hydrates multiple canvases', () => {
    const remoteCanvases = [
      { id: 'c1', name: 'Canvas 1', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
      { id: 'c2', name: 'Canvas 2', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
    ];

    store.getState().hydrateFromRemote(remoteCanvases, 'c2');
    expect(store.getState().canvases).toHaveLength(2);
    expect(store.getState().activeCanvasId).toBe('c2');
  });

  // ── Wire persistence ──────────────────────────────────────────────

  describe('wire persistence', () => {
    const mockMcpBinding = {
      bind: vi.fn().mockResolvedValue(undefined),
      setInstructions: vi.fn().mockResolvedValue(undefined),
    };

    beforeEach(() => {
      // Mock window.clubhouse.mcpBinding
      (globalThis as any).window = {
        ...(globalThis as any).window,
        clubhouse: {
          ...((globalThis as any).window?.clubhouse || {}),
          mcpBinding: mockMcpBinding,
        },
      };
      mockMcpBinding.bind.mockClear();
      mockMcpBinding.setInstructions.mockClear();
    });

    it('saves wire definitions to storage', async () => {
      const storage = createMockStorage();
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2', agentName: 'robin', targetName: 'falcon', projectName: 'myapp' },
      );
      await store.getState().saveWires(storage);
      expect(storage.write).toHaveBeenCalledWith('canvas-wires', expect.arrayContaining([
        expect.objectContaining({ agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2' }),
      ]));
    });

    it('saves wire definitions with instructions', async () => {
      const storage = createMockStorage();
      store.getState().addWireDefinition({
        agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2',
        instructions: { '*': 'No secrets' },
      });
      await store.getState().saveWires(storage);
      expect(storage.write).toHaveBeenCalledWith('canvas-wires', expect.arrayContaining([
        expect.objectContaining({ instructions: { '*': 'No secrets' } }),
      ]));
    });

    it('restores wires from storage via IPC bind calls', async () => {
      const storage = createMockStorage({
        'canvas-wires': [
          { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2', agentName: 'robin', targetName: 'falcon', projectName: 'myapp' },
        ],
      });
      await store.getState().loadWires(storage);
      expect(mockMcpBinding.bind).toHaveBeenCalledWith('a1', expect.objectContaining({
        targetId: 'a2',
        targetKind: 'agent',
        label: 'Agent 2',
      }));
    });

    it('restores wire instructions', async () => {
      const storage = createMockStorage({
        'canvas-wires': [
          {
            agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2',
            instructions: { '*': 'Be careful' },
          },
        ],
      });
      await store.getState().loadWires(storage);
      expect(mockMcpBinding.setInstructions).toHaveBeenCalledWith('a1', 'a2', { '*': 'Be careful' });
    });

    it('handles empty storage gracefully', async () => {
      const storage = createMockStorage();
      await store.getState().loadWires(storage);
      expect(mockMcpBinding.bind).not.toHaveBeenCalled();
    });

    it('skips entries with missing required fields', async () => {
      const storage = createMockStorage({
        'canvas-wires': [
          { agentId: 'a1', targetId: '', targetKind: 'agent', label: 'Bad' },
          { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Good' },
        ],
      });
      await store.getState().loadWires(storage);
      expect(mockMcpBinding.bind).toHaveBeenCalledTimes(1);
      expect(mockMcpBinding.bind).toHaveBeenCalledWith('a1', expect.objectContaining({ targetId: 'a2' }));
    });

    it('prunes stale bindings whose source and target views no longer exist', async () => {
      // Set up a canvas with one agent view (agentId: 'agent-alive')
      const canvasStorage = createMockStorage({
        'canvas-instances': [{
          id: 'c1', name: 'Canvas', views: [
            { id: 'cv1', type: 'agent', agentId: 'agent-alive', position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, zIndex: 0, displayName: 'Alive', metadata: {} },
          ], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1,
        }],
        'canvas-active-id': 'c1',
        'canvas-wires': [
          // Valid: source agent exists on canvas
          { agentId: 'agent-alive', targetId: 'some-target', targetKind: 'agent', label: 'Valid' },
          // Stale: neither agentId nor targetId exist in any canvas view
          { agentId: 'agent-gone', targetId: 'target-gone', targetKind: 'agent', label: 'Stale' },
        ],
      });

      await store.getState().loadCanvas(canvasStorage);
      await store.getState().loadWires(canvasStorage);

      // Only the valid binding should be restored (both MCP bind and wireDefinitions)
      expect(mockMcpBinding.bind).toHaveBeenCalledTimes(1);
      expect(mockMcpBinding.bind).toHaveBeenCalledWith('agent-alive', expect.objectContaining({ targetId: 'some-target' }));
      expect(store.getState().wireDefinitions).toHaveLength(1);
      expect(store.getState().wireDefinitions[0].agentId).toBe('agent-alive');
    });

    it('keeps bindings where only target exists on canvas', async () => {
      const canvasStorage = createMockStorage({
        'canvas-instances': [{
          id: 'c1', name: 'Canvas', views: [
            { id: 'cv1', type: 'agent', agentId: 'agent-target', position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, zIndex: 0, displayName: 'Target', metadata: {} },
          ], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1,
        }],
        'canvas-active-id': 'c1',
        'canvas-wires': [
          // Source not on canvas, but target agent IS on canvas — keep it
          { agentId: 'external-agent', targetId: 'agent-target', targetKind: 'agent', label: 'Cross-canvas' },
        ],
      });

      await store.getState().loadCanvas(canvasStorage);
      await store.getState().loadWires(canvasStorage);

      expect(mockMcpBinding.bind).toHaveBeenCalledTimes(1);
    });

    it('loadWires populates wireDefinitions', async () => {
      const storage = createMockStorage({
        'canvas-wires': [
          { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2' },
          { agentId: 'a1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
        ],
      });
      await store.getState().loadWires(storage);
      expect(store.getState().wireDefinitions).toHaveLength(2);
      expect(store.getState().wireDefinitions[0].agentId).toBe('a1');
      expect(store.getState().wireDefinitions[1].targetId).toBe('b1');
    });

    it('loadWires keeps wire definitions even when MCP bind fails', async () => {
      mockMcpBinding.bind.mockRejectedValueOnce(new Error('MCP not enabled'));
      const storage = createMockStorage({
        'canvas-wires': [
          { agentId: 'sleeping-agent', targetId: 'a2', targetKind: 'agent', label: 'Agent 2' },
        ],
      });
      await store.getState().loadWires(storage);
      // Wire definition should be stored even though MCP bind failed
      expect(store.getState().wireDefinitions).toHaveLength(1);
      expect(store.getState().wireDefinitions[0].agentId).toBe('sleeping-agent');
    });

    it('saveWires persists from wireDefinitions, not from external bindings', async () => {
      const storage = createMockStorage();
      // Add wire definitions directly
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2' },
      );
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
      );
      await store.getState().saveWires(storage);
      expect(storage.write).toHaveBeenCalledWith('canvas-wires', expect.arrayContaining([
        expect.objectContaining({ agentId: 'a1', targetId: 'a2' }),
        expect.objectContaining({ agentId: 'a1', targetId: 'b1' }),
      ]));
    });

    it('wire definitions survive even if MCP bindings are removed (agent sleep scenario)', async () => {
      // Simulate: load wires, then imagine MCP cleans up bindings.
      // Wire definitions should remain in the store.
      const storage = createMockStorage({
        'canvas-wires': [
          { agentId: 'sleepy-agent', targetId: 'a2', targetKind: 'agent', label: 'Agent 2' },
        ],
      });
      await store.getState().loadWires(storage);
      expect(store.getState().wireDefinitions).toHaveLength(1);

      // Save again — wire definitions persist regardless of MCP binding state
      const storage2 = createMockStorage();
      await store.getState().saveWires(storage2);
      expect(storage2.write).toHaveBeenCalledWith('canvas-wires', [
        expect.objectContaining({ agentId: 'sleepy-agent', targetId: 'a2' }),
      ]);
    });

    it('addWireDefinition adds a new entry', () => {
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2' },
      );
      expect(store.getState().wireDefinitions).toHaveLength(1);
    });

    it('addWireDefinition deduplicates by agentId+targetId', () => {
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2' },
      );
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2 again' },
      );
      expect(store.getState().wireDefinitions).toHaveLength(1);
    });

    it('removeWireDefinition removes the matching entry', () => {
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2' },
      );
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
      );
      expect(store.getState().wireDefinitions).toHaveLength(2);

      store.getState().removeWireDefinition('a1', 'a2');
      expect(store.getState().wireDefinitions).toHaveLength(1);
      expect(store.getState().wireDefinitions[0].targetId).toBe('b1');
    });

    it('removeWireDefinition is a no-op for non-existent entry', () => {
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2' },
      );
      store.getState().removeWireDefinition('a1', 'nonexistent');
      expect(store.getState().wireDefinitions).toHaveLength(1);
    });

    it('updateWireDefinition updates fields on matching entry', () => {
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2' },
      );
      store.getState().updateWireDefinition('a1', 'a2', {
        instructions: { '*': 'Be careful' },
        disabledTools: ['dangerous_tool'],
      });
      const def = store.getState().wireDefinitions[0];
      expect(def.instructions).toEqual({ '*': 'Be careful' });
      expect(def.disabledTools).toEqual(['dangerous_tool']);
    });

    it('updateWireDefinition does not affect non-matching entries', () => {
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2' },
      );
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
      );
      store.getState().updateWireDefinition('a1', 'a2', { instructions: { '*': 'test' } });
      expect(store.getState().wireDefinitions[1].instructions).toBeUndefined();
    });

    it('wire definitions round-trip: save then load into fresh store', async () => {
      const storage = createMockStorage();

      // Add wire definitions and save
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent 2', instructions: { '*': 'Be nice' } },
      );
      store.getState().addWireDefinition(
        { agentId: 'a1', targetId: 'b1', targetKind: 'browser', label: 'Browser', disabledTools: ['tool1'] },
      );
      await store.getState().saveWires(storage);

      // Load into fresh store
      const store2 = createCanvasStore();
      await store2.getState().loadWires(storage);

      expect(store2.getState().wireDefinitions).toHaveLength(2);
      expect(store2.getState().wireDefinitions[0].instructions).toEqual({ '*': 'Be nice' });
      expect(store2.getState().wireDefinitions[1].disabledTools).toEqual(['tool1']);
    });

    it('reconciles group-project bindings by metadata.groupProjectId', async () => {
      const canvasStorage = createMockStorage({
        'canvas-instances': [{
          id: 'c1', name: 'Canvas', views: [
            { id: 'cv1', type: 'agent', agentId: 'agent-1', position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, zIndex: 0, displayName: 'Agent', metadata: {} },
            { id: 'cv2', type: 'plugin', pluginWidgetType: 'plugin:group-project:group-project', pluginId: 'group-project', position: { x: 400, y: 0 }, size: { width: 300, height: 200 }, zIndex: 1, displayName: 'GP', metadata: { groupProjectId: 'gp_123' } },
          ], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 2,
        }],
        'canvas-active-id': 'c1',
        'canvas-wires': [
          { agentId: 'agent-1', targetId: 'gp_123', targetKind: 'group-project', label: 'GP' },
          // This binding's source (agent-1) still exists, so it is kept even though
          // gp_deleted is gone — reconciliation only drops fully orphaned bindings.
          { agentId: 'agent-1', targetId: 'gp_deleted', targetKind: 'group-project', label: 'Gone' },
          // Fully orphaned: neither source nor target exist on any canvas
          { agentId: 'agent-gone', targetId: 'gp_also_gone', targetKind: 'group-project', label: 'Orphan' },
        ],
      });

      await store.getState().loadCanvas(canvasStorage);
      await store.getState().loadWires(canvasStorage);

      // Two bindings restored (agent-1 is valid), fully orphaned one is pruned
      expect(mockMcpBinding.bind).toHaveBeenCalledTimes(2);
      expect(mockMcpBinding.bind).toHaveBeenCalledWith('agent-1', expect.objectContaining({ targetId: 'gp_123' }));
      expect(mockMcpBinding.bind).toHaveBeenCalledWith('agent-1', expect.objectContaining({ targetId: 'gp_deleted' }));
    });
  });

  // ── Zone creation: no auto-containment ────────────────────────────

  describe('zone creation does not auto-contain existing agents', () => {
    it('adding a zone on top of an existing agent does not contain it', () => {
      // Add an agent at (100, 100)
      store.getState().addView('agent', { x: 100, y: 100 });
      expect(store.getState().views).toHaveLength(1);

      // Add a zone that spatially covers the agent
      store.getState().addView('zone', { x: 0, y: 0 });
      const views = store.getState().views;
      expect(views).toHaveLength(2);

      const zone = views.find((v) => v.type === 'zone') as any;
      expect(zone).toBeDefined();
      // Zone should start with empty containedViewIds
      expect(zone.containedViewIds).toEqual([]);
    });

    it('moving an agent into a zone adds it to containment', () => {
      // Add a zone first
      store.getState().addView('zone', { x: 0, y: 0 });
      // Add an agent outside the zone
      store.getState().addView('agent', { x: 1000, y: 1000 });

      const agent = store.getState().views.find((v) => v.type === 'agent')!;
      const zone = store.getState().views.find((v) => v.type === 'zone')!;

      // Move the agent into the zone
      store.getState().moveView(agent.id, { x: 100, y: 100 });

      const updatedZone = store.getState().views.find((v) => v.id === zone.id) as any;
      expect(updatedZone.containedViewIds).toContain(agent.id);
    });

    it('adding a non-zone view inside an existing zone does contain it', () => {
      // Add a zone first
      store.getState().addView('zone', { x: 0, y: 0 });

      // Add an agent inside the zone
      store.getState().addView('agent', { x: 100, y: 100 });

      const views = store.getState().views;
      const zone = views.find((v) => v.type === 'zone') as any;
      const agent = views.find((v) => v.type === 'agent')!;
      // Agent added inside zone → containment computed
      expect(zone.containedViewIds).toContain(agent.id);
    });
  });
});
