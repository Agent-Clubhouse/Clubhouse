import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TELEMETRY_SETTINGS } from '../../shared/settings-definitions';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  secrets: {} as { connectionString?: string; otlpHeaders?: Record<string, string> },
  storage: 'available' as 'available' | 'weak' | 'unavailable',
  running: false,
  experiment: true,
  calls: [] as string[],
}));

vi.mock('./settings', async (importActual) => {
  const actual = await importActual<typeof import('./settings')>();
  return {
    ...actual,
    getTelemetrySettings: () => state.settings,
    updateTelemetrySettings: async (fn: (s: Record<string, unknown>) => Record<string, unknown>) => {
      state.settings = fn(state.settings);
      return state.settings;
    },
    isExperimentEnabled: () => state.experiment,
    migrateLegacySecrets: async () => true,
  };
});

vi.mock('./secret-store', () => ({
  readSecrets: async () => state.secrets,
  updateSecrets: async (fn: (s: typeof state.secrets) => typeof state.secrets) => {
    state.secrets = JSON.parse(JSON.stringify(fn(state.secrets)));
    return state.secrets;
  },
  getSecureStorageState: () => state.storage,
}));

vi.mock('./bootstrap', () => ({
  isRunning: () => state.running,
  getLastStartError: () => undefined,
  describeDestinationError: (r: string) => `error:${r}`,
  enableTelemetry: async () => {
    state.calls.push('enable');
    state.running = true;
    return true;
  },
  restartTelemetry: async (o?: { clearOffline?: boolean }) => {
    state.calls.push(`restart:${o?.clearOffline ? 'clear' : 'keep'}`);
    return true;
  },
  disableTelemetry: async () => {
    state.calls.push('disable');
    state.running = false;
  },
  sendTestEvent: async () => ({ ok: false, exports: [{ signal: 'traces', ok: false, at: 1, httpStatus: 404 }] }),
}));

vi.mock('./offline', () => ({
  countOfflineItems: async () => 3,
  getOfflineDir: () => '/tmp/none',
  deleteOfflineData: async () => {},
}));

import * as control from './control';

const CS = 'InstrumentationKey=00000000-0000-4000-8000-00000000abcd;IngestionEndpoint=https://westus2-1.in.applicationinsights.azure.com/';

beforeEach(() => {
  state.settings = { ...TELEMETRY_SETTINGS.defaults };
  state.secrets = {};
  state.storage = 'available';
  state.running = false;
  state.experiment = true;
  state.calls = [];
});

describe('telemetry settings control', () => {
  it('masks the connection string in status: last four of the key plus the host', async () => {
    await control.saveAzureConnectionString(CS);
    const status = await control.getStatus();
    expect(status.azure).toEqual({ configured: true, ikeyLast4: 'abcd', host: 'westus2-1.in.applicationinsights.azure.com' });
    expect(JSON.stringify(status)).not.toContain('00000000-0000-4000-8000-00000000abcd');
    expect(status.offlineItems).toBe(3);
  });

  it('rejects bare instrumentation keys and non-App Insights hosts with plain explanations', async () => {
    const bare = await control.saveAzureConnectionString('00000000-0000-4000-8000-00000000abcd');
    expect(bare).toMatchObject({ ok: false, reason: 'bare_instrumentation_key' });
    expect((bare as { message: string }).message).toMatch(/retired in 2025/);
    const other = await control.saveAzureConnectionString('InstrumentationKey=00000000-0000-4000-8000-00000000abcd;IngestionEndpoint=https://collector.example.com/');
    expect(other).toMatchObject({ ok: false, reason: 'not_azure_ingestion_host' });
    expect(state.secrets).toEqual({});
  });

  it('asks before storing secrets with weak Linux storage, and remembers the answer', async () => {
    state.storage = 'weak';
    expect(await control.saveAzureConnectionString(CS)).toMatchObject({ ok: false, reason: 'needs_confirmation', needs: ['weak_storage'] });
    expect(state.secrets).toEqual({});
    expect(await control.saveAzureConnectionString(CS, { weakStorage: true })).toMatchObject({ ok: true });
    expect(state.settings.weakStorageAccepted).toBe(true);
    expect(state.secrets.connectionString).toBe(CS);
  });

  it('refuses to save secrets when secure storage is unavailable', async () => {
    state.storage = 'unavailable';
    expect(await control.saveAzureConnectionString(CS)).toMatchObject({ ok: false, reason: 'secure_storage_unavailable' });
  });

  it('asks for consent the first time, then starts at the configured level', async () => {
    await control.saveAzureConnectionString(CS);
    expect(await control.setEnabled('azure', true)).toMatchObject({ ok: false, needs: ['consent'] });
    expect(state.calls).toEqual([]);
    expect(await control.setEnabled('azure', true, { consent: true })).toMatchObject({ ok: true });
    expect(state.settings).toMatchObject({ enabled: true, destination: 'azure', consentVersion: 1 });
    expect(state.calls).toEqual(['enable']);
  });

  it('requires confirming the OTLP host on first use and after it changes', async () => {
    state.settings.consentVersion = 1;
    expect(await control.saveOtlpConfig({ endpoint: 'https://otlp.example.com', headers: [{ name: 'x-api-key', value: 'k1234' }] })).toMatchObject({ ok: true });
    expect(await control.setEnabled('otlp', true)).toMatchObject({ ok: false, needs: ['destination'], host: 'otlp.example.com' });
    expect(await control.setEnabled('otlp', true, { host: 'otlp.example.com' })).toMatchObject({ ok: true });

    // Header values come back masked; an omitted value keeps the stored one.
    const status = await control.getStatus();
    expect(status.otlp.headers).toEqual([{ name: 'x-api-key', last4: '1234' }]);
    expect(await control.saveOtlpConfig({ endpoint: 'https://otlp.example.com', headers: [{ name: 'x-api-key' }] })).toMatchObject({ ok: true });
    expect(state.secrets.otlpHeaders).toEqual({ 'x-api-key': 'k1234' });

    // Changing the host of the running export needs a fresh confirmation, and clears the queue.
    expect(await control.saveOtlpConfig({ endpoint: 'https://other.example.net', headers: [] })).toMatchObject({
      ok: false, needs: ['destination'], host: 'other.example.net',
    });
    expect(state.settings.otlpEndpoint).toBe('https://otlp.example.com');
    expect(await control.saveOtlpConfig({ endpoint: 'https://other.example.net', headers: [] }, { host: 'other.example.net' })).toMatchObject({ ok: true });
    expect(state.calls.at(-1)).toBe('restart:clear');
  });

  it('confirms a switch between destinations and clears the offline queue', async () => {
    state.settings = { ...state.settings, consentVersion: 1, enabled: true, destination: 'azure' };
    state.secrets.connectionString = CS;
    state.running = true;
    await control.saveOtlpConfig({ endpoint: 'http://localhost:4318', headers: [] });
    expect(await control.setEnabled('otlp', true)).toMatchObject({ ok: false, needs: ['switch_destination'], host: 'localhost:4318' });
    expect(await control.setEnabled('otlp', true, { host: 'localhost:4318' })).toMatchObject({ ok: true });
    expect(state.settings.destination).toBe('otlp');
    expect(state.calls).toEqual(['restart:clear']);
  });

  it('validates OTLP headers and endpoints', async () => {
    expect(await control.saveOtlpConfig({ endpoint: 'http://otlp.example.com', headers: [] })).toMatchObject({ reason: 'https_required' });
    expect(await control.saveOtlpConfig({ endpoint: 'https://o.example', headers: [{ name: 'Host', value: 'x' }] })).toMatchObject({ reason: 'reserved_header_name' });
    expect(await control.saveOtlpConfig({ endpoint: 'https://o.example', headers: [{ name: 'bad name', value: 'x' }] })).toMatchObject({ reason: 'invalid_header_name' });
    expect(await control.saveOtlpConfig({ endpoint: 'https://o.example', headers: [{ name: 'a' }] })).toMatchObject({ reason: 'missing_header_value' });
    expect(await control.saveOtlpConfig({ endpoint: 'https://o.example', headers: [{ name: 'a', value: '1' }, { name: 'A', value: '2' }] })).toMatchObject({ reason: 'duplicate_header_name' });
  });

  it('is unavailable without the experimental flag', async () => {
    state.experiment = false;
    state.secrets.connectionString = CS;
    expect(await control.setEnabled('azure', true, { consent: true })).toMatchObject({ ok: false, reason: 'not_available' });
  });

  it('restarts a running export when the level, advanced settings or install id change', async () => {
    state.running = true;
    await control.setLevel('errors');
    await control.setAdvanced({ sampleRate: 0.5, otlpTemporality: 'delta' });
    const before = state.settings.installId;
    await control.resetInstallId();
    expect(state.settings).toMatchObject({ level: 'errors', sampleRate: 0.5, otlpTemporality: 'delta' });
    expect(state.settings.installId).not.toBe(before);
    expect(state.settings.hashSalt).toBeDefined();
    expect(state.calls).toEqual(['restart:keep', 'restart:keep', 'restart:clear']);
    expect(await control.setAdvanced({ sampleRate: 2 })).toMatchObject({ ok: false, reason: 'invalid_sample_rate' });
  });

  it('shows a Phase 1 file without recorded consent as off, and asks for consent to turn it on', async () => {
    state.settings = { ...state.settings, enabled: true, destination: 'azure', consentVersion: 0 };
    state.secrets.connectionString = CS;
    expect((await control.getStatus()).enabled).toBe(false);
    expect(await control.setEnabled('azure', true)).toMatchObject({ ok: false, needs: ['consent'] });
    expect(await control.setEnabled('azure', true, { consent: true })).toMatchObject({ ok: true });
    expect(state.calls).toEqual(['enable']);
    expect((await control.getStatus()).enabled).toBe(true);
  });

  it('clearing a destination also removes an unmigrated Phase 1 plaintext secret', async () => {
    state.settings = { ...state.settings, legacyDestination: { kind: 'azure', connectionString: CS } };
    await control.clearOtlpConfig();
    expect(state.settings.legacyDestination).toBeDefined();
    await control.clearAzureConnectionString();
    expect(state.settings.legacyDestination).toBeUndefined();
    expect(JSON.stringify(state.settings)).not.toContain('InstrumentationKey');
  });

  it('turns off and removes local data', async () => {
    state.settings = { ...state.settings, enabled: true, installId: 'x' };
    await control.deleteLocalData();
    expect(state.settings.enabled).toBe(false);
    expect(state.calls).toEqual(['disable']);
  });

  it('explains test-event failures', async () => {
    state.running = true;
    state.settings.destination = 'otlp';
    expect(await control.sendTest()).toMatchObject({ ok: false, httpStatus: 404, message: expect.stringMatching(/base path/) });
    expect(control.describeTestFailure({ signal: 'logs', ok: false, at: 0, httpStatus: 403 }, 'azure')).toMatch(/Local authentication/);
    expect(control.describeTestFailure({ signal: 'logs', ok: false, at: 0, httpStatus: 415 }, 'otlp')).toMatch(/JSON/);
    expect(control.describeTestFailure({ signal: 'logs', ok: false, at: 0, errorCode: 'ENOTFOUND' }, 'otlp')).toMatch(/resolve/);
    state.running = false;
    expect(await control.sendTest()).toMatchObject({ ok: false, message: expect.stringMatching(/Turn telemetry on/) });
  });
});
