import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import type { CanvasMembership } from '../../../../shared/canvas-index-types';
import { getProjectCanvasStore, useAppCanvasStore } from '../../../plugins/builtin/canvas/main';
import type { CanvasInstance } from '../../../plugins/builtin/canvas/canvas-types';
import { jumpToCanvas, mergeCanvasHits, useAgentCanvases } from './agent-canvases';

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
});
