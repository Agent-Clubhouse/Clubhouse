import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/home/tester'), getVersion: vi.fn(() => '1.0.0') },
}));
const fsp = vi.hoisted(() => ({ appendFile: vi.fn(async () => {}), mkdir: vi.fn(async () => {}) }));
vi.mock('fs/promises', () => fsp);
const logSettings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({ enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info' } as Record<string, unknown>)),
  updateSettings: vi.fn(async (fn: (s: Record<string, unknown>) => Record<string, unknown>) => fn({})),
}));
vi.mock('../services/log-settings', () => logSettings);
const telemetrySettings = vi.hoisted(() => ({
  value: { consentVersion: 0, destinations: [] as Array<{ id: string; enabled: boolean; level: string }> } as Record<string, unknown>,
  experiment: false,
}));
const retention = vi.hoisted(() => ({ pruneLogDir: vi.fn(async () => ({ deleted: [] as string[] })), RETENTION_INTERVAL_MS: 3_600_000 }));
vi.mock('./local-retention', () => retention);
vi.mock('./settings', () => ({
  getTelemetrySettings: vi.fn(() => telemetrySettings.value),
  enabledDestinations: (s: { destinations: Array<{ enabled: boolean }> }) => s.destinations.filter((d) => d.enabled),
  isExperimentEnabled: () => telemetrySettings.experiment,
}));

import * as path from 'path';
import { forceFlushTelemetry, getLocalSink, isTelemetryActive, tel, telemetryLevel } from './facade';
import { diag, getDiagSink, isDiagActive } from './diag';
import { _resetLocalRecordingForTests, isDiagRecordingWanted, isLocalRecordingWanted, migrateLocalLevel, runRetention, syncLocalRecording } from './local-control';
import { LOG_RETENTION_TIERS } from '../../shared/types';
import { TELEMETRY_CONSENT_VERSION } from '../../shared/telemetry/settings-types';

// Migrated already, so the migration doesn't change these tests' level.
const base = { enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info', telemetryLevelMigrated: true };

beforeEach(() => {
  fsp.appendFile.mockClear();
  logSettings.updateSettings.mockClear();
  retention.pruneLogDir.mockClear();
  logSettings.getSettings.mockReturnValue({ ...base });
  telemetrySettings.value = { consentVersion: 0, destinations: [] };
  telemetrySettings.experiment = false;
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

  it('records diag lines while logging is on, even with telemetry recording off (#2299)', async () => {
    expect(isDiagRecordingWanted({ ...base, telemetryRecording: false } as never)).toBe(true);
    expect(isDiagRecordingWanted({ ...base, enabled: false } as never)).toBe(false);
    logSettings.getSettings.mockReturnValue({ ...base, telemetryRecording: false });
    await syncLocalRecording();
    expect(getLocalSink()).toBeNull();
    expect(isDiagActive()).toBe(true);
    tel.event('clubhouse.telemetry.test');
    diag('core:pty', 'error', 'PTY exited');
    await forceFlushTelemetry();
    const data = fsp.appendFile.mock.calls.map((c) => (c as unknown as [string, string])[1]).join('');
    expect(data).toContain('"t":"diag"');
    expect(data).toContain('"signals":false');
    expect(data).not.toContain('"t":"event"');
  });

  it('writes no diag lines while logging is off', async () => {
    logSettings.getSettings.mockReturnValue({ ...base, enabled: false });
    await syncLocalRecording();
    expect(isDiagActive()).toBe(false);
    diag('core:pty', 'error', 'PTY exited');
    await forceFlushTelemetry();
    expect(fsp.appendFile).not.toHaveBeenCalled();
  });

  it('restarts the recorder when telemetry recording is switched, keeping diag on', async () => {
    await syncLocalRecording();
    const first = getDiagSink();
    expect(getLocalSink()).toBe(first);
    logSettings.getSettings.mockReturnValue({ ...base, telemetryRecording: false });
    await syncLocalRecording();
    expect(getLocalSink()).toBeNull();
    expect(getDiagSink()).not.toBeNull();
    expect(getDiagSink()).not.toBe(first);
    logSettings.getSettings.mockReturnValue({ ...base, enabled: false });
    await syncLocalRecording();
    expect(getDiagSink()).toBeNull();
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

  it('records at the configured local level and restarts when it changes', async () => {
    await syncLocalRecording();
    expect(telemetryLevel()).toBe('standard');
    const first = getLocalSink();
    logSettings.getSettings.mockReturnValue({ ...base, telemetryLevel: 'detailed' });
    await syncLocalRecording();
    expect(telemetryLevel()).toBe('detailed');
    expect(getLocalSink()).not.toBe(first);
  });
});

describe('retention while recording (#2298)', () => {
  it('runs retention once when recording starts (#2313)', async () => {
    logSettings.getSettings.mockReturnValue({ ...base, retention: 'high' });
    await syncLocalRecording();
    expect(retention.pruneLogDir).toHaveBeenCalledTimes(1);
    const [dir, tier] = retention.pruneLogDir.mock.calls[0] as unknown as [string, unknown];
    expect(dir).toBe(path.join('/home/tester', '.clubhouse', 'logs'));
    expect(tier).toEqual(LOG_RETENTION_TIERS.high);
    // Already recording: a settings sync that changes nothing doesn't prune again.
    await syncLocalRecording();
    expect(retention.pruneLogDir).toHaveBeenCalledTimes(1);
  });

  it('does not run retention when recording never starts', async () => {
    logSettings.getSettings.mockReturnValue({ ...base, enabled: false });
    await syncLocalRecording();
    expect(retention.pruneLogDir).not.toHaveBeenCalled();
  });

  it('prunes by the logging tier and never touches the chunk being written', async () => {
    logSettings.getSettings.mockReturnValue({ ...base, retention: 'low' });
    await syncLocalRecording();
    tel.event('clubhouse.telemetry.test');
    await forceFlushTelemetry();
    await runRetention();
    const [dir, tier, opts] = retention.pruneLogDir.mock.calls.at(-1) as unknown as [string, unknown, { protect: string[] }];
    expect(dir).toBe(path.join('/home/tester', '.clubhouse', 'logs'));
    expect(tier).toEqual(LOG_RETENTION_TIERS.low);
    expect(opts.protect).toEqual([(fsp.appendFile.mock.calls[0] as unknown as [string])[0]]);
  });

  it('runs hourly while recording and stops with it', async () => {
    vi.useFakeTimers();
    try {
      await syncLocalRecording();
      // Once at start, then once an hour later.
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(retention.pruneLogDir).toHaveBeenCalledTimes(2);
      logSettings.getSettings.mockReturnValue({ ...base, enabled: false });
      await syncLocalRecording();
      await vi.advanceTimersByTimeAsync(3 * 3_600_000);
      expect(retention.pruneLogDir).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('one-time local level migration (#2289)', () => {
  const unmigrated = { enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info' } as never;

  function exportingAt(level: string, opts: { consent?: boolean; experiment?: boolean; enabled?: boolean } = {}) {
    telemetrySettings.experiment = opts.experiment ?? true;
    telemetrySettings.value = {
      consentVersion: opts.consent === false ? 0 : TELEMETRY_CONSENT_VERSION,
      destinations: [{ id: 'otlp', enabled: opts.enabled ?? true, level }],
    };
  }

  /** What the migration persisted, applied to an empty file. */
  async function saved(): Promise<Record<string, unknown>> {
    const fn = logSettings.updateSettings.mock.calls[0][0] as (s: Record<string, unknown>) => Record<string, unknown>;
    return fn({});
  }

  it('gives an install exporting at Detailed local Detailed on first run, and marks it done', async () => {
    exportingAt('detailed');
    expect(migrateLocalLevel(unmigrated)).toMatchObject({ telemetryLevel: 'detailed', telemetryLevelMigrated: true });
    expect(await saved()).toEqual({ telemetryLevel: 'detailed', telemetryLevelMigrated: true });
  });

  it('starts recording at Detailed on that first run', async () => {
    exportingAt('detailed');
    logSettings.getSettings.mockReturnValue({ ...(unmigrated as object) });
    await syncLocalRecording();
    expect(telemetryLevel()).toBe('detailed');
  });

  it('leaves Standard for everyone else, still marking it done', async () => {
    for (const setup of [
      () => exportingAt('standard'),
      () => exportingAt('detailed', { enabled: false }),
      () => exportingAt('detailed', { consent: false }),
      () => exportingAt('detailed', { experiment: false }),
    ]) {
      logSettings.updateSettings.mockClear();
      setup();
      const out = migrateLocalLevel(unmigrated);
      expect(out.telemetryLevel).toBeUndefined();
      expect(await saved()).toEqual({ telemetryLevelMigrated: true });
    }
  });

  it('runs only once: a later choice is never overridden', () => {
    exportingAt('detailed');
    const chosen = { ...(unmigrated as object), telemetryLevel: 'standard', telemetryLevelMigrated: true } as never;
    expect(migrateLocalLevel(chosen)).toBe(chosen);
    expect(logSettings.updateSettings).not.toHaveBeenCalled();
  });
});

