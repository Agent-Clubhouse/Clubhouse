import { describe, it, expect, vi, afterEach } from 'vitest';
import { devicesChanged, onDevicePresenceChanged, onDevicesChanged, resetDeviceSignalForTests } from './annex-device-signal';

describe('annex device signal', () => {
  afterEach(() => {
    resetDeviceSignalForTests();
    vi.useRealTimers();
  });

  it('tells each listener once per burst of changes', () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    onDevicesChanged(listener);
    devicesChanged();
    devicesChanged();
    devicesChanged();
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(listener).toHaveBeenCalledTimes(1);
    devicesChanged();
    vi.advanceTimersByTime(60);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('keeps topology when a timestamp shares its burst (topology first=%s)', (first) => {
    vi.useFakeTimers();
    const listener = vi.fn(); const presence = vi.fn();
    onDevicesChanged(listener); onDevicePresenceChanged(presence);
    devicesChanged(first ? 'topology' : 'last-seen');
    devicesChanged(first ? 'last-seen' : 'topology');
    expect(presence).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60);
    expect(listener).toHaveBeenLastCalledWith('topology');
    devicesChanged('last-seen');
    vi.advanceTimersByTime(60);
    expect(listener).toHaveBeenLastCalledWith('last-seen');
    expect(presence).toHaveBeenCalledTimes(3);
  });

  it('does not retain topology from before any listener subscribed', () => {
    vi.useFakeTimers();
    devicesChanged();
    const listener = vi.fn(); onDevicesChanged(listener);
    devicesChanged('last-seen');
    vi.advanceTimersByTime(60);
    expect(listener).toHaveBeenCalledExactlyOnceWith('last-seen');
  });

  it('keeps telling the others when one listener throws, and stops after unsubscribing', () => {
    vi.useFakeTimers();
    const good = vi.fn();
    onDevicesChanged(() => { throw new Error('boom'); });
    const off = onDevicesChanged(good);
    devicesChanged();
    vi.advanceTimersByTime(60);
    expect(good).toHaveBeenCalledTimes(1);
    off();
    devicesChanged();
    vi.advanceTimersByTime(60);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
