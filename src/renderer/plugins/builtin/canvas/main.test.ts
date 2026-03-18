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

  it('activate registers add-agent-view command', () => {
    const ctx = createMockContext({ pluginId: 'canvas', scope: 'dual' });
    const registerFn = vi.fn(() => ({ dispose: () => {} }));
    const api = createMockAPI({
      commands: { register: registerFn, execute: async () => {}, registerWithHotkey: () => ({ dispose: () => {} }), getBinding: () => null, clearBinding: () => {} },
    });

    canvasModule.activate(ctx, api);

    expect(registerFn).toHaveBeenCalledWith('add-agent-view', expect.any(Function));
    expect(registerFn).toHaveBeenCalledWith('add-file-view', expect.any(Function));
    expect(registerFn).toHaveBeenCalledWith('reset-viewport', expect.any(Function));
  });

  it('activate pushes disposables to ctx.subscriptions', () => {
    const ctx = createMockContext({ pluginId: 'canvas', scope: 'dual' });
    const api = createMockAPI();

    canvasModule.activate(ctx, api);

    expect(ctx.subscriptions).toHaveLength(6);
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

  it('per-project stores have isolated state', () => {
    const storeA = canvasModule.getProjectCanvasStore('canvas-proj-iso-a');
    const storeB = canvasModule.getProjectCanvasStore('canvas-proj-iso-b');

    // Add a view to store A
    storeA.getState().addView('agent', { x: 100, y: 100 });
    expect(storeA.getState().views).toHaveLength(1);

    // Store B should be unaffected
    expect(storeB.getState().views).toHaveLength(0);
  });
});
