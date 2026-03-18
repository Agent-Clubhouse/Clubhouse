import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePopouts } from './usePopouts';

describe('usePopouts', () => {
  let popoutsChangedCallback: (() => void) | null = null;

  beforeEach(() => {
    popoutsChangedCallback = null;
    window.clubhouse.window.listPopouts = vi.fn().mockResolvedValue([]);
    window.clubhouse.window.onPopoutsChanged = vi.fn().mockImplementation((cb: () => void) => {
      popoutsChangedCallback = cb;
      return () => { popoutsChangedCallback = null; };
    });
  });

  it('fetches popouts on mount', async () => {
    const mockPopouts = [
      { windowId: 1, params: { type: 'agent' as const, agentId: 'a1' } },
    ];
    window.clubhouse.window.listPopouts = vi.fn().mockResolvedValue(mockPopouts);

    const { result } = renderHook(() => usePopouts());

    await waitFor(() => {
      expect(result.current.popouts).toEqual(mockPopouts);
    });
  });

  it('refreshes when POPOUTS_CHANGED fires', async () => {
    window.clubhouse.window.listPopouts = vi.fn().mockResolvedValue([]);

    const { result } = renderHook(() => usePopouts());

    await waitFor(() => {
      expect(result.current.popouts).toEqual([]);
    });

    // Update the mock and fire the change event
    const newPopouts = [
      { windowId: 5, params: { type: 'hub' as const, hubId: 'h1' } },
    ];
    window.clubhouse.window.listPopouts = vi.fn().mockResolvedValue(newPopouts);

    act(() => {
      popoutsChangedCallback?.();
    });

    await waitFor(() => {
      expect(result.current.popouts).toEqual(newPopouts);
    });
  });

  it('findAgentPopout returns matching entry', async () => {
    const mockPopouts = [
      { windowId: 1, params: { type: 'agent' as const, agentId: 'a1' } },
      { windowId: 2, params: { type: 'hub' as const, hubId: 'h1' } },
    ];
    window.clubhouse.window.listPopouts = vi.fn().mockResolvedValue(mockPopouts);

    const { result } = renderHook(() => usePopouts());

    await waitFor(() => {
      expect(result.current.popouts.length).toBe(2);
    });

    expect(result.current.findAgentPopout('a1')).toEqual(mockPopouts[0]);
    expect(result.current.findAgentPopout('nonexistent')).toBeUndefined();
  });

  it('findHubPopout returns matching entry', async () => {
    const mockPopouts = [
      { windowId: 3, params: { type: 'hub' as const, hubId: 'h1' } },
    ];
    window.clubhouse.window.listPopouts = vi.fn().mockResolvedValue(mockPopouts);

    const { result } = renderHook(() => usePopouts());

    await waitFor(() => {
      expect(result.current.popouts.length).toBe(1);
    });

    expect(result.current.findHubPopout('h1')).toEqual(mockPopouts[0]);
    expect(result.current.findHubPopout('other')).toBeUndefined();
  });

  it('findCanvasPopout returns matching entry', async () => {
    const mockPopouts = [
      { windowId: 7, params: { type: 'canvas' as const, canvasId: 'c1' } },
    ];
    window.clubhouse.window.listPopouts = vi.fn().mockResolvedValue(mockPopouts);

    const { result } = renderHook(() => usePopouts());

    await waitFor(() => {
      expect(result.current.popouts.length).toBe(1);
    });

    expect(result.current.findCanvasPopout('c1')).toEqual(mockPopouts[0]);
    expect(result.current.findCanvasPopout('other')).toBeUndefined();
  });

  it('cleans up listener on unmount', async () => {
    const { unmount } = renderHook(() => usePopouts());

    await waitFor(() => {
      expect(window.clubhouse.window.onPopoutsChanged).toHaveBeenCalled();
    });

    unmount();
    expect(popoutsChangedCallback).toBeNull();
  });
});
