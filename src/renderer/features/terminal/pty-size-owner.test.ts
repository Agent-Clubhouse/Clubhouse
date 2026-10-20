import { describe, it, expect, vi, beforeEach } from 'vitest';
import { claimSizeOwner, isSizeOwner, registerSizeOwner, _resetSizeOwnersForTests } from './pty-size-owner';

describe('pty-size-owner', () => {
  beforeEach(() => _resetSizeOwnersForTests());

  it('makes the first terminal of a session its owner', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    registerSizeOwner('s1', a, vi.fn());
    registerSizeOwner('s1', b, vi.fn());
    expect(isSizeOwner('s1', a)).toBe(true);
    expect(isSizeOwner('s1', b)).toBe(false);
  });

  it('keeps sessions independent', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    registerSizeOwner('s1', a, vi.fn());
    registerSizeOwner('s2', b, vi.fn());
    expect(isSizeOwner('s1', a)).toBe(true);
    expect(isSizeOwner('s2', b)).toBe(true);
  });

  it('moves ownership to the terminal that claims it', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    registerSizeOwner('s1', a, vi.fn());
    registerSizeOwner('s1', b, vi.fn());
    claimSizeOwner('s1', b);
    expect(isSizeOwner('s1', b)).toBe(true);
    expect(isSizeOwner('s1', a)).toBe(false);
  });

  it('hands ownership to the most recently focused terminal when the owner leaves', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    const c = Symbol('c');
    const onOwnB = vi.fn();
    const onOwnC = vi.fn();
    registerSizeOwner('s1', a, vi.fn());
    registerSizeOwner('s1', b, onOwnB);
    const leaveC = registerSizeOwner('s1', c, onOwnC);
    claimSizeOwner('s1', c);
    claimSizeOwner('s1', b);
    // Order is now b, c, a.
    const leaveA = registerSizeOwner('s1', Symbol('d'), vi.fn());
    leaveA();
    expect(onOwnB).not.toHaveBeenCalled();
    claimSizeOwner('s1', c);
    // c owns; b was focused before it.
    leaveC();
    expect(onOwnB).toHaveBeenCalledTimes(1);
    expect(isSizeOwner('s1', b)).toBe(true);
  });

  it('does not notify anyone when a non-owner leaves', () => {
    const onOwnA = vi.fn();
    const a = Symbol('a');
    registerSizeOwner('s1', a, onOwnA);
    const leaveB = registerSizeOwner('s1', Symbol('b'), vi.fn());
    leaveB();
    expect(onOwnA).not.toHaveBeenCalled();
    expect(isSizeOwner('s1', a)).toBe(true);
  });

  it('treats unregistered terminals as owners', () => {
    expect(isSizeOwner('nobody', Symbol('x'))).toBe(true);
  });
});
