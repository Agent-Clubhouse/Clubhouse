import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnexDevice } from '../../shared/types';
import { AnnexPresence, DEVICE_RECOVERY_SETTLE_MS, DEVICE_STARTUP_SETTLE_MS } from './annex-presence';
import { devicesChanged, onDevicePresenceChanged, resetDeviceSignalForTests } from './annex-device-signal';

const host = vi.hoisted(() => ({ devices: [] as AnnexDevice[], interfaces: {} as Record<string, Array<{ address: string; internal: boolean }>>, publish: vi.fn() }));
vi.mock('node:os', () => ({ networkInterfaces: () => host.interfaces }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { powerMonitor: new EventEmitter() };
});
vi.mock('./annex-devices', () => ({ listDevices: () => host.devices }));
vi.mock('./app-event-bus', () => ({ publishAppEvent: host.publish }));

import { powerMonitor } from 'electron';
import { startDevicePresence, stopDevicePresence } from './annex-device-presence';

function device(id: string, patch: Partial<AnnexDevice> = {}): AnnexDevice {
  return { fingerprint: id, alias: id, kind: 'desktop', icon: 'computer', color: 'indigo', role: 'member', state: 'connected', pairedAt: '', lastSeen: '', problem: null, ...patch };
}

beforeEach(() => {
  vi.useFakeTimers();
  host.devices = [];
  host.interfaces = { ethernet: [{ address: '192.0.2.1', internal: false }] };
  host.publish.mockClear();
});
afterEach(() => {
  stopDevicePresence();
  resetDeviceSignalForTests();
  (powerMonitor as unknown as EventEmitter).removeAllListeners();
  vi.useRealTimers();
});

describe('Annex presence', () => {
  function tracker(initial = [device('computer')]) {
    host.devices = initial;
    const presence = new AnnexPresence({ devices: () => host.devices, publish: host.publish });
    presence.start();
    return presence;
  }

  it('settles startup into one connect per device, including a phone joining during the window', () => {
    const presence = tracker();
    vi.advanceTimersByTime(DEVICE_STARTUP_SETTLE_MS - 1);
    host.devices.push(device('phone', { kind: 'phone' }));
    presence.changed();
    expect(host.publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    presence.changed();
    expect(host.publish.mock.calls.map(([e]) => e)).toEqual([
      { type: 'device.online', device: { id: 'computer', name: 'computer', kind: 'computer' } },
      { type: 'device.online', device: { id: 'phone', name: 'phone', kind: 'phone' } },
    ]);
    presence.stop();
  });

  it('publishes each real transition once and never exports reachability or pairing data', () => {
    const presence = tracker([device('AA', { address: 'secret:123', typedHost: 'secret', role: 'member' }), device('legacy', { role: 'satellite' })]);
    vi.advanceTimersByTime(DEVICE_STARTUP_SETTLE_MS);
    host.devices[0].state = 'offline';
    presence.changed();
    presence.changed();
    host.devices[0].state = 'connected';
    presence.changed();
    expect(host.publish.mock.calls.map(([e]) => e)).toEqual([
      { type: 'device.online', device: { id: 'aa', name: 'AA', kind: 'computer' } },
      { type: 'device.offline', device: { id: 'aa', name: 'AA', kind: 'computer' } },
      { type: 'device.online', device: { id: 'aa', name: 'AA', kind: 'computer' } },
    ]);
    presence.stop();
  });

  it.each(['suspend', 'lock', 'network'] as const)('keeps its baseline during %s and reconciles only real changes after recovery', (reason) => {
    const presence = tracker([device('same'), device('gone')]);
    vi.advanceTimersByTime(DEVICE_STARTUP_SETTLE_MS);
    host.publish.mockClear();
    presence.setAway(reason, true);
    host.devices = [];
    presence.changed();
    vi.advanceTimersByTime(DEVICE_RECOVERY_SETTLE_MS * 2);
    expect(host.publish).not.toHaveBeenCalled();
    presence.setAway(reason, false);
    host.devices = [device('same'), device('new', { kind: 'phone' })];
    presence.changed();
    vi.advanceTimersByTime(DEVICE_RECOVERY_SETTLE_MS - 1);
    expect(host.publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.publish.mock.calls.map(([e]) => e)).toEqual([
      { type: 'device.online', device: { id: 'new', name: 'new', kind: 'phone' } },
      { type: 'device.offline', device: { id: 'gone', name: 'gone', kind: 'computer' } },
    ]);
    presence.stop();
  });

  it('waits for all away reasons and cancels pending startup or recovery work on quit', () => {
    const presence = tracker();
    presence.setAway('suspend', true);
    presence.setAway('network', true);
    presence.setAway('suspend', false);
    vi.advanceTimersByTime(DEVICE_RECOVERY_SETTLE_MS);
    expect(host.publish).not.toHaveBeenCalled();
    presence.setAway('network', false);
    presence.stop();
    host.devices = [];
    presence.changed();
    vi.advanceTimersByTime(DEVICE_RECOVERY_SETTLE_MS);
    expect(host.publish).not.toHaveBeenCalled();
  });

  it('observes transitions within one debounced device-list burst', () => {
    const presence = tracker();
    const off = onDevicePresenceChanged(() => presence.changed());
    vi.advanceTimersByTime(DEVICE_STARTUP_SETTLE_MS);
    host.devices[0].state = 'offline';
    devicesChanged();
    host.devices[0].state = 'connected';
    devicesChanged();
    expect(host.publish.mock.calls.map(([e]) => e.type)).toEqual(['device.online', 'device.offline', 'device.online']);
    off();
    presence.stop();
  });
});

describe('device presence source wiring', () => {
  it('samples local network loss before a socket close and suppresses shutdown disconnects', () => {
    host.devices = [device('computer')];
    startDevicePresence();
    vi.advanceTimersByTime(DEVICE_STARTUP_SETTLE_MS);
    host.publish.mockClear();
    host.interfaces = {};
    host.devices = [];
    devicesChanged();
    vi.advanceTimersByTime(DEVICE_RECOVERY_SETTLE_MS);
    expect(host.publish).not.toHaveBeenCalled();
    host.interfaces = { ethernet: [{ address: '192.0.2.2', internal: false }] };
    vi.advanceTimersByTime(1_000);
    host.devices = [device('computer')];
    devicesChanged();
    vi.advanceTimersByTime(DEVICE_RECOVERY_SETTLE_MS);
    expect(host.publish).not.toHaveBeenCalled();
    stopDevicePresence();
    host.devices = [];
    devicesChanged();
    vi.advanceTimersByTime(DEVICE_RECOVERY_SETTLE_MS);
    expect(host.publish).not.toHaveBeenCalled();
  });

  it('handles suspend and lock without an artificial disconnect/reconnect burst', () => {
    host.devices = [device('phone', { kind: 'phone' })];
    startDevicePresence();
    vi.advanceTimersByTime(DEVICE_STARTUP_SETTLE_MS);
    host.publish.mockClear();
    powerMonitor.emit('lock-screen');
    powerMonitor.emit('suspend');
    host.devices = [];
    devicesChanged();
    powerMonitor.emit('resume');
    vi.advanceTimersByTime(DEVICE_RECOVERY_SETTLE_MS);
    powerMonitor.emit('unlock-screen');
    host.devices = [device('phone', { kind: 'phone' })];
    devicesChanged();
    vi.advanceTimersByTime(DEVICE_RECOVERY_SETTLE_MS);
    expect(host.publish).not.toHaveBeenCalled();
  });
});
