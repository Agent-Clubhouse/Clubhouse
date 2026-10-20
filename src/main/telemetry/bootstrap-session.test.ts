/**
 * recordAppSession under the parity rule (#2289): the startup kind comes
 * from the session record, so it is the same with export on or off, and
 * local recording alone never creates telemetry-settings.json (the
 * "flag on but not enabled" E2E).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const telemetrySettings = vi.hoisted(() => ({
  get: vi.fn(() => ({ consentVersion: 0, destinations: [] }) as Record<string, unknown>),
  update: vi.fn(async () => ({})),
}));
vi.mock('./settings', async (importActual) => ({
  ...(await importActual<typeof import('./settings')>()),
  getTelemetrySettings: telemetrySettings.get,
  updateTelemetrySettings: telemetrySettings.update,
}));
const lifecycle = vi.hoisted(() => ({ previousSessionVersion: vi.fn((): string | undefined => undefined), setStartupKind: vi.fn() }));
vi.mock('./lifecycle', () => lifecycle);
vi.mock('./local-control', () => ({ syncLocalRecording: vi.fn(async () => {}), restartLocalRecording: vi.fn(async () => {}) }));

import { app } from 'electron';
import { recordAppSession } from './bootstrap';
import { beginPending, abortPending, setLocalSink, setRuntime } from './facade';
import { passThroughSink } from './__test-utils__/producing-runtime';

beforeEach(() => {
  vi.spyOn(app, 'getVersion').mockReturnValue('2.0.0');
  telemetrySettings.get.mockReturnValue({ consentVersion: 0, destinations: [] });
  telemetrySettings.update.mockClear();
  lifecycle.previousSessionVersion.mockReturnValue(undefined);
  lifecycle.setStartupKind.mockClear();
});

afterEach(() => {
  setRuntime(null);
  abortPending();
  setLocalSink(null);
});

describe('recordAppSession', () => {
  it('never writes telemetry-settings.json with local recording alone', () => {
    setLocalSink(passThroughSink());
    recordAppSession();
    expect(lifecycle.setStartupKind).toHaveBeenCalledWith('cold');
    expect(telemetrySettings.update).not.toHaveBeenCalled();
  });

  it('reports an update from the session record the same way with export off or on', () => {
    lifecycle.previousSessionVersion.mockReturnValue('1.9.0');
    setLocalSink(passThroughSink());
    recordAppSession();
    beginPending();
    recordAppSession();
    expect(lifecycle.setStartupKind.mock.calls).toEqual([['after_update'], ['after_update']]);
  });

  it('does nothing with local recording off', () => {
    beginPending();
    recordAppSession();
    expect(lifecycle.setStartupKind).not.toHaveBeenCalled();
    expect(telemetrySettings.update).not.toHaveBeenCalled();
  });
});
