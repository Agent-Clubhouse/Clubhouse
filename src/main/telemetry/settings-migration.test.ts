import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const userData = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('../../__mocks__/electron')>('../../__mocks__/electron');
  return { ...actual, app: { ...actual.app, getPath: () => userData.dir } };
});

import { resetAllSettingsStoresForTests } from '../services/settings-store';
import {
  findDestination,
  getTelemetrySettings,
  migrateLegacySecrets,
  migrateTelemetrySettings,
  resolveDestination,
  withDestination,
} from './settings';
import { readSecrets } from './secret-store';

const CS = 'InstrumentationKey=00000000-0000-4000-8000-000000000001;IngestionEndpoint=https://westus2-1.in.applicationinsights.azure.com/';

beforeAll(async () => {
  userData.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-telemetry-migrate-'));
});

afterAll(async () => {
  await fsp.rm(userData.dir, { recursive: true, force: true });
});

describe('migrateTelemetrySettings', () => {
  it('converts a Phase 1 OTLP destination, keeping the legacy object until secrets move', () => {
    const out = migrateTelemetrySettings({
      enabled: true,
      level: 'detailed',
      sampleRate: 1,
      destination: { kind: 'otlp', endpoint: 'https://otlp.example.com:4318', headers: { 'x-api-key': 'secret' } },
    });
    expect(out.consentVersion).toBe(0);
    expect(out.destinations).toEqual([
      { id: 'azure', kind: 'azure', enabled: false, level: 'detailed', preset: 'all' },
      {
        id: 'otlp', kind: 'otlp', enabled: true, level: 'detailed', preset: 'all',
        confirmedHost: 'otlp.example.com:4318',
        otlp: { endpoint: 'https://otlp.example.com:4318', headerNames: ['x-api-key'], temporality: 'cumulative' },
      },
      // Framebriar follows Feedback; off until Feedback connects, user activity and errors only.
      { id: 'framebriar', kind: 'framebriar', enabled: false, level: 'detailed', preset: 'user_activity', framebriar: { userOff: false } },
    ]);
    expect(out.legacyDestination).toBeDefined();
    expect(resolveDestination(findDestination(out, 'otlp'), out, {})).toEqual({
      kind: 'otlp',
      endpoint: 'https://otlp.example.com:4318',
      headers: { 'x-api-key': 'secret' },
    });
  });

  it('converts a Phase 2 file with no change in what is sent: same destination on, same level, same OTLP settings', () => {
    const out = migrateTelemetrySettings({
      enabled: true,
      destination: 'otlp',
      level: 'errors',
      sampleRate: 0.5,
      otlpEndpoint: 'http://localhost:4318',
      otlpHeaderNames: ['x-k'],
      otlpTemporality: 'delta',
      otlpConfirmedHost: 'localhost:4318',
      consentVersion: 1,
      installId: 'i',
    });
    expect(out).toMatchObject({ sampleRate: 0.5, consentVersion: 1, installId: 'i' });
    for (const key of ['enabled', 'destination', 'level', 'otlpEndpoint', 'otlpHeaderNames', 'otlpTemporality', 'otlpConfirmedHost']) {
      expect(out).not.toHaveProperty(key);
    }
    expect(out.destinations.filter((d) => d.enabled).map((d) => d.id)).toEqual(['otlp']);
    expect(findDestination(out, 'otlp')).toEqual({
      id: 'otlp', kind: 'otlp', enabled: true, level: 'errors', preset: 'all', confirmedHost: 'localhost:4318',
      otlp: { endpoint: 'http://localhost:4318', headerNames: ['x-k'], temporality: 'delta' },
    });
    // Azure as the active one, and a disabled Phase 2 file.
    expect(migrateTelemetrySettings({ enabled: true, destination: 'azure', level: 'standard' }).destinations.filter((d) => d.enabled).map((d) => d.id)).toEqual(['azure']);
    expect(migrateTelemetrySettings({ enabled: false, destination: 'azure' }).destinations.some((d) => d.enabled)).toBe(false);
  });

  it('migrates a Phase 2 file even with the defaults (and their destinations list) merged over it', async () => {
    const { TELEMETRY_SETTINGS } = await import('../../shared/settings-definitions');
    const out = migrateTelemetrySettings({ ...TELEMETRY_SETTINGS.defaults, enabled: true, destination: 'otlp', level: 'detailed', otlpEndpoint: 'https://o.example' });
    expect(findDestination(out, 'otlp')).toMatchObject({ enabled: true, level: 'detailed', otlp: { endpoint: 'https://o.example' } });
  });

  it('is idempotent on the current shape and repairs broken entries', () => {
    const once = migrateTelemetrySettings({ enabled: true, destination: 'azure', level: 'detailed' });
    expect(migrateTelemetrySettings({ ...once })).toEqual(once);
    const repaired = migrateTelemetrySettings({
      destinations: [{ kind: 'otlp', enabled: true, level: 'loud', preset: 'nope' }, { kind: 'carrier-pigeon', enabled: true }],
    });
    expect(repaired.destinations.map((d) => d.id)).toEqual(['azure', 'otlp', 'framebriar']);
    expect(findDestination(repaired, 'framebriar')).toMatchObject({ enabled: false, preset: 'user_activity', framebriar: { userOff: false } });
    expect(findDestination(repaired, 'otlp')).toMatchObject({ enabled: true, level: 'standard', preset: 'all', otlp: { endpoint: '', headerNames: [], temporality: 'cumulative' } });
    expect(migrateTelemetrySettings({}).destinations.every((d) => !d.enabled)).toBe(true);
  });
});

describe('migrateLegacySecrets', () => {
  it('moves a Phase 1 plaintext connection string into the secret store and wipes it from the file', async () => {
    const file = path.join(userData.dir, 'telemetry-settings.json');
    await fsp.writeFile(file, JSON.stringify({ enabled: true, level: 'standard', sampleRate: 1, destination: { kind: 'azure', connectionString: CS } }));
    resetAllSettingsStoresForTests();

    expect(findDestination(getTelemetrySettings(), 'azure')?.enabled).toBe(true);
    expect(await migrateLegacySecrets()).toBe(true);

    expect(await readSecrets()).toEqual({ connectionString: CS });
    const onDisk = await fsp.readFile(file, 'utf8');
    expect(onDisk).not.toContain('InstrumentationKey');
    expect(JSON.parse(onDisk).destinations[0]).toMatchObject({ id: 'azure', enabled: true });
    expect(JSON.parse(onDisk).legacyDestination).toBeUndefined();
    const settings = getTelemetrySettings();
    expect(resolveDestination(findDestination(settings, 'azure'), settings, await readSecrets())).toEqual({ kind: 'azure', connectionString: CS });
    // Idempotent.
    expect(await migrateLegacySecrets()).toBe(true);
  });
});

describe('migrateLegacySecretsOnReady', () => {
  it('migrates even when telemetry and the experiment are off, and startup stays gated on consent', async () => {
    const { migrateLegacySecretsOnReady, isTelemetryConfigured } = await import('./bootstrap');
    const file = path.join(userData.dir, 'telemetry-settings.json');
    await fsp.rm(path.join(userData.dir, 'telemetry-secret.bin'), { force: true });
    await fsp.writeFile(file, JSON.stringify({ enabled: false, destination: { kind: 'otlp', endpoint: 'https://o.example', headers: { 'x-k': 'v1' } } }));
    resetAllSettingsStoresForTests();

    await migrateLegacySecretsOnReady();
    expect(await readSecrets()).toEqual({ otlpHeaders: { 'x-k': 'v1' } });
    expect(await fsp.readFile(file, 'utf8')).not.toContain('v1');

    // enabled with a destination but no recorded consent: never starts exporting.
    const enabled = withDestination(getTelemetrySettings(), 'otlp', (d) => ({ ...d, enabled: true }));
    expect(isTelemetryConfigured({ ...enabled, consentVersion: 0 })).toBe(false);
  });
});
