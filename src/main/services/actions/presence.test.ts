import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionPresence, type PresenceSignal } from './presence';

const MIN = 60_000;

function setup(lastUse?: number) {
  const powerMonitor = new EventEmitter();
  let focused = true;
  let inputAt = Date.now();
  let idleAvailable = true;
  const idleSeconds = vi.fn(() => idleAvailable ? Math.floor((Date.now() - inputAt) / 1000) : null);
  const used = vi.fn();
  const returned = vi.fn();
  const tracker = new ActionPresence({
    clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    lastUse: () => lastUse,
    used,
    returned,
    signals: {
      focused: () => focused,
      idleSeconds,
      listen: (listener) => {
        powerMonitor.on('signal', listener);
        return () => { powerMonitor.removeListener('signal', listener); };
      },
    },
  });
  const signal = (s: PresenceSignal, input = false) => {
    if (s === 'focus') focused = true;
    if (s === 'blur') focused = false;
    if (input) inputAt = Date.now();
    powerMonitor.emit('signal', s);
  };
  return { tracker, powerMonitor, used, returned, idleSeconds, signal, input: () => { inputAt = Date.now(); }, noIdle: () => { idleAvailable = false; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 9, 8));
});
afterEach(() => { vi.useRealTimers(); });

describe('Action presence', () => {
  it('has no listeners or polling without enabled return watches, and stops when the last goes away', () => {
    const h = setup();
    h.tracker.configure([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.powerMonitor.listenerCount('signal')).toBe(0);
    h.tracker.configure([{ id: 'a' }]);
    expect(vi.getTimerCount()).toBe(1);
    expect(h.powerMonitor.listenerCount('signal')).toBe(1);
    h.tracker.configure([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.powerMonitor.listenerCount('signal')).toBe(0);
  });

  it('requires no app focus and idle evidence, and applies each configured threshold', async () => {
    const h = setup();
    h.tracker.configure([{ id: 'short', absenceMinutes: 5 }, { id: 'default' }]);
    h.signal('blur');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i++) { h.input(); await vi.advanceTimersByTimeAsync(MIN); }
    h.signal('focus', true);
    expect(h.returned).not.toHaveBeenCalled();
    h.signal('blur');
    await vi.advanceTimersByTimeAsync(6 * MIN);
    h.signal('focus', true);
    expect(h.returned).toHaveBeenCalledExactlyOnceWith(['short']);
    h.signal('blur');
    await vi.advanceTimersByTimeAsync(30 * MIN);
    h.signal('focus', true);
    expect(h.returned).toHaveBeenLastCalledWith(['short', 'default']);
    expect(h.returned).toHaveBeenCalledTimes(2);
  });

  it('does not count idle time while Clubhouse remains focused or ordinary window switching', async () => {
    const h = setup();
    h.tracker.configure([{ id: 'a', absenceMinutes: 5 }]);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    h.signal('focus', true);
    h.signal('blur');
    h.signal('focus', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.returned).not.toHaveBeenCalled();
  });

  it('does not count active time in another app as part of a later short lock', async () => {
    const h = setup();
    h.tracker.configure([{ id: 'a', absenceMinutes: 5 }]);
    h.signal('blur');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) { h.input(); await vi.advanceTimersByTimeAsync(MIN); }
    h.signal('lock');
    await vi.advanceTimersByTimeAsync(MIN);
    h.signal('unlock', true);
    h.signal('focus', true);
    expect(h.returned).not.toHaveBeenCalled();
  });

  it('deduplicates frontmost lock, suspend, resume, unlock and focus signals', async () => {
    const h = setup();
    h.tracker.configure([{ id: 'a' }]);
    h.signal('lock');
    h.signal('suspend');
    await vi.advanceTimersByTimeAsync(30 * MIN);
    h.signal('resume');
    expect(h.returned).not.toHaveBeenCalled();
    h.signal('unlock', true);
    h.signal('focus', true);
    h.signal('focus', true);
    expect(h.returned).toHaveBeenCalledExactlyOnceWith(['a']);
    expect(h.used).toHaveBeenLastCalledWith(Date.now());
  });

  it('does not treat unattended resume or focus as a return', async () => {
    const h = setup();
    h.tracker.configure([{ id: 'a', absenceMinutes: 5 }]);
    h.signal('suspend');
    await vi.advanceTimersByTimeAsync(6 * MIN);
    h.signal('resume');
    h.signal('focus');
    expect(h.returned).not.toHaveBeenCalled();
    h.signal('focus', true);
    expect(h.returned).toHaveBeenCalledExactlyOnceWith(['a']);
  });

  it('does not infer a return on relaunch from a persisted lastUse', async () => {
    const h = setup(Date.now() - 24 * 60 * MIN);
    h.tracker.configure([{ id: 'a' }]);
    h.signal('focus', true);
    expect(h.returned).not.toHaveBeenCalled();
    h.signal('lock');
    await vi.advanceTimersByTimeAsync(30 * MIN);
    h.signal('unlock', true);
    expect(h.returned).toHaveBeenCalledExactlyOnceWith(['a']);
  });

  it('uses only explicit lock or suspend when OS idle time is unavailable', async () => {
    const h = setup();
    h.noIdle();
    h.tracker.configure([{ id: 'a', absenceMinutes: 5 }]);
    h.signal('blur');
    await vi.advanceTimersByTimeAsync(6 * MIN);
    h.signal('focus', true);
    expect(h.returned).not.toHaveBeenCalled();
    h.signal('lock');
    await vi.advanceTimersByTimeAsync(5 * MIN);
    h.signal('unlock', true);
    expect(h.returned).toHaveBeenCalledExactlyOnceWith(['a']);
  });
});
