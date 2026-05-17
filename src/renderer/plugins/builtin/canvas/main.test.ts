/* eslint-disable no-restricted-syntax -- TODO(TC-CRIT-03): structural readFileSync tests pending behavioral conversion */
import { describe, it, expect, vi } from 'vitest';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { manifest } from './manifest';
import * as canvasModule from './main';
import { createMockContext, createMockAPI } from '../../testing';

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
      source.indexOf('wireDefinitions, minimapAutoHide, elkAlgorithm, elkDirection, layoutCenterId, loaded, wiresLoaded, scheduleSave'),
      source.indexOf('wireDefinitions, minimapAutoHide, elkAlgorithm, elkDirection, layoutCenterId, loaded, wiresLoaded, scheduleSave') + 140,
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
    expect(source).toContain('mcpBinding.bind');
  });

  it('group-project wire defaults use shared migration-aware helper (structural)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf-8');

    expect(source).toContain('getDefaultGroupProjectDisabledToolsFromMetadata');
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
});
