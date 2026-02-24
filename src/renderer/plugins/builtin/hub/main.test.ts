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

  it('activate pushes disposable to ctx.subscriptions', () => {
    const ctx = createMockContext({ pluginId: 'hub', scope: 'dual' });
    const api = createMockAPI();

    hubModule.activate(ctx, api);

    expect(ctx.subscriptions).toHaveLength(1);
    expect(typeof ctx.subscriptions[0].dispose).toBe('function');
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
});
