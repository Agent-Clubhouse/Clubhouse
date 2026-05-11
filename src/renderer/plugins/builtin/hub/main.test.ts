import { describe, it, expect, vi } from 'vitest';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { manifest } from './manifest';
import * as hubModule from './main';
import { createMockContext, createMockAPI } from '../../testing';

describe('hub main', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: hubModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('activate registers split-pane command', () => {
    const ctx = createMockContext({ pluginId: 'hub', scope: 'dual' });
    const registerFn = vi.fn(() => ({ dispose: () => {} }));
    const api = createMockAPI({
      commands: { register: registerFn, execute: async () => {} },
    });

    hubModule.activate(ctx, api);

    expect(registerFn).toHaveBeenCalledWith('split-pane', expect.any(Function));
  });

  it('activate pushes command disposable to ctx.subscriptions (app mode — no project cleanup)', () => {
    const ctx = createMockContext({ pluginId: 'hub', scope: 'app', projectId: undefined });
    const api = createMockAPI();

    hubModule.activate(ctx, api);

    expect(ctx.subscriptions).toHaveLength(1);
    expect(typeof ctx.subscriptions[0].dispose).toBe('function');
  });

  it('activate pushes command + cleanup disposables when projectId is set', () => {
    const ctx = createMockContext({ pluginId: 'hub', scope: 'dual', projectId: 'proj-x' });
    const api = createMockAPI();

    hubModule.activate(ctx, api);

    expect(ctx.subscriptions).toHaveLength(2);
    expect(typeof ctx.subscriptions[0].dispose).toBe('function');
    expect(typeof ctx.subscriptions[1].dispose).toBe('function');
  });

  it('deactivate does not throw', () => {
    expect(() => hubModule.deactivate()).not.toThrow();
  });

  it('exports MainPanel component', () => {
    expect(hubModule.MainPanel).toBeDefined();
    expect(typeof hubModule.MainPanel).toBe('function');
  });

  it('exports getProjectHubStore function', () => {
    expect(hubModule.getProjectHubStore).toBeDefined();
    expect(typeof hubModule.getProjectHubStore).toBe('function');
  });

  it('exports hasProjectHubStore function', () => {
    expect(hubModule.hasProjectHubStore).toBeDefined();
    expect(typeof hubModule.hasProjectHubStore).toBe('function');
  });

  it('hasProjectHubStore returns false for unknown project', () => {
    expect(hubModule.hasProjectHubStore('nonexistent-project')).toBe(false);
  });

  it('hasProjectHubStore returns false for null', () => {
    expect(hubModule.hasProjectHubStore(null)).toBe(false);
  });

  it('hasProjectHubStore returns true after store is created', () => {
    const projectId = 'proj-has-check';
    expect(hubModule.hasProjectHubStore(projectId)).toBe(false);
    hubModule.getProjectHubStore(projectId);
    expect(hubModule.hasProjectHubStore(projectId)).toBe(true);
  });

  it('getProjectHubStore returns the same store for the same projectId', () => {
    const store1 = hubModule.getProjectHubStore('proj-1');
    const store2 = hubModule.getProjectHubStore('proj-1');
    expect(store1).toBe(store2);
  });

  it('getProjectHubStore returns different stores for different projectIds', () => {
    const storeA = hubModule.getProjectHubStore('proj-a');
    const storeB = hubModule.getProjectHubStore('proj-b');
    expect(storeA).not.toBe(storeB);
  });

  it('per-project stores have isolated state', () => {
    const storeA = hubModule.getProjectHubStore('proj-iso-a');
    const storeB = hubModule.getProjectHubStore('proj-iso-b');

    // Modify store A
    const paneId = storeA.getState().paneTree.id;
    storeA.getState().assignAgent(paneId, 'agent-1', 'proj-iso-a');

    // Store B should be unaffected
    const leafB = storeB.getState().paneTree;
    expect(leafB.type).toBe('leaf');
    expect((leafB as any).agentId).toBeNull();
  });

  describe('LB-PU-003: hub store lifecycle fixes', () => {
    it('getProjectHubStore(null) returns a stable store instead of a new throwaway store', () => {
      const store1 = hubModule.getProjectHubStore(null);
      const store2 = hubModule.getProjectHubStore(null);
      // Must return the same reference (app store), not a new store each time
      expect(store1).toBe(store2);
    });

    it('removeProjectHubStore removes the store from the registry', () => {
      const projectId = 'proj-to-remove';
      hubModule.getProjectHubStore(projectId);
      expect(hubModule.hasProjectHubStore(projectId)).toBe(true);

      hubModule.removeProjectHubStore(projectId);

      expect(hubModule.hasProjectHubStore(projectId)).toBe(false);
    });

    it('activate cleanup subscription removes project store on dispose', () => {
      const projectId = 'proj-cleanup-dispose';
      const ctx = createMockContext({ pluginId: 'hub', scope: 'dual', projectId });
      const api = createMockAPI();

      hubModule.activate(ctx, api);
      // Ensure the store exists
      hubModule.getProjectHubStore(projectId);
      expect(hubModule.hasProjectHubStore(projectId)).toBe(true);

      // Dispose the cleanup subscription (simulates project close)
      const cleanupSub = ctx.subscriptions[1];
      cleanupSub.dispose();

      expect(hubModule.hasProjectHubStore(projectId)).toBe(false);
    });

    it('getProjectHubStore creates a new store after removal (clean slate)', () => {
      const projectId = 'proj-recreate';
      const store1 = hubModule.getProjectHubStore(projectId);
      hubModule.removeProjectHubStore(projectId);
      const store2 = hubModule.getProjectHubStore(projectId);
      expect(store1).not.toBe(store2);
    });

    it('removeProjectHubStore is a no-op for unknown project', () => {
      expect(() => hubModule.removeProjectHubStore('does-not-exist')).not.toThrow();
    });
  });
});
