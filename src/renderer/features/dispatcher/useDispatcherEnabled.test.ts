import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { DispatcherState } from '../../../shared/dispatcher-types';
import { useDispatcherEnabled, useDispatcherFlagOn, useDispatcherRead, useDispatcherState } from './useDispatcherEnabled';

const ON: DispatcherState = { enabled: true, flagOn: true, agentId: 'durable_1', path: 'dispatcher-dir', config: null };

describe('useDispatcherState', () => {
  let listener: ((s: DispatcherState) => void) | null;

  beforeEach(() => {
    listener = null;
    window.clubhouse.dispatcher.onChanged = vi.fn((cb) => {
      listener = cb;
      return () => { listener = null; };
    });
  });

  it('starts null and false, then reads main', async () => {
    window.clubhouse.dispatcher.get = vi.fn().mockResolvedValue(ON);
    const state = renderHook(() => useDispatcherState());
    const enabled = renderHook(() => useDispatcherEnabled());
    expect(state.result.current).toBeNull();
    expect(enabled.result.current).toBe(false);
    await waitFor(() => expect(state.result.current).toEqual(ON));
    await waitFor(() => expect(enabled.result.current).toBe(true));
  });

  it('follows change events and unsubscribes on unmount', async () => {
    window.clubhouse.dispatcher.get = vi.fn().mockResolvedValue({ ...ON, enabled: false });
    const { result, unmount } = renderHook(() => useDispatcherEnabled());
    await waitFor(() => expect(window.clubhouse.dispatcher.get).toHaveBeenCalled());
    act(() => listener?.(ON));
    expect(result.current).toBe(true);
    unmount();
    expect(listener).toBeNull();
  });

  it('keeps a change event that lands before the first read', async () => {
    let resolve!: (s: DispatcherState) => void;
    window.clubhouse.dispatcher.get = vi.fn(() => new Promise<DispatcherState>((r) => { resolve = r; }));
    const { result } = renderHook(() => useDispatcherEnabled());
    act(() => listener?.(ON));
    await act(async () => { resolve({ ...ON, enabled: false }); });
    expect(result.current).toBe(true);
  });

  it('exposes a failed read, and Retry reads again', async () => {
    window.clubhouse.dispatcher.get = vi.fn().mockRejectedValueOnce(new Error('IPC down')).mockResolvedValue(ON);
    const { result } = renderHook(() => useDispatcherRead());
    await waitFor(() => expect(result.current.error).toBe('IPC down'));
    expect(result.current.state).toBeNull();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state).toEqual(ON));
    expect(result.current.error).toBeNull();
  });

  it('reports the flag apart from the setting', async () => {
    window.clubhouse.dispatcher.get = vi.fn().mockResolvedValue({ ...ON, enabled: false, flagOn: false });
    const { result } = renderHook(() => useDispatcherFlagOn());
    await waitFor(() => expect(window.clubhouse.dispatcher.get).toHaveBeenCalled());
    expect(result.current).toBe(false);
    act(() => listener?.({ ...ON, enabled: false }));
    expect(result.current).toBe(true);
  });
});
