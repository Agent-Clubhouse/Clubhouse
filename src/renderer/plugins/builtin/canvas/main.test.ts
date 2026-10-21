import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { manifest } from './manifest';
import * as canvasModule from './main';
import { createMockContext, createMockAPI } from '../../testing';
import { useUIStore } from '../../../stores/uiStore';
import { queueAgentCard } from './agent-card-queue';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';

// The New agent page can't open in these tests unless a test turns it on.
const openNewAgentPage = vi.fn((..._args: unknown[]) => false);
vi.mock('../../../chrome/startPage', () => ({
  openNewAgentPage: (...args: unknown[]) => openNewAgentPage(...args),
}));

describe('canvas main', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: canvasModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('activate registers add-agent-view command (app scope)', () => {
    const ctx = createMockContext({ pluginId: 'canvas', scope: 'dual' });
    const registerFn = vi.fn(() => ({ dispose: () => {} }));
    const api = createMockAPI({
      commands: { register: registerFn, execute: async () => {}, registerWithHotkey: () => ({ dispose: () => {} }), getBinding: () => null, clearBinding: () => {} },
      context: { mode: 'app', projectId: undefined, projectPath: undefined },
    });

    canvasModule.activate(ctx, api);

    expect(registerFn).toHaveBeenCalledWith('add-agent-view', expect.any(Function));
    expect(registerFn).toHaveBeenCalledWith('add-file-view', expect.any(Function));
    expect(registerFn).toHaveBeenCalledWith('add-anchor-view', expect.any(Function));
    expect(registerFn).toHaveBeenCalledWith('reset-viewport', expect.any(Function));
  });

  it('activate pushes disposables to ctx.subscriptions (app scope)', () => {
    const ctx = createMockContext({ pluginId: 'canvas', scope: 'dual' });
    const api = createMockAPI({
      context: { mode: 'app', projectId: undefined, projectPath: undefined },
    });

    canvasModule.activate(ctx, api);

    expect(ctx.subscriptions).toHaveLength(7);
    for (const sub of ctx.subscriptions) {
      expect(typeof sub.dispose).toBe('function');
    }
  });

  it('deactivate does not throw', () => {
    expect(() => canvasModule.deactivate()).not.toThrow();
  });

  it('exports MainPanel component', () => {
    expect(canvasModule.MainPanel).toBeDefined();
    expect(typeof canvasModule.MainPanel).toBe('function');
  });

  it('exports getProjectCanvasStore function', () => {
    expect(canvasModule.getProjectCanvasStore).toBeDefined();
    expect(typeof canvasModule.getProjectCanvasStore).toBe('function');
  });

  it('exports hasProjectCanvasStore function', () => {
    expect(canvasModule.hasProjectCanvasStore).toBeDefined();
    expect(typeof canvasModule.hasProjectCanvasStore).toBe('function');
  });

  it('hasProjectCanvasStore returns false for unknown project', () => {
    expect(canvasModule.hasProjectCanvasStore('nonexistent-project')).toBe(false);
  });

  it('hasProjectCanvasStore returns false for null', () => {
    expect(canvasModule.hasProjectCanvasStore(null)).toBe(false);
  });

  it('hasProjectCanvasStore returns true after store is created', () => {
    const projectId = 'canvas-proj-has-check';
    expect(canvasModule.hasProjectCanvasStore(projectId)).toBe(false);
    canvasModule.getProjectCanvasStore(projectId);
    expect(canvasModule.hasProjectCanvasStore(projectId)).toBe(true);
  });

  it('getProjectCanvasStore returns the same store for the same projectId', () => {
    const store1 = canvasModule.getProjectCanvasStore('canvas-proj-1');
    const store2 = canvasModule.getProjectCanvasStore('canvas-proj-1');
    expect(store1).toBe(store2);
  });

  it('getProjectCanvasStore returns different stores for different projectIds', () => {
    const storeA = canvasModule.getProjectCanvasStore('canvas-proj-a');
    const storeB = canvasModule.getProjectCanvasStore('canvas-proj-b');
    expect(storeA).not.toBe(storeB);
  });

  // Mission 71 — Regression test for the new-canvas + button.
  //
  // MainPanel reads its store on every render via:
  //   const store = isAppMode ? useAppCanvasStore
  //                           : getProjectCanvasStore(api.context.projectId ?? null);
  //
  // If the projectId is ever null/undefined while mode is NOT 'app', the
  // pre-fix `getProjectCanvasStore(null)` returned a brand-new transient
  // store on every call (`return createCanvasStore()`). That made every
  // re-render of MainPanel observe a fresh store with the initial canvas,
  // so any addCanvas() the user triggered on the previous render's store
  // was discarded — the "+ button does nothing" symptom Mason reported.
  //
  // The contract should be: same input → same store. Repeated calls with
  // null must return the same instance, just like repeated calls with the
  // same project id do.
  it('getProjectCanvasStore returns a stable store for null projectId across calls', () => {
    const store1 = canvasModule.getProjectCanvasStore(null);
    const store2 = canvasModule.getProjectCanvasStore(null);
    expect(store1).toBe(store2);
  });

  it('getProjectCanvasStore null fallback preserves state across calls (addCanvas survives re-resolution)', () => {
    // Reproduces the + button bug at the store layer: if the fallback
    // store is fresh on every call, an addCanvas mutation on the first
    // resolution is invisible to the second resolution.
    const storeA = canvasModule.getProjectCanvasStore(null);
    const initialCount = storeA.getState().canvases.length;

    storeA.getState().addCanvas();
    expect(storeA.getState().canvases.length).toBe(initialCount + 1);

    // Re-resolve as MainPanel does on its next render — this MUST observe
    // the same canvases array, otherwise the click-add was visually a no-op.
    const storeB = canvasModule.getProjectCanvasStore(null);
    expect(storeB.getState().canvases.length).toBe(initialCount + 1);
  });

  it('loadCanvas is awaited before loadWires in MainPanel (structural)', () => {
    // The loadCanvas/loadWires race condition caused auto-save to overwrite
    // persisted wire data with incomplete bindings. Verify the fix:
    // loadCanvas must be awaited before loadWires is called.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf-8');

    // Find the async IIFE that wraps the load calls
    const asyncBlock = source.slice(
      source.indexOf('(async () =>'),
      source.indexOf('(async () =>') + 300,
    );
    // Both loadCanvas and loadWires must be awaited inside the IIFE
    expect(asyncBlock).toContain('await store.getState().loadCanvas(storage)');
    expect(asyncBlock).toContain('await store.getState().loadWires(storage)');
    // loadCanvas must come before loadWires
    const canvasIdx = asyncBlock.indexOf('loadCanvas');
    const wiresIdx = asyncBlock.indexOf('loadWires');
    expect(canvasIdx).toBeLessThan(wiresIdx);
  });

  it('selectView is forwarded via remoteForward (structural)', () => {
    // Verify that handleSelectView calls remoteForward with selectView mutation.
    // Previously selectView was local-only, causing the satellite to stay in
    // empty state when the controller selected an agent.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf-8');

    // handleSelectView should call remoteForward
    const selectViewBlock = source.slice(
      source.indexOf('handleSelectView'),
      source.indexOf('handleSelectView') + 300,
    );
    expect(selectViewBlock).toContain('remoteForward');
    expect(selectViewBlock).toContain("'selectView'");

    // It should NOT have the old "Selection is purely local" comment
    expect(source).not.toContain('Selection is purely local');
  });

  it('CanvasView guards against null plugin component (structural)', () => {
    // React error #130 occurs when a pre-registered widget placeholder has
    // component: null but gets past the isWidgetPending check. The CanvasView
    // must guard against null components before rendering.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, 'CanvasView.tsx'), 'utf-8');

    // After getting the Component, there should be a null check before rendering
    const componentBlock = source.slice(
      source.indexOf('const Component = registered.descriptor.component'),
      source.indexOf('const Component = registered.descriptor.component') + 400,
    );
    expect(componentBlock).toContain('if (!Component)');
    expect(componentBlock).toContain('not available');
  });

  it('auto-save uses wireDefinitions instead of live MCP bindings (structural)', () => {
    // Wire definitions must survive agent sleep cycles. The auto-save should
    // persist wireDefinitions (canvas-owned) rather than live MCP bindings
    // (which get cleared when agents exit).
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf-8');

    // scheduleSave should call saveWires without passing bindings
    const saveBlock = source.slice(
      source.indexOf('scheduleSave'),
      source.indexOf('scheduleSave') + 500,
    );
    expect(saveBlock).toContain('saveWires(storage)');
    // Should NOT pass bindingsRef.current to saveWires
    expect(saveBlock).not.toContain('saveWires(storage, bindingsRef');

    // Auto-save effect should react to wireDefinitions, not bindings
    const autoSaveEffect = source.slice(
      source.indexOf('wireDefinitions, zoneWireDefinitions, minimapAutoHide, elkAlgorithm, elkDirection, layoutCenterId, loaded, wiresLoaded, scheduleSave'),
      source.indexOf('wireDefinitions, zoneWireDefinitions, minimapAutoHide, elkAlgorithm, elkDirection, layoutCenterId, loaded, wiresLoaded, scheduleSave') + 160,
    );
    expect(autoSaveEffect).toBeTruthy();
  });

  it('CanvasWorkspace receives wireDefinitions prop (structural)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf-8');

    // wireDefinitions should be passed to CanvasWorkspace
    expect(source).toContain('wireDefinitions,');
    expect(source).toContain('onAddWireDefinition');
    expect(source).toContain('onRemoveWireDefinition');
    expect(source).toContain('onUpdateWireDefinition');
  });

  it('agent wake reconciliation re-creates MCP bindings from wire definitions (structural)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf-8');

    // Should have wake reconciliation logic
    expect(source).toContain('Agent wake reconciliation');
    expect(source).toContain('wireDefinitions');
    // Binding goes through the shared helper (instructions and disabled tools
    // included); the loop itself is unit-tested in wire-reconcile.test.ts.
    expect(source).toContain('createWireReconciler');
    expect(source).toContain('bindWireDefinition(def,');
  });

  it('group-project privileged access is governed by admin role, not a per-wire default (structural)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf-8');

    // New group-project wires no longer pre-disable privileged tools — the
    // project's admin role sets the baseline (see shared/group-project-admin.ts).
    expect(source).not.toContain('getDefaultGroupProjectDisabledToolsFromMetadata');
    expect(source).not.toContain("const allAdvanced = ['shoulder_tap'");
  });

  it('handleRemoveView cleans up wire definitions (structural)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf-8');

    const removeViewBlock = source.slice(
      source.indexOf('handleRemoveView'),
      source.indexOf('handleRemoveView') + 500,
    );
    expect(removeViewBlock).toContain('removeWireDefinition');
  });

  describe('handleAddFromBlueprint (GH-1563 / #1566)', () => {
    // #1563: the blueprint gallery previously picked its target canvas store from
    // the globally active project (activeProjectId), which is wrong when the "+ →
    // From Blueprint" button is clicked on the app-mode rail Canvas while a project
    // happens to be open elsewhere. The fix is for the caller to tell the gallery
    // which store it means via an explicit scope, instead of the gallery guessing.
    //
    // #1566 QA follow-up: an optional projectPath let a project-scoped import
    // silently fall through to global storage. These tests render the real
    // MainPanel and click the actual "+ → From Blueprint" control, asserting on
    // what openBlueprintGallery is actually called with — not on source text.

    function renderPanel(context: Partial<import('../../../../shared/plugin-types').PluginContext>) {
      const api = createMockAPI({ context: { mode: 'project', projectId: undefined, projectPath: undefined, ...context } });
      render(React.createElement(canvasModule.MainPanel, { api }));
    }

    async function clickAddFromBlueprint() {
      fireEvent.click(await screen.findByTestId('canvas-add-button'));
      fireEvent.click(screen.getByTestId('canvas-add-from-blueprint'));
    }

    beforeEach(() => {
      useUIStore.setState({ blueprintGalleryOpen: false, blueprintGalleryScope: null });
    });

    it('passes an app scope when opened from the app-mode rail Canvas', async () => {
      const openSpy = vi.spyOn(useUIStore.getState(), 'openBlueprintGallery');
      renderPanel({ mode: 'app', projectId: undefined, projectPath: undefined });

      await clickAddFromBlueprint();

      expect(openSpy).toHaveBeenCalledWith({ mode: 'app' });
    });

    it('passes an explicit project scope with the real projectId and projectPath', async () => {
      const openSpy = vi.spyOn(useUIStore.getState(), 'openBlueprintGallery');
      renderPanel({ mode: 'project', projectId: 'proj-1566', projectPath: '/tmp/proj-1566' });

      await clickAddFromBlueprint();

      expect(openSpy).toHaveBeenCalledWith({ mode: 'project', projectId: 'proj-1566', projectPath: '/tmp/proj-1566' });
    });

    it('does NOT open the gallery when project mode is missing a resolved projectPath', async () => {
      const openSpy = vi.spyOn(useUIStore.getState(), 'openBlueprintGallery');
      renderPanel({ mode: 'project', projectId: 'proj-1566', projectPath: undefined });

      await clickAddFromBlueprint();

      expect(openSpy).not.toHaveBeenCalled();
    });

    it('does NOT open the gallery when project mode is missing a resolved projectId', async () => {
      const openSpy = vi.spyOn(useUIStore.getState(), 'openBlueprintGallery');
      renderPanel({ mode: 'project', projectId: undefined, projectPath: '/tmp/proj-1566' });

      await clickAddFromBlueprint();

      expect(openSpy).not.toHaveBeenCalled();
    });
  });

  it('shows a load error (not an empty, autosaving canvas) when canvas storage is unreadable', async () => {
    const read = vi.fn(async (key: string) => {
      if (key.startsWith('canvas-instances')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return undefined;
    });
    const write = vi.fn(async () => {});
    const storage = { read, write, delete: vi.fn(async () => {}), list: vi.fn(async () => []) };
    const api = createMockAPI({
      context: { mode: 'project', projectId: 'proj-load-error', projectPath: '/tmp/proj-load-error' },
      storage: { project: storage, projectLocal: storage, global: storage },
    });
    render(React.createElement(canvasModule.MainPanel, { api }));

    expect(await screen.findByTestId('canvas-load-error', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
  });

  it('per-project stores have isolated state', () => {
    const storeA = canvasModule.getProjectCanvasStore('canvas-proj-iso-a');
    const storeB = canvasModule.getProjectCanvasStore('canvas-proj-iso-b');

    // Add a view to store A
    storeA.getState().addView('agent', { x: 100, y: 100 });
    expect(storeA.getState().views).toHaveLength(1);

    // Store B should be unaffected
    expect(storeB.getState().views).toHaveLength(0);
  });

  describe('GH-1453: dual-scope activation does not register commands twice', () => {
    it('app-scope activation registers commands', () => {
      const ctx = createMockContext({ pluginId: 'canvas', scope: 'dual' });
      const registerFn = vi.fn(() => ({ dispose: vi.fn() }));
      const api = createMockAPI({
        commands: { register: registerFn, execute: async () => {}, registerWithHotkey: () => ({ dispose: () => {} }), getBinding: () => null, clearBinding: () => {} },
        context: { mode: 'app', projectId: undefined, projectPath: undefined },
      });

      canvasModule.activate(ctx, api);

      expect(registerFn).toHaveBeenCalled();
      expect(registerFn).toHaveBeenCalledWith('add-agent-view', expect.any(Function));
    });

    it('project-scope activation does NOT register commands', () => {
      const ctx = createMockContext({ pluginId: 'canvas', scope: 'dual', projectId: 'proj-123' });
      const registerFn = vi.fn(() => ({ dispose: vi.fn() }));
      const api = createMockAPI({
        commands: { register: registerFn, execute: async () => {}, registerWithHotkey: () => ({ dispose: () => {} }), getBinding: () => null, clearBinding: () => {} },
        context: { mode: 'project', projectId: 'proj-123', projectPath: '/tmp/proj-123' },
      });

      canvasModule.activate(ctx, api);

      expect(registerFn).not.toHaveBeenCalled();
    });

    it('dual activation emits no overwrite warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const appCtx = createMockContext({ pluginId: 'canvas', scope: 'dual' });
      const appApi = createMockAPI({
        context: { mode: 'app', projectId: undefined, projectPath: undefined },
      });
      canvasModule.activate(appCtx, appApi);

      const projCtx = createMockContext({ pluginId: 'canvas', scope: 'dual', projectId: 'proj-456' });
      const projApi = createMockAPI({
        context: { mode: 'project', projectId: 'proj-456', projectPath: '/tmp/proj-456' },
      });
      canvasModule.activate(projCtx, projApi);

      const overwriteWarnings = warnSpy.mock.calls.filter(
        (args) => String(args[0]).includes('Overwriting existing command'),
      );
      expect(overwriteWarnings).toHaveLength(0);

      warnSpy.mockRestore();
    });
  });

  // #2020: New agent from a card's picker opens the New agent page, which
  // replaces the pane, so the canvas unmounts. A remount reloads the canvas
  // from disk, so a card added while it was away would be lost. Cards are
  // queued instead and placed once the remounted canvas has loaded.
  describe('sibling cards from the New agent page', () => {
    function memoryStorage(fail = { value: false }) {
      const files = new Map<string, unknown>();
      return {
        files,
        fail,
        read: vi.fn(async (key: string) => {
          if (fail.value && key.startsWith('canvas-instances')) {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          }
          return files.get(key);
        }),
        write: vi.fn(async (key: string, value: unknown) => { files.set(key, value); }),
        delete: vi.fn(async (key: string) => { files.delete(key); }),
        list: vi.fn(async () => [...files.keys()]),
      };
    }

    function setup(projectId: string, storage = memoryStorage()) {
      const api = createMockAPI({
        context: { mode: 'project', projectId, projectPath: `/tmp/${projectId}` },
        storage: { project: storage, projectLocal: storage, global: storage },
      });
      const store = canvasModule.getProjectCanvasStore(projectId);
      const mount = () => render(React.createElement(canvasModule.MainPanel, { api }));
      // A mount's reload is done once it has read the wires (the last step).
      const readsWires = () => storage.read.mock.calls.filter(([k]) => k === 'canvas-wires').length;
      async function mountAndLoad() {
        const before = readsWires();
        const view = mount();
        await waitFor(() => expect(readsWires()).toBeGreaterThan(before));
        await waitFor(() => expect(store.getState().loaded).toBe(true));
        return view;
      }
      return { api, store, storage, mount, mountAndLoad };
    }

    const placedFor = (store: ReturnType<typeof canvasModule.getProjectCanvasStore>, agentId: string) =>
      store.getState().canvases.flatMap((c) => c.views.map((v) => ({ canvasId: c.id, view: v })))
        .find(({ view }) => (view as { agentId?: string }).agentId === agentId);

    async function addParent(store: ReturnType<typeof canvasModule.getProjectCanvasStore>, storage: ReturnType<typeof memoryStorage>) {
      let parentId = '';
      act(() => { parentId = store.getState().addView('agent', { x: 100, y: 100 }); });
      await store.getState().saveCanvas(storage);
      return store.getState().views.find((v) => v.id === parentId)!;
    }

    it('places a card queued while the canvas was unmounted, after it reloads', async () => {
      const { store, storage, mountAndLoad } = setup('proj-card-queue-reload');
      const first = await mountAndLoad();
      const parent = await addParent(store, storage);
      first.unmount();

      queueAgentCard(store, { canvasId: store.getState().activeCanvasId, parentViewId: parent.id, fallback: { position: parent.position, size: parent.size }, agentId: 'agent-made-on-page' });

      await mountAndLoad();
      await waitFor(() => expect(placedFor(store, 'agent-made-on-page')).toBeDefined());
      expect(placedFor(store, 'agent-made-on-page')!.view.position.x).toBeGreaterThanOrEqual(parent.position.x + parent.size.width);
      expect(store.getState().views.find((v) => v.id === parent.id)).toBeDefined();
    });

    it('keeps a placed card when the canvas unmounts again right away (before the autosave debounce)', async () => {
      const { store, storage, mountAndLoad } = setup('proj-card-queue-fast-unmount');
      const first = await mountAndLoad();
      const parent = await addParent(store, storage);
      first.unmount();

      queueAgentCard(store, { canvasId: store.getState().activeCanvasId, parentViewId: parent.id, fallback: { position: parent.position, size: parent.size }, agentId: 'agent-1' });
      const second = await mountAndLoad();
      await waitFor(() => expect(placedFor(store, 'agent-1')).toBeDefined());
      // New agent again straight away: the page replaces the pane well inside 500 ms.
      await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
      second.unmount();

      await mountAndLoad();
      expect(placedFor(store, 'agent-1')).toBeDefined();
    });

    it('keeps a moved card when the canvas unmounts before the autosave debounce', async () => {
      const { store, storage, mountAndLoad } = setup('proj-card-queue-fast-move');
      const first = await mountAndLoad();
      const parent = await addParent(store, storage);
      act(() => { store.getState().moveView(parent.id, { x: 700, y: 400 }); });
      first.unmount();

      await mountAndLoad();
      expect(store.getState().views.find((v) => v.id === parent.id)?.position).toEqual({ x: 700, y: 400 });
    });

    it('puts the card on the parent\'s canvas, not the canvas that is active when the agent is made', async () => {
      const { store, storage, mountAndLoad } = setup('proj-card-queue-other-canvas');
      const first = await mountAndLoad();
      const parent = await addParent(store, storage);
      const parentCanvas = store.getState().activeCanvasId;
      queueAgentCard(store, { canvasId: parentCanvas, parentViewId: parent.id, fallback: { position: parent.position, size: parent.size }, agentId: 'agent-elsewhere' });
      // Queued while the parent's canvas is active, so it's placed there at once.
      await waitFor(() => expect(placedFor(store, 'agent-elsewhere')?.canvasId).toBe(parentCanvas));

      // Now queue one while another canvas is active: it waits for the parent's canvas.
      let otherCanvas = '';
      act(() => { otherCanvas = store.getState().addCanvas(); store.getState().setActiveCanvas(otherCanvas); });
      queueAgentCard(store, { canvasId: parentCanvas, parentViewId: parent.id, fallback: { position: parent.position, size: parent.size }, agentId: 'agent-later' });
      await act(async () => { await Promise.resolve(); });
      expect(placedFor(store, 'agent-later')).toBeUndefined();

      act(() => { store.getState().setActiveCanvas(parentCanvas); });
      await waitFor(() => expect(placedFor(store, 'agent-later')?.canvasId).toBe(parentCanvas));
      first.unmount();
    });

    it('focuses the agent\'s existing card instead of placing a second one (#2415)', async () => {
      const { store, storage, mountAndLoad } = setup('proj-card-queue-duplicate');
      const view = await mountAndLoad();
      const parent = await addParent(store, storage);
      let existingId = '';
      act(() => {
        existingId = store.getState().addView('agent', { x: 900, y: 100 });
        store.getState().updateView(existingId, { agentId: 'agent-on-canvas' } as Record<string, unknown>);
      });

      queueAgentCard(store, { canvasId: store.getState().activeCanvasId, parentViewId: parent.id, fallback: { position: parent.position, size: parent.size }, agentId: 'agent-on-canvas' });
      await act(async () => { await Promise.resolve(); });

      const cards = store.getState().views.filter((v) => (v as { agentId?: string }).agentId === 'agent-on-canvas');
      expect(cards.map((v) => v.id)).toEqual([existingId]);
      view.unmount();
    });

    it('picking an agent that already has a card focuses that card and closes the picker (#2415)', async () => {
      const storage = memoryStorage();
      const api = createMockAPI({
        context: { mode: 'project', projectId: 'proj-picker-duplicate', projectPath: '/tmp/proj-picker-duplicate' },
        storage: { project: storage, projectLocal: storage, global: storage },
      });
      const agent = { id: 'agent-on-canvas', name: 'on-canvas', kind: 'durable', status: 'sleeping', projectId: 'proj-picker-duplicate' };
      api.agents.list = () => [agent] as unknown as ReturnType<typeof api.agents.list>;
      const store = canvasModule.getProjectCanvasStore('proj-picker-duplicate');
      const view = render(React.createElement(canvasModule.MainPanel, { api }));
      await waitFor(() => expect(store.getState().loaded).toBe(true));

      let existingId = '';
      let pickerId = '';
      act(() => {
        existingId = store.getState().addView('agent', { x: 900, y: 100 });
        store.getState().updateView(existingId, { agentId: agent.id } as Record<string, unknown>);
        pickerId = store.getState().addView('agent', { x: 100, y: 100 });
      });

      fireEvent.click(await screen.findByTestId(`canvas-agent-pick-${agent.id}`));

      await waitFor(() => expect(store.getState().views.find((v) => v.id === pickerId)).toBeUndefined());
      const cards = store.getState().views.filter((v) => (v as { agentId?: string }).agentId === agent.id);
      expect(cards.map((v) => v.id)).toEqual([existingId]);
      view.unmount();
    });

    it('keeps cards queued through a failed load and places them once the canvas loads', async () => {
      const storage = memoryStorage();
      const { store, mount, mountAndLoad } = setup('proj-card-queue-load-error', storage);
      const first = await mountAndLoad();
      const parent = await addParent(store, storage);
      first.unmount();

      queueAgentCard(store, { canvasId: store.getState().activeCanvasId, parentViewId: parent.id, fallback: { position: parent.position, size: parent.size }, agentId: 'agent-after-error' });

      storage.fail.value = true;
      const failed = mount();
      expect(await screen.findByTestId('canvas-load-error', {}, { timeout: 3000 })).toBeTruthy();
      expect(placedFor(store, 'agent-after-error')).toBeUndefined();
      failed.unmount();

      storage.fail.value = false;
      await mountAndLoad();
      await waitFor(() => expect(placedFor(store, 'agent-after-error')).toBeDefined());
    });

    it('reads after a save the previous mount flushed is written, not before', async () => {
      const storage = memoryStorage();
      const { store, mountAndLoad } = setup('proj-card-queue-inflight', storage);
      const first = await mountAndLoad();

      // Writes hang until released, like a slow disk.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const write = storage.write.getMockImplementation()!;
      storage.write.mockImplementation(async (key: string, value: unknown) => { await gate; return write(key, value); });

      let cardId = '';
      act(() => { cardId = store.getState().addView('agent', { x: 300, y: 300 }); });
      first.unmount(); // flushes the pending save, which is now stuck writing

      const readsBefore = storage.read.mock.calls.filter(([k]) => k === 'canvas-instances').length;
      const second = await act(async () => render(React.createElement(canvasModule.MainPanel, { api: setup('proj-card-queue-inflight', storage).api })));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      // The remount hasn't read the canvas while the save is still writing.
      expect(storage.read.mock.calls.filter(([k]) => k === 'canvas-instances').length).toBe(readsBefore);

      release();
      await waitFor(() => expect(storage.read.mock.calls.filter(([k]) => k === 'canvas-instances').length).toBeGreaterThan(readsBefore));
      await waitFor(() => expect(store.getState().views.find((v) => v.id === cardId)).toBeDefined());
      second.unmount();
    });

    it('places the card on the parent\'s canvas end to end, from the picker\'s New agent', async () => {
      const projectId = 'proj-card-queue-e2e';
      const storage = memoryStorage();
      const agents: Array<{ id: string; name: string; kind: string; status: string; projectId: string; color: string }> = [];
      const api = createMockAPI({
        context: { mode: 'project', projectId, projectPath: `/tmp/${projectId}` },
        storage: { project: storage, projectLocal: storage, global: storage },
        projects: { list: () => [{ id: projectId, name: 'E2E', path: `/tmp/${projectId}` }], getActive: () => null },
      } as never);
      (api.agents as unknown as { list: () => unknown[] }).list = () => agents;
      const store = canvasModule.getProjectCanvasStore(projectId);
      const mountAndLoad = async () => {
        const view = render(React.createElement(canvasModule.MainPanel, { api }));
        await waitFor(() => expect(store.getState().loaded).toBe(true));
        return view;
      };

      const first = await mountAndLoad();
      let parentId = '';
      act(() => { parentId = store.getState().addView('agent', { x: 100, y: 100 }); });
      const parentCanvas = store.getState().activeCanvasId;

      openNewAgentPage.mockReturnValue(true);
      fireEvent.click(await screen.findByTestId('canvas-create-agent'));
      openNewAgentPage.mockReturnValue(false);
      expect(openNewAgentPage).toHaveBeenCalledWith('durable', projectId, expect.objectContaining({ stayInView: true }));
      const { onCreated } = openNewAgentPage.mock.calls.at(-1)![2] as { onCreated: (id: string) => void };

      // The page replaces the pane; meanwhile the user switches to another canvas.
      first.unmount();
      let otherCanvas = '';
      act(() => { otherCanvas = store.getState().addCanvas(); store.getState().setActiveCanvas(otherCanvas); });
      agents.push({ id: 'agent-e2e', name: 'gallant-swift', kind: 'durable', status: 'sleeping', projectId, color: 'emerald' });
      onCreated('agent-e2e');

      const second = await mountAndLoad();
      const findCard = () => store.getState().canvases.flatMap((c) => c.views.map((v) => ({ canvasId: c.id, view: v })))
        .find(({ view }) => (view as { agentId?: string }).agentId === 'agent-e2e');
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(findCard()).toBeUndefined(); // not on the canvas that happens to be active

      act(() => { store.getState().setActiveCanvas(parentCanvas); });
      await waitFor(() => expect(findCard()?.canvasId).toBe(parentCanvas));
      const parent = store.getState().views.find((v) => v.id === parentId)!;
      expect(findCard()!.view.position.x).toBeGreaterThanOrEqual(parent.position.x + parent.size.width);
      expect(findCard()!.view.displayName).toBe('gallant-swift');
      second.unmount();
    });
  });

  // #2076 review: the app canvas store is shared by the local and remote
  // (satellite) views. Switching to a remote host must never write the
  // satellite's canvas into this machine's storage.
  it('does not write a satellite canvas into local storage when switching to a remote host', async () => {
    const files = new Map<string, unknown>();
    const storage = {
      read: vi.fn(async (key: string) => files.get(key)),
      write: vi.fn(async (key: string, value: unknown) => { files.set(key, value); }),
      delete: vi.fn(async (key: string) => { files.delete(key); }),
      list: vi.fn(async () => [...files.keys()]),
    };
    const api = createMockAPI({
      context: { mode: 'app', projectId: undefined, projectPath: undefined },
      storage: { project: storage, projectLocal: storage, global: storage },
    });
    const store = canvasModule.useAppCanvasStore;
    useUIStore.setState({ activeHostId: null });
    useRemoteProjectStore.setState({ remoteAppCanvasState: {} });

    const view = render(React.createElement(canvasModule.MainPanel, { api }));
    await waitFor(() => expect(storage.read.mock.calls.some(([k]) => k === 'canvas-wires')).toBe(true));
    await waitFor(() => expect(store.getState().loaded).toBe(true));
    // Local canvas on disk, then a local change whose save is still pending.
    await act(async () => { store.getState().addView('agent', { x: 0, y: 0 }); await store.getState().saveCanvas(storage); });
    act(() => { store.getState().addView('agent', { x: 600, y: 0 }); });

    act(() => {
      useRemoteProjectStore.setState({
        remoteAppCanvasState: {
          'sat-1': {
            canvases: [{ id: 'REMOTE-CANVAS', name: 'Remote', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0 }],
            activeCanvasId: 'REMOTE-CANVAS',
          },
        },
      });
      useUIStore.setState({ activeHostId: 'sat-1' });
    });
    await waitFor(() => expect(store.getState().activeCanvasId).toBe('REMOTE-CANVAS'));
    // Past the autosave debounce, then away from the canvas (which flushes).
    await act(async () => { await new Promise((r) => setTimeout(r, 650)); });
    view.unmount();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    for (const key of ['canvas-instances', 'canvas-instances-backup', 'canvas-active-id']) {
      expect(JSON.stringify(files.get(key) ?? null)).not.toContain('REMOTE-CANVAS');
    }
    useUIStore.setState({ activeHostId: null });
    useRemoteProjectStore.setState({ remoteAppCanvasState: {} });
  });

  // #2076 re-verification: switching between local and a remote host must
  // keep local edits and never write anything of the satellite's locally.
  describe('switching the app canvas between local and a remote host', () => {
    const REMOTE = {
      canvases: [{ id: 'REMOTE-CANVAS', name: 'Remote', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0 }],
      activeCanvasId: 'REMOTE-CANVAS',
      wireDefinitions: [{ agentId: 'REMOTE-AGENT', targetId: 'remote-target', targetKind: 'agent', label: 'Remote wire' }],
      zoneWireDefinitions: [{ id: 'REMOTE-ZONE-WIRE', sourceZoneId: 'z', targetId: 't', targetType: 'agent' }],
    };
    const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

    function appSetup() {
      const files = new Map<string, unknown>();
      const slow = new Map<string, number>();
      const storage = {
        read: vi.fn(async (key: string) => {
          const ms = slow.get(key);
          if (ms) await new Promise((r) => setTimeout(r, ms));
          return files.get(key);
        }),
        write: vi.fn(async (key: string, value: unknown) => { files.set(key, value); }),
        delete: vi.fn(async (key: string) => { files.delete(key); }),
        list: vi.fn(async () => [...files.keys()]),
      };
      const api = createMockAPI({
        context: { mode: 'app', projectId: undefined, projectPath: undefined },
        storage: { project: storage, projectLocal: storage, global: storage },
      });
      const store = canvasModule.useAppCanvasStore;
      const wireReads = () => storage.read.mock.calls.filter(([k]) => k === 'canvas-wires').length;
      const nothingRemoteSaved = () => {
        const saved = JSON.stringify([...files.entries()]);
        expect(saved).not.toContain('REMOTE-CANVAS');
        expect(saved).not.toContain('REMOTE-AGENT');
        expect(saved).not.toContain('REMOTE-ZONE-WIRE');
      };
      const goRemote = () => act(() => {
        useRemoteProjectStore.setState({ remoteAppCanvasState: { 'sat-1': REMOTE } });
        useUIStore.setState({ activeHostId: 'sat-1' });
      });
      const goLocal = () => act(() => { useUIStore.setState({ activeHostId: null }); });
      return { files, slow, storage, api, store, wireReads, nothingRemoteSaved, goRemote, goLocal };
    }

    async function mountLocal(env: ReturnType<typeof appSetup>) {
      useUIStore.setState({ activeHostId: null });
      useRemoteProjectStore.setState({ remoteAppCanvasState: {} });
      const before = env.wireReads();
      const view = render(React.createElement(canvasModule.MainPanel, { api: env.api }));
      await waitFor(() => expect(env.wireReads()).toBeGreaterThan(before));
      await waitFor(() => expect(env.store.getState().loaded).toBe(true));
      // A local canvas on disk.
      await act(async () => { env.store.getState().addView('agent', { x: 0, y: 0 }); await env.store.getState().saveCanvas(env.storage); });
      return view;
    }

    afterEach(() => {
      useUIStore.setState({ activeHostId: null });
      useRemoteProjectStore.setState({ remoteAppCanvasState: {} });
    });

    it('keeps a local edit made just before switching to a remote host', async () => {
      const env = appSetup();
      const view = await mountLocal(env);
      let editId = '';
      act(() => { editId = env.store.getState().addView('agent', { x: 900, y: 0 }); });
      env.goRemote(); // well inside the 500 ms autosave debounce
      await waitFor(() => expect(env.store.getState().activeCanvasId).toBe('REMOTE-CANVAS'));
      await sleep(650);
      view.unmount();
      await sleep(20);

      expect(JSON.stringify(env.files.get('canvas-instances'))).toContain(editId);
      env.nothingRemoteSaved();
    });

    it('keeps a local edit made just before switching to a host whose canvas has not loaded yet', async () => {
      const env = appSetup();
      const view = await mountLocal(env);
      let editId = '';
      act(() => { editId = env.store.getState().addView('agent', { x: 900, y: 0 }); });
      // A host with no canvas state yet: the load effect has nothing to hydrate.
      act(() => { useUIStore.setState({ activeHostId: 'sat-not-loaded' }); });
      await sleep(650);
      view.unmount();
      await sleep(20);

      expect(JSON.stringify(env.files.get('canvas-instances'))).toContain(editId);
      env.nothingRemoteSaved();
    });

    it('writes nothing remote while a slow local load runs on the switch back', async () => {
      const env = appSetup();
      const view = await mountLocal(env);
      env.goRemote();
      await waitFor(() => expect(env.store.getState().activeCanvasId).toBe('REMOTE-CANVAS'));

      // Back to local, with a load slower than the autosave debounce.
      env.slow.set('canvas-active-id', 800);
      env.goLocal();
      await sleep(1000); // the switch-back autosave fires mid-load
      env.nothingRemoteSaved();
      await waitFor(() => expect(env.store.getState().activeCanvasId).not.toBe('REMOTE-CANVAS'), { timeout: 3000 });
      await sleep(650);
      view.unmount();
      await sleep(20);
      env.nothingRemoteSaved();
    });

    it('does not keep a satellite\'s wires when the local wires file is empty', async () => {
      const env = appSetup();
      env.files.set('canvas-wires', []);
      const view = await mountLocal(env);
      env.goRemote();
      await waitFor(() => expect(env.store.getState().wireDefinitions.some((w) => w.agentId === 'REMOTE-AGENT')).toBe(true));

      const before = env.wireReads();
      env.goLocal();
      await waitFor(() => expect(env.wireReads()).toBeGreaterThan(before));
      await waitFor(() => expect(env.store.getState().wireDefinitions.some((w) => w.agentId === 'REMOTE-AGENT')).toBe(false));
      await sleep(650);
      view.unmount();
      await sleep(20);
      env.nothingRemoteSaved();
    });
  });
});
