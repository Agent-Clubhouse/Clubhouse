import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { DISPATCHER_OFF, type DispatcherState } from '../../../shared/dispatcher-types';
import { useDispatcherConnection, useDispatcherRead, useDispatcherState } from './useDispatcherEnabled';

const useDispatcherEnabled = () => useDispatcherState()?.enabled ?? false;

const ON: DispatcherState = { ...DISPATCHER_OFF, enabled: true, savedOn: true, offReason: null, agentId: 'durable_1', path: 'dispatcher-dir', config: null };

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

  it('shows the Connect row only while it is on', async () => {
    window.clubhouse.dispatcher.get = vi.fn().mockResolvedValue({ ...ON, enabled: false, offReason: 'switch_off' });
    const { result } = renderHook(() => useDispatcherConnection());
    await waitFor(() => expect(window.clubhouse.dispatcher.get).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toEqual({ show: false }));
    act(() => listener?.(ON));
    expect(result.current).toEqual({ show: true });
  });
});
