import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useChatStore } from '../../../stores/chatStore';
import { useToastStore } from '../../../stores/toastStore';
import { useChatActions } from './useChatSession';

describe('useChatActions results (#2057)', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('resolves true when interrupt and setLevel succeed', async () => {
    useChatStore.setState({ interrupt: vi.fn(async () => {}), setLevel: vi.fn(async () => {}) });
    const { result } = renderHook(() => useChatActions('agent-1'));
    await expect(result.current.interrupt()).resolves.toBe(true);
    await expect(result.current.setLevel('ask')).resolves.toBe(true);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('resolves false with a toast when interrupt fails', async () => {
    useChatStore.setState({ interrupt: vi.fn(async () => { throw new Error('not running'); }) });
    const { result } = renderHook(() => useChatActions('agent-1'));
    await expect(result.current.interrupt()).resolves.toBe(false);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["Couldn't stop the turn: not running"]);
  });

  it('resolves false with a toast when setLevel fails', async () => {
    useChatStore.setState({ setLevel: vi.fn(async () => { throw new Error('not live'); }) });
    const { result } = renderHook(() => useChatActions('agent-1'));
    await expect(result.current.setLevel('auto')).resolves.toBe(false);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["Couldn't change the permission level: not live"]);
  });
});
