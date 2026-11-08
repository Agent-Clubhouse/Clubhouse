import { describe, it, expect, vi, afterEach } from 'vitest';
import { devicesChanged, onDevicesChanged, resetDeviceSignalForTests } from './annex-device-signal';

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
