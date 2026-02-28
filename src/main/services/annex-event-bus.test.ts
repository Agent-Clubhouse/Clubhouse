import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setActive,
  isActive,
  emitPtyData,
  emitHookEvent,
  emitPtyExit,
  onPtyData,
  onHookEvent,
  onPtyExit,
  onAgentSpawned,
  removeAllListeners,
  getListenerCounts,
} from './annex-event-bus';

beforeEach(() => {
  setActive(false);
  removeAllListeners();
});

describe('annex-event-bus', () => {
  it('does not call listeners when inactive', () => {
    const fn = vi.fn();
    onPtyData(fn);
    emitPtyData('agent1', 'hello');
    expect(fn).not.toHaveBeenCalled();
  });

  it('calls listeners when active', () => {
    const fn = vi.fn();
    onPtyData(fn);
    setActive(true);
    emitPtyData('agent1', 'hello');
    expect(fn).toHaveBeenCalledWith('agent1', 'hello');
  });

  it('unsubscribes correctly', () => {
    const fn = vi.fn();
    const unsub = onPtyData(fn);
    setActive(true);
    unsub();
    emitPtyData('agent1', 'hello');
    expect(fn).not.toHaveBeenCalled();
  });

  it('emits hook events', () => {
    const fn = vi.fn();
    onHookEvent(fn);
    setActive(true);
    const event = { kind: 'pre_tool' as const, toolName: 'Edit', timestamp: Date.now() };
    emitHookEvent('agent1', event);
    expect(fn).toHaveBeenCalledWith('agent1', event);
  });

  it('emits pty exit events', () => {
    const fn = vi.fn();
    onPtyExit(fn);
    setActive(true);
    emitPtyExit('agent1', 0);
    expect(fn).toHaveBeenCalledWith('agent1', 0);
  });

  it('supports multiple listeners', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    onPtyData(fn1);
    onPtyData(fn2);
    setActive(true);
    emitPtyData('agent1', 'data');
    expect(fn1).toHaveBeenCalled();
    expect(fn2).toHaveBeenCalled();
  });

  it('isActive reflects setActive', () => {
    expect(isActive()).toBe(false);
    setActive(true);
    expect(isActive()).toBe(true);
    setActive(false);
    expect(isActive()).toBe(false);
  });

  it('removeAllListeners clears everything', () => {
    const fn = vi.fn();
    onPtyData(fn);
    onHookEvent(fn);
    onPtyExit(fn);
    setActive(true);
    removeAllListeners();
    emitPtyData('a', 'd');
    emitHookEvent('a', { kind: 'stop', timestamp: 0 });
    emitPtyExit('a', 1);
    expect(fn).not.toHaveBeenCalled();
  });

  describe('getListenerCounts', () => {
    it('returns zero counts when no listeners registered', () => {
      const counts = getListenerCounts();
      expect(counts).toEqual({ ptyData: 0, hookEvent: 0, ptyExit: 0, agentSpawned: 0, total: 0 });
    });

    it('tracks listener counts per type', () => {
      onPtyData(vi.fn());
      onPtyData(vi.fn());
      onHookEvent(vi.fn());
      onPtyExit(vi.fn());
      onAgentSpawned(vi.fn());

      const counts = getListenerCounts();
      expect(counts.ptyData).toBe(2);
      expect(counts.hookEvent).toBe(1);
      expect(counts.ptyExit).toBe(1);
      expect(counts.agentSpawned).toBe(1);
      expect(counts.total).toBe(5);
    });

    it('decrements after unsubscribe', () => {
      const unsub1 = onPtyData(vi.fn());
      const unsub2 = onPtyData(vi.fn());
      expect(getListenerCounts().ptyData).toBe(2);

      unsub1();
      expect(getListenerCounts().ptyData).toBe(1);

      unsub2();
      expect(getListenerCounts().ptyData).toBe(0);
    });

    it('resets to zero after removeAllListeners', () => {
      onPtyData(vi.fn());
      onHookEvent(vi.fn());
      onPtyExit(vi.fn());
      onAgentSpawned(vi.fn());
      expect(getListenerCounts().total).toBe(4);

      removeAllListeners();
      expect(getListenerCounts().total).toBe(0);
    });
  });
});
