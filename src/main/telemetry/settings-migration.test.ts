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
  getTelemetrySettings,
  migrateLegacySecrets,
  migrateTelemetrySettings,
  resolveDestination,
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
    expect(out).toMatchObject({
      destination: 'otlp',
      otlpEndpoint: 'https://otlp.example.com:4318',
      otlpHeaderNames: ['x-api-key'],
      otlpConfirmedHost: 'otlp.example.com:4318',
      otlpTemporality: 'cumulative',
      consentVersion: 0,
      level: 'detailed',
    });
    expect(out.legacyDestination).toBeDefined();
    expect(resolveDestination(out, {})).toEqual({
      kind: 'otlp',
      endpoint: 'https://otlp.example.com:4318',
      headers: { 'x-api-key': 'secret' },
    });
  });

  it('normalizes a fresh or broken file', () => {
    expect(migrateTelemetrySettings({ destination: null, level: 'loud' })).toMatchObject({ destination: 'azure', level: 'standard' });
    expect(migrateTelemetrySettings({ destination: 'otlp' })).toMatchObject({ destination: 'otlp' });
  });
});

describe('migrateLegacySecrets', () => {
  it('moves a Phase 1 plaintext connection string into the secret store and wipes it from the file', async () => {
    const file = path.join(userData.dir, 'telemetry-settings.json');
    await fsp.writeFile(file, JSON.stringify({ enabled: true, level: 'standard', sampleRate: 1, destination: { kind: 'azure', connectionString: CS } }));
    resetAllSettingsStoresForTests();

    expect(getTelemetrySettings().destination).toBe('azure');
    expect(await migrateLegacySecrets()).toBe(true);

    expect(await readSecrets()).toEqual({ connectionString: CS });
    const onDisk = await fsp.readFile(file, 'utf8');
    expect(onDisk).not.toContain('InstrumentationKey');
    expect(JSON.parse(onDisk)).toMatchObject({ enabled: true, destination: 'azure' });
    expect(JSON.parse(onDisk).legacyDestination).toBeUndefined();
    expect(resolveDestination(getTelemetrySettings(), await readSecrets())).toEqual({ kind: 'azure', connectionString: CS });
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
    expect(isTelemetryConfigured({ ...getTelemetrySettings(), enabled: true, consentVersion: 0 })).toBe(false);
  });
});
