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
  removeAllListeners,
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
});
