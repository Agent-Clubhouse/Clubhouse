import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import type { CanvasMembership } from '../../../../shared/canvas-index-types';
import { getProjectCanvasStore, useAppCanvasStore } from '../../../plugins/builtin/canvas/main';
import type { CanvasInstance } from '../../../plugins/builtin/canvas/canvas-types';
import { jumpToCanvas, mergeCanvasHits, remoteCanvasJumpUnavailable, useAgentCanvases } from './agent-canvases';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { useUIStore } from '../../../stores/uiStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';

const agent = { id: 'durable_a', projectId: 'p-index', name: 'robin', kind: 'durable' } as Agent;

const indexed: CanvasMembership[] = [
  { scope: 'project', projectId: 'p-index', canvasId: 'c-disk', name: 'from disk', viewId: 'v-disk' },
  { scope: 'app', canvasId: 'h-disk', name: 'home on disk', viewId: 'hv-disk' },
];

function canvasWith(id: string, name: string, agentId: string, viewId: string): CanvasInstance {
  return {
    id, name, viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null, selectedViewId: null,
    minimapAutoHide: true, elkAlgorithm: 'layered', elkDirection: 'RIGHT', layoutCenterId: null,
    views: [{ id: viewId, type: 'agent', agentId, position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, title: 'a', displayName: 'a', zIndex: 0, metadata: {} } as never],
  };
}

beforeEach(() => {
  getProjectCanvasStore('p-index').setState({ canvases: [], loaded: false });
  useAppCanvasStore.setState({ canvases: [], loaded: false });
  window.clubhouse.canvas.getAgentCanvases = vi.fn(async () => indexed);
});

describe('mergeCanvasHits', () => {
  it('uses the index for a scope whose store has not loaded', () => {
    expect(mergeCanvasHits({ project: null, app: null }, indexed)).toEqual([
      { scope: 'project', canvasId: 'c-disk', name: 'from disk', viewId: 'v-disk' },
      { scope: 'app', canvasId: 'h-disk', name: 'home on disk', viewId: 'hv-disk' },
    ]);
  });

  it('prefers a loaded store, even when it no longer has the agent', () => {
    expect(mergeCanvasHits({ project: [], app: null }, indexed)).toEqual([
      { scope: 'app', canvasId: 'h-disk', name: 'home on disk', viewId: 'hv-disk' },
    ]);
  });
});

describe('useAgentCanvases', () => {
  it('reports canvases from disk before any canvas has been opened (#1544)', async () => {
    const { result } = renderHook(() => useAgentCanvases(agent));
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(window.clubhouse.canvas.getAgentCanvases).toHaveBeenCalledWith('durable_a', 'p-index');
  });

  it('switches to the live store once it loads', async () => {
    const { result } = renderHook(() => useAgentCanvases(agent));
    await waitFor(() => expect(result.current).toHaveLength(2));
    act(() => {
      getProjectCanvasStore('p-index').setState({ canvases: [canvasWith('c-live', 'live', 'durable_a', 'v-live')], loaded: true });
    });
    expect(result.current.map((h) => h.canvasId)).toEqual(['c-live', 'h-disk']);
  });

  it('does not ask main when both stores are loaded', () => {
    getProjectCanvasStore('p-index').setState({ canvases: [], loaded: true });
    useAppCanvasStore.setState({ canvases: [], loaded: true });
    const { result } = renderHook(() => useAgentCanvases(agent));
    expect(result.current).toEqual([]);
    expect(window.clubhouse.canvas.getAgentCanvases).not.toHaveBeenCalled();
  });
});

describe('jumpToCanvas', () => {
  it('selects the card after the store loads, not before', () => {
    const store = getProjectCanvasStore('p-index');
    jumpToCanvas(agent, { scope: 'project', canvasId: 'c2', name: 'two', viewId: 'v2' });
    expect(store.getState().selectedViewId).toBeNull();

    // The canvas tab mounts and loads from disk, restoring its saved active canvas.
    act(() => {
      store.setState({
        canvases: [canvasWith('c1', 'one', 'other', 'v1'), canvasWith('c2', 'two', 'durable_a', 'v2')],
        activeCanvasId: 'c1',
        loaded: true,
      });
    });
    expect(store.getState().activeCanvasId).toBe('c2');
    expect(store.getState().selectedViewId).toBe('v2');
  });
  const remote = { ...agent, id: 'remote||sat||durable_a', projectId: 'remote||sat||p-index' };
  const homeHit = { scope: 'app' as const, canvasId: 'shared-c', name: 'Host board', viewId: 'shared-v' };
  function shareBoard() {
    useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: { appCanvasState: { canvases: [canvasWith('shared-c', 'Host board', 'durable_a', 'shared-v')], activeCanvasId: 'shared-c' } } }] as never });
    const snapshot = { canvases: [canvasWith('shared-c', 'Host board', remote.id, 'shared-v')], activeCanvasId: 'shared-c' };
    useRemoteProjectStore.setState({ remoteAppCanvasState: { sat: snapshot } });
    return { hostId: 'sat', snapshot };
  }
  it('waits for the right host hydration instead of focusing a colliding local or other-host Home card', () => {
    const source = shareBoard();
    const local = canvasWith('shared-c', 'Local board', remote.id, 'shared-v');
    useAppCanvasStore.setState({ canvases: [local], activeCanvasId: 'shared-c', selectedViewId: null, loaded: true, dataOrigin: 'local' });
    jumpToCanvas(remote, homeHit);
    expect(useUIStore.getState().activeHostId).toBe('sat');
    expect(useProjectStore.getState().activeProjectId).toBeNull();
    expect(useAppCanvasStore.getState().selectedViewId).toBeNull();
    useAppCanvasStore.getState().hydrateFromRemote([canvasWith('shared-c', 'Other host', remote.id, 'shared-v')], 'shared-c', [], [], { hostId: 'other', snapshot: source.snapshot });
    expect(useAppCanvasStore.getState().selectedViewId).toBeNull();
    useAppCanvasStore.getState().hydrateFromRemote(source.snapshot.canvases, 'shared-c', [], [], source);
    expect(useAppCanvasStore.getState().selectedViewId).toBe('shared-v');
    expect(useAppCanvasStore.getState().dataOrigin).toBe('remote');
    expect(local.selectedViewId).toBeNull();
  });
  it('does not focus an already-loaded different host board containing the identical remote agent/card ids', () => {
    const source = shareBoard();
    useAppCanvasStore.getState().hydrateFromRemote([canvasWith('shared-c', 'Other host', remote.id, 'shared-v')], 'shared-c', [], [], { hostId: 'other', snapshot: source.snapshot });
    jumpToCanvas(remote, homeHit);
    expect(useAppCanvasStore.getState().selectedViewId).toBeNull();
    // The host name alone cannot bless a prior snapshot either.
    useAppCanvasStore.getState().hydrateFromRemote(source.snapshot.canvases, 'shared-c', [], [], { hostId: 'sat', snapshot: { ...source.snapshot } });
    expect(useAppCanvasStore.getState().selectedViewId).toBeNull();
    useAppCanvasStore.getState().hydrateFromRemote(source.snapshot.canvases, 'shared-c', [], [], source);
    expect(useAppCanvasStore.getState().selectedViewId).toBe('shared-v');
  });
  it('refuses a copied retained canvas with a matching source identity when the current snapshot says canvas data was omitted', () => {
    const source = shareBoard();
    useAppCanvasStore.getState().hydrateFromRemote(source.snapshot.canvases, 'shared-c', [], [], source);
    useUIStore.getState().setActiveHost('other');
    useAnnexClientStore.setState((s) => ({ satellites: s.satellites.map((h) => ({ ...h, snapshot: { ...h.snapshot, snapshotTruncated: { omitted: ['canvasState'] } } })) as never }));
    expect(remoteCanvasJumpUnavailable(remote, homeHit)).toContain('may be stale');
    jumpToCanvas(remote, homeHit);
    expect(useUIStore.getState().activeHostId).toBe('other');
    expect(useAppCanvasStore.getState().selectedViewId).toBeNull();
  });
  it('refuses stale/omitted/malformed snapshots and cancels a pending jump when the host changes', () => {
    shareBoard();
    jumpToCanvas(remote, homeHit);
    useUIStore.getState().setActiveHost('other');
    useAppCanvasStore.getState().hydrateFromRemote([canvasWith('shared-c', 'Host board', remote.id, 'shared-v')], 'shared-c');
    expect(useAppCanvasStore.getState().selectedViewId).not.toBe('shared-v');
    for (const snapshot of [{}, { appCanvasState: {} }, { appCanvasState: { canvases: null } }, { appCanvasState: { canvases: [null, {}, { id: 'shared-c', views: [null] }] } }]) {
      useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot }] as never });
      expect(remoteCanvasJumpUnavailable(remote, homeHit)).toContain('not in the host');
      jumpToCanvas(remote, homeHit);
      expect(useUIStore.getState().activeHostId).toBe('other');
    }
    shareBoard();
    useAnnexClientStore.setState((s) => ({ satellites: s.satellites.map((h) => ({ ...h, snapshotUnavailable: true })) }));
    expect(remoteCanvasJumpUnavailable(remote, homeHit)).toContain('Reconnect');
  });
  it('opens a project membership in the namespaced project without changing host board contents', () => {
    const hit = { ...homeHit, scope: 'project' as const };
    const board = canvasWith('shared-c', 'Project board', 'durable_a', 'shared-v');
    useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: { canvasState: { 'p-index': { canvases: [board], activeCanvasId: 'shared-c' } } } }] as never });
    const store = getProjectCanvasStore(remote.projectId!);
    const snapshot = { canvases: [{ ...board, views: board.views.map((v) => ({ ...v, agentId: remote.id })) }], activeCanvasId: 'shared-c' };
    useRemoteProjectStore.setState({ remoteCanvasState: { [remote.projectId!]: snapshot } });
    store.setState({ loaded: false, dataOrigin: null, selectedViewId: null });
    jumpToCanvas(remote, hit);
    expect(useProjectStore.getState().activeProjectId).toBe(remote.projectId);
    store.getState().hydrateFromRemote(snapshot.canvases, 'shared-c', [], [], { hostId: 'sat', snapshot });
    expect(store.getState().selectedViewId).toBe('shared-v');
    expect(board.views[0].agentId).toBe('durable_a');
    expect(window.clubhouse.canvas.getAgentCanvases).not.toHaveBeenCalled();
  });
});
