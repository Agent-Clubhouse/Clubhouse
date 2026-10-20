import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/home/tester'), getVersion: vi.fn(() => '1.0.0') },
}));
const fsp = vi.hoisted(() => ({ appendFile: vi.fn(async () => {}), mkdir: vi.fn(async () => {}) }));
vi.mock('fs/promises', () => fsp);
const logSettings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({ enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info' } as Record<string, unknown>)),
}));
vi.mock('../services/log-settings', () => logSettings);
vi.mock('./settings', () => ({ getTelemetrySettings: vi.fn(() => ({})) }));

import * as path from 'path';
import { forceFlushTelemetry, getLocalSink, isTelemetryActive, tel } from './facade';
import { _resetLocalRecordingForTests, isLocalRecordingWanted, syncLocalRecording } from './local-control';

const base = { enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info' };

beforeEach(() => {
  fsp.appendFile.mockClear();
  logSettings.getSettings.mockReturnValue({ ...base });
});

afterEach(async () => {
  await _resetLocalRecordingForTests();
});

describe('local recording control', () => {
  it('is on by default while local logging is on, including files from before the setting', () => {
    expect(isLocalRecordingWanted({ ...base } as never)).toBe(true);
    expect(isLocalRecordingWanted({ ...base, telemetryRecording: true } as never)).toBe(true);
    expect(isLocalRecordingWanted({ ...base, telemetryRecording: false } as never)).toBe(false);
    expect(isLocalRecordingWanted({ ...base, enabled: false } as never)).toBe(false);
  });

  it('records to telemetry-*.jsonl in ~/.clubhouse/logs with no export configured', async () => {
    await syncLocalRecording();
    expect(getLocalSink()).not.toBeNull();
    expect(isTelemetryActive()).toBe(true);
    tel.event('clubhouse.telemetry.test');
    await forceFlushTelemetry();
    const [file, data] = fsp.appendFile.mock.calls[0] as unknown as [string, string];
    expect(path.dirname(file)).toBe(path.join('/home/tester', '.clubhouse', 'logs'));
    expect(path.basename(file)).toMatch(/^telemetry-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}\.jsonl$/);
    expect(data).toContain('"t":"event"');
  });

  it('writes nothing while local logging is off', async () => {
    logSettings.getSettings.mockReturnValue({ ...base, enabled: false });
    await syncLocalRecording();
    expect(getLocalSink()).toBeNull();
    expect(isTelemetryActive()).toBe(false);
    tel.event('clubhouse.telemetry.test');
    tel.flow('clubhouse.agent.spawn', {}, () => 1);
    await forceFlushTelemetry();
    expect(fsp.appendFile).not.toHaveBeenCalled();
  });

  it('writes nothing while telemetry recording is switched off', async () => {
    logSettings.getSettings.mockReturnValue({ ...base, telemetryRecording: false });
    await syncLocalRecording();
    expect(getLocalSink()).toBeNull();
    tel.event('clubhouse.telemetry.test');
    await forceFlushTelemetry();
    expect(fsp.appendFile).not.toHaveBeenCalled();
  });

  it('stops when logging is turned off at runtime, flushing what it had', async () => {
    await syncLocalRecording();
    tel.event('clubhouse.telemetry.test');
    logSettings.getSettings.mockReturnValue({ ...base, enabled: false });
    await syncLocalRecording();
    expect(getLocalSink()).toBeNull();
    const before = fsp.appendFile.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    tel.event('clubhouse.telemetry.test');
    await forceFlushTelemetry();
    expect(fsp.appendFile.mock.calls.length).toBe(before);
  });

  it('starts synchronously so startup signals are not missed', () => {
    void syncLocalRecording();
    expect(getLocalSink()).not.toBeNull();
  });
});
